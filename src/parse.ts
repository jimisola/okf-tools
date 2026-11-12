import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { markdownLinks, resolveBundleTarget } from "./links.js";

export interface BundleNode {
  /** Node id: frontmatter idField if present, otherwise the filename stem. */
  id: string;
  /** File path relative to the bundle root, POSIX separators. */
  file: string;
  frontmatter: Record<string, unknown>;
  body: string;
  /** Citations received (edges pointing at this node). */
  in: number;
  /** Citations made (edges leaving this node). */
  out: number;
}

/**
 * The bundle-root `index.md` (OKF v0.2 §8). It is not a concept — it never
 * becomes a node — but it is the bundle's own front page, so it is exposed
 * separately for a reader to browse.
 */
export interface BundleIndex {
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface Bundle {
  nodes: BundleNode[];
  /** [sourceId, targetId] pairs, deduplicated, self-links excluded. */
  edges: [string, string][];
  /** Ids of nodes with no edges in either direction. */
  islands: string[];
  /** The bundle-root `index.md`, if the bundle has one. Nested ones are ignored. */
  index?: BundleIndex;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Every `.md` file under `dir`, recursively, in a deterministic
 * (name-sorted, depth-first) order. Absolute paths.
 */
/**
 * OKF v0.2 reserves two filenames throughout the hierarchy: `index.md`
 * (directory listing, §8) and `log.md` (update history, §9). They are not
 * concept documents. `walkMarkdown` still returns them — conformance
 * checking has to inspect them — but `parseBundle` never makes them nodes.
 * The match is case-sensitive: the spec names only the lowercase files, so
 * `INDEX.md` is a concept like any other.
 */
export const RESERVED_FILENAMES: readonly string[] = ["index.md", "log.md"];

export function isReservedFilename(name: string): boolean {
  return RESERVED_FILENAMES.includes(name);
}

export function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) visit(p);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(p);
    }
  };
  visit(dir);
  return out;
}

/**
 * The outcome of looking for a frontmatter block at the top of a file.
 *
 * The three cases are kept apart because conformance checking has to tell
 * "no block at all" from "a block that does not parse" — the viewer itself
 * treats both as "no frontmatter".
 */
export type FrontmatterResult =
  | { kind: "absent"; body: string }
  | { kind: "invalid"; body: string; error: string }
  | { kind: "present"; data: unknown; body: string };

/** Split a markdown file into its frontmatter block (if any) and its body. */
export function readFrontmatter(text: string): FrontmatterResult {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { kind: "absent", body: text };
  const body = text.slice(m[0].length);
  try {
    return { kind: "present", data: parseYaml(m[1] as string), body };
  } catch (err) {
    return { kind: "invalid", body, error: (err as Error).message };
  }
}

/**
 * Decoded `.md` link targets in a markdown body, in document order: relative
 * (`../X/target.md#anchor`) or bundle-absolute (`/X/target.md`, §6.1). See
 * `markdownLinks` for what counts as a link. Resolve them with
 * `resolveBundleTarget`, which does not decode again.
 */
export function markdownLinkTargets(body: string): string[] {
  return markdownLinks(body).map((l) => l.target);
}

function splitFrontmatter(text: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const result = readFrontmatter(text);
  // Malformed YAML: treat as no frontmatter rather than failing the build.
  const data = result.kind === "present" ? result.data : undefined;
  const frontmatter =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  return { frontmatter, body: result.body };
}

/** A frontmatter value naming ids: one string, or a list of them. */
export function idList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
}

/**
 * Walk a bundle directory, parse every markdown file, and extract the
 * citation graph. Edges are the `.md` links between bodies, resolved by
 * `resolveBundleTarget` (so both `../REF/REF.001.md` and `/REF/REF.001.md`
 * work), plus the ids named in any of `relationFields` (typed relations, such
 * as a field naming the documents one replaces); links that resolve outside
 * the bundle and unknown ids are dropped.
 */
export function parseBundle(
  bundleDir: string,
  idField = "id",
  relationFields: readonly string[] = [],
): Bundle {
  const root = path.resolve(bundleDir);
  const files = walkMarkdown(root).filter((f) => !isReservedFilename(path.basename(f)));

  const byFile = new Map<string, BundleNode>(); // resolved abs path -> node
  const nodes: BundleNode[] = [];
  for (const abs of files) {
    const { frontmatter, body } = splitFrontmatter(readFileSync(abs, "utf8"));
    const rawId = frontmatter[idField];
    const id =
      typeof rawId === "string" && rawId.trim() !== ""
        ? rawId.trim()
        : path.basename(abs, ".md");
    const node: BundleNode = {
      id,
      file: path.relative(root, abs).split(path.sep).join("/"),
      frontmatter,
      body,
      in: 0,
      out: 0,
    };
    byFile.set(abs, node);
    nodes.push(node);
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edgeSet = new Set<string>();
  const edges: [string, string][] = [];
  const addEdge = (node: BundleNode, target: BundleNode | undefined) => {
    if (!target || target.id === node.id) return;
    const key = `${node.id}\u001f${target.id}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push([node.id, target.id]);
  };
  for (const abs of files) {
    const node = byFile.get(abs) as BundleNode;
    for (const link of markdownLinkTargets(node.body)) {
      const resolved = resolveBundleTarget(root, abs, link);
      addEdge(node, resolved === undefined ? undefined : byFile.get(resolved));
    }
    for (const field of relationFields) {
      for (const id of idList(node.frontmatter[field])) addEdge(node, byId.get(id));
    }
  }
  edges.sort((a, b) =>
    a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1,
  );

  for (const [s, t] of edges) {
    const src = byId.get(s);
    const tgt = byId.get(t);
    if (src) src.out++;
    if (tgt) tgt.in++;
  }

  const islands = nodes
    .filter((n) => n.in === 0 && n.out === 0)
    .map((n) => n.id);

  const index = readBundleIndex(root);
  return index ? { nodes, edges, islands, index } : { nodes, edges, islands };
}

/**
 * The bundle-root `index.md`, if present. Only this one is exposed: §8 lets
 * nested directories carry their own `index.md`, but only the bundle root's
 * may declare `okf_version`, and only it describes the bundle as a whole.
 */
function readBundleIndex(root: string): BundleIndex | undefined {
  const abs = path.join(root, "index.md");
  if (!existsSync(abs) || !statSync(abs).isFile()) return undefined;
  return splitFrontmatter(readFileSync(abs, "utf8"));
}

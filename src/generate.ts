import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { searchText, type ViewerConfig } from "./config.js";
import { parseBundle, type Bundle } from "./parse.js";

const TEMPLATE_DIR = fileURLToPath(new URL("./template/", import.meta.url));
const require = createRequire(import.meta.url);

/** JSON safe to embed inside a <script> element. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * JS source safe to inline inside a <script> element. Only `</script` can
 * terminate the element early; escaping just that sequence keeps regex
 * literals like `/^</` intact (`<\/script` === `</script` in JS strings).
 */
function embedJs(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

function markedSource(): string {
  const pkgDir = path.dirname(require.resolve("marked/package.json"));
  return readFileSync(path.join(pkgDir, "lib", "marked.umd.js"), "utf8");
}

export interface GenerateResult {
  html: string;
  bundle: Bundle;
}

/**
 * Generate one self-contained HTML page for a parsed bundle: template +
 * CSS + runtime JS + bundle JSON + config JSON + marked, all inlined.
 * The page loads nothing from any network.
 */
export function generateHtml(bundle: Bundle, config: ViewerConfig): string {
  const data = {
    nodes: bundle.nodes.map((n) => ({
      id: n.id,
      file: n.file,
      frontmatter: n.frontmatter,
      body: n.body,
      in: n.in,
      out: n.out,
      search: searchText(n, config),
    })),
    edges: bundle.edges,
    // The bundle-root index.md, rendered as the panel's "Overview". Absent
    // when the bundle has none, and never a node either way.
    ...(bundle.index ? { index: bundle.index } : {}),
  };

  const html = readFileSync(path.join(TEMPLATE_DIR, "viewer.html"), "utf8");
  const css = readFileSync(path.join(TEMPLATE_DIR, "viewer.css"), "utf8");
  const runtime = readFileSync(path.join(TEMPLATE_DIR, "viewer.js"), "utf8");

  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return html
    .split("__TITLE__")
    .join(escapeHtml(config.name))
    .split("/*__CSS__*/")
    .join(css)
    .split("/*__MARKED__*/")
    .join(embedJs(markedSource()))
    .split("__DATA__")
    .join(embedJson(data))
    .split("__CONFIG__")
    .join(embedJson(config))
    .split("/*__RUNTIME__*/")
    .join(embedJs(runtime));
}

export function generate(bundleDir: string, config: ViewerConfig): GenerateResult {
  const bundle = parseBundle(bundleDir, config.idField);
  return { html: generateHtml(bundle, config), bundle };
}

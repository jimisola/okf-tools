import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseBundle, resolveLinkTarget, walkMarkdown } from "../src/parse.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/bundle", import.meta.url));

describe("parseBundle", () => {
  const bundle = parseBundle(FIXTURE);
  const byId = new Map(bundle.nodes.map((n) => [n.id, n]));

  it("finds every markdown file as a node", () => {
    expect(bundle.nodes).toHaveLength(4);
    expect([...byId.keys()].sort()).toEqual([
      "DOC.001",
      "DOC.002",
      "REF.001",
      "island",
    ]);
  });

  it("falls back to the filename stem when the id field is missing", () => {
    expect(byId.get("island")?.frontmatter["title"]).toBe("No id field here");
  });

  it("extracts edges from relative links, including ../dir/file.md style", () => {
    expect(bundle.edges).toEqual([
      ["DOC.001", "DOC.002"],
      ["DOC.001", "REF.001"],
      ["DOC.002", "REF.001"],
    ]);
  });

  it("dedupes repeated links, skips self/external/mailto links and missing targets", () => {
    // DOC.001 links DOC.002 three times (once with an anchor) and itself once
    expect(bundle.edges.filter(([s]) => s === "DOC.001")).toHaveLength(2);
    // island.md links ./missing.md which does not exist
    expect(bundle.edges.some(([s]) => s === "island")).toBe(false);
  });

  it("computes indegree/outdegree", () => {
    expect(byId.get("REF.001")).toMatchObject({ in: 2, out: 0 });
    expect(byId.get("DOC.001")).toMatchObject({ in: 0, out: 2 });
    expect(byId.get("DOC.002")).toMatchObject({ in: 1, out: 1 });
  });

  it("counts islands (no edges in either direction)", () => {
    expect(bundle.islands).toEqual(["island"]);
  });

  it("parses frontmatter values generically", () => {
    const n = byId.get("DOC.001");
    expect(n?.frontmatter["tags"]).toEqual(["rest", "naming"]);
    expect(n?.frontmatter["count"]).toBe(42);
    expect(n?.frontmatter["source"]).toEqual({
      system: "wiki",
      url: "https://example.com/wiki/spaces/ARCH/pages/123456789/A-very-long-page-title-that-should-be-shortened",
      ref: "123",
    });
    expect(n?.body).toContain("# Alpha");
    expect(n?.body).not.toContain("---\nid:");
  });

  it("records bundle-relative POSIX file paths", () => {
    expect(byId.get("DOC.001")?.file).toBe("DOC/DOC.001.md");
  });
});

describe("reserved filenames (OKF v0.2 §3.1)", () => {
  it("walks reserved files but never makes them concepts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "okf-reserved-"));
    try {
      writeFileSync(path.join(dir, "index.md"), '---\nokf_version: "0.2"\n---\n\n* [A](a.md) - x\n');
      writeFileSync(path.join(dir, "log.md"), "## 2026-08-28\n\nEntry.\n");
      writeFileSync(path.join(dir, "a.md"), "---\nid: A\ntype: note\n---\n\nBody.\n");
      expect(parseBundle(dir).nodes.map((n) => n.id)).toEqual(["A"]);
      expect(walkMarkdown(dir).map((f) => path.basename(f)).sort()).toEqual([
        "a.md",
        "index.md",
        "log.md",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bundle-root index.md (OKF v0.2 §8)", () => {
  function withBundle(build: (dir: string) => void) {
    const dir = mkdtempSync(path.join(tmpdir(), "okf-index-"));
    try {
      writeFileSync(path.join(dir, "a.md"), "---\nid: A\ntype: note\n---\n\nBody.\n");
      build(dir);
      return parseBundle(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("exposes the root index separately, and still never as a node", () => {
    const bundle = withBundle((dir) =>
      writeFileSync(
        path.join(dir, "index.md"),
        '---\nokf_version: "0.2"\ntitle: The Bundle\n---\n\n# Welcome\n\n* [A](a.md) - the one concept\n',
      ),
    );
    expect(bundle.index?.frontmatter).toEqual({
      okf_version: "0.2",
      title: "The Bundle",
    });
    expect(bundle.index?.body).toContain("# Welcome");
    expect(bundle.index?.body).not.toContain("okf_version");
    // still not a concept, and its links are not citations
    expect(bundle.nodes.map((n) => n.id)).toEqual(["A"]);
    expect(bundle.edges).toEqual([]);
    expect(bundle.islands).toEqual(["A"]);
  });

  it("leaves index undefined when the bundle has no root index.md", () => {
    expect(withBundle(() => {}).index).toBeUndefined();
    expect(parseBundle(FIXTURE).index).toBeUndefined();
  });

  it("ignores a nested (non-root) index.md", () => {
    const bundle = withBundle((dir) => {
      mkdirSync(path.join(dir, "sub"));
      writeFileSync(path.join(dir, "sub", "index.md"), "# Nested\n\nNot the bundle root.\n");
    });
    expect(bundle.index).toBeUndefined();
  });
});

describe("bundle-absolute links (OKF v0.2 §6.1)", () => {
  it("resolves a leading / against the bundle root, not the filesystem root", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "okf-abs-"));
    try {
      mkdirSync(path.join(dir, "lib", "DOC"), { recursive: true });
      mkdirSync(path.join(dir, "lib", "REF"), { recursive: true });
      writeFileSync(
        path.join(dir, "lib", "DOC", "A.md"),
        "---\nid: A\ntype: note\n---\n\nSee [B](/lib/REF/B.md) and [gone](/lib/REF/gone.md).\n",
      );
      writeFileSync(path.join(dir, "lib", "REF", "B.md"), "---\nid: B\ntype: note\n---\n\nBody.\n");
      const bundle = parseBundle(dir);
      expect(bundle.edges).toEqual([["A", "B"]]);
      expect(bundle.islands).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves relative targets against the linking file, and tolerates bad escapes", () => {
    const root = path.resolve("/bundle");
    const from = path.join(root, "lib", "DOC", "A.md");
    const b = path.join(root, "lib", "REF", "B.md");
    expect(resolveLinkTarget(root, from, "/lib/REF/B.md")).toBe(b);
    expect(resolveLinkTarget(root, from, "../REF/B.md")).toBe(b);
    expect(resolveLinkTarget(root, from, "B%20C.md")).toBe(path.join(root, "lib", "DOC", "B C.md"));
    expect(resolveLinkTarget(root, from, "100%.md")).toBe(path.join(root, "lib", "DOC", "100%.md"));
  });
});

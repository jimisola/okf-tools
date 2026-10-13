import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// Build smoke test: run the real CLI (as `npm run build` does) and check it
// emits one self-contained HTML file.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = path.join(ROOT, "test", "fixtures", "bundle");
const tmp = mkdtempSync(path.join(tmpdir(), "okf-cli-"));

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function run(args: string[]) {
  return spawnSync(
    process.execPath,
    [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "src/cli.ts", ...args],
    { cwd: ROOT, encoding: "utf8" },
  );
}

describe("cli build", () => {
  it("writes a single self-contained HTML file", () => {
    const out = path.join(tmp, "nested", "viewer.html");
    const r = run([FIXTURE, out]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/wrote .*: 4 nodes, 3 edges, 1 islands/);
    expect(statSync(out).size).toBeGreaterThan(10_000);
    const html = readFileSync(out, "utf8");
    expect(html.startsWith("<!doctype html>") || html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).not.toMatch(/<script[^>]*\bsrc\s*=/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).toContain('"DOC.001"');
  });

  it("prints usage and exits 2 without arguments", () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });

  it("exits 1 for a missing bundle directory", () => {
    const r = run([path.join(tmp, "nope"), path.join(tmp, "x.html")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("bundle directory not found");
  });
});

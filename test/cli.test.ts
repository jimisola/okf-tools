import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

  it.each([
    ["a missing file", () => path.join(tmp, "no-such-config.json")],
    [
      "invalid JSON",
      () => {
        const p = path.join(tmp, "bad-config.json");
        writeFileSync(p, "{ not json");
        return p;
      },
    ],
  ])("exits 2 with a one-line error for a --config with %s", (_label, configFile) => {
    const config = configFile();
    const out = path.join(tmp, "bad-config.html");
    const r = run([FIXTURE, out, "--config", config]);
    expect(r.status).toBe(2);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr.startsWith(`error: cannot load config ${config}: `)).toBe(true);
    expect(r.stderr).not.toMatch(/^\s+at /m);
    expect(existsSync(out)).toBe(false);
  });
});

describe("validate cli --orphans", () => {
  function validate(args: string[]) {
    return spawnSync(
      process.execPath,
      [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "src/validate-cli.ts", ...args],
      { cwd: ROOT, encoding: "utf8" },
    );
  }

  it("reports concept.orphan only when asked", () => {
    const off = validate([FIXTURE, "--json"]);
    const on = validate([FIXTURE, "--json", "--orphans"]);
    const orphanCodes = (out: string) =>
      (JSON.parse(out).warnings as { code: string }[]).filter((w) => w.code === "concept.orphan");
    expect(orphanCodes(off.stdout)).toEqual([]);
    expect(orphanCodes(on.stdout).length).toBeGreaterThan(0);
  });

  it("fails --strict on an orphan unless it is allowed", () => {
    // Clean under --strict except for one orphan, so only the check moves the exit code.
    const dir = path.join(tmp, "orphan-bundle");
    mkdirSync(dir, { recursive: true });
    const page = (title: string, body: string) =>
      `---\ntype: note\ntitle: ${title}\ndescription: D\ngenerated: { by: "human:ana", at: "2026-01-01T00:00:00Z" }\n---\n\n${body}\n`;
    writeFileSync(path.join(dir, "index.md"), '---\nokf_version: "0.2"\n---\n\n# Docs\n\n* [A](a.md) - D\n* [B](b.md) - D\n');
    writeFileSync(path.join(dir, "a.md"), page("A", "See [B](b.md)."));
    writeFileSync(path.join(dir, "b.md"), page("B", "Text."));
    expect(validate([dir, "--strict"]).status).toBe(0);
    const on = validate([dir, "--strict", "--orphans"]);
    expect(on.status).toBe(1);
    expect(on.stdout).toContain("a.md [§6 concept.orphan]");
    expect(validate([dir, "--strict", "--orphans", "--allow", "concept.orphan"]).status).toBe(0);
  });

  // a.md links to b.md, so only a.md can be an orphan; b.md names it in `supersedes`.
  function relationBundle(name: string, aFrontmatter: string, supersedes: string) {
    const dir = path.join(tmp, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.md"), "# Docs\n\n* [A](a.md) - D\n* [B](b.md) - D\n");
    writeFileSync(path.join(dir, "a.md"), `---\ntype: note\n${aFrontmatter}---\n\nSee [B](b.md).\n`);
    writeFileSync(path.join(dir, "b.md"), `---\ntype: note\nsupersedes: ${supersedes}\n---\n\nText.\n`);
    return dir;
  }
  const orphanFiles = (r: { stdout: string }) =>
    (JSON.parse(r.stdout).warnings as { code: string; file: string }[])
      .filter((w) => w.code === "concept.orphan")
      .map((w) => w.file);

  it("counts a --relation-field as a link", () => {
    const dir = relationBundle("relation-bundle", "", "a");
    expect(orphanFiles(validate([dir, "--json", "--orphans"]))).toEqual(["a.md"]);
    expect(orphanFiles(validate([dir, "--json", "--orphans", "--relation-field", "supersedes"]))).toEqual([]);
  });

  it("resolves relations by the --id-field", () => {
    const dir = relationBundle("id-field-bundle", "key: ALPHA\n", "ALPHA");
    const args = [dir, "--json", "--orphans", "--relation-field", "supersedes"];
    expect(orphanFiles(validate(args))).toEqual(["a.md"]);
    expect(orphanFiles(validate([...args, "--id-field", "key"]))).toEqual([]);
  });

  function writeConfig(name: string, config: object) {
    const file = path.join(tmp, name);
    writeFileSync(file, JSON.stringify(config));
    return file;
  }

  it("takes relationFields from --config", () => {
    const dir = relationBundle("config-relations-bundle", "", "a");
    const config = writeConfig("relations.config.json", { relationFields: ["supersedes"] });
    expect(orphanFiles(validate([dir, "--json", "--orphans", "--config", config]))).toEqual([]);
  });

  it("takes idField and relationFields from --config", () => {
    const dir = relationBundle("config-id-bundle", "key: ALPHA\n", "ALPHA");
    const config = writeConfig("id.config.json", { idField: "key", relationFields: ["supersedes"] });
    expect(orphanFiles(validate([dir, "--json", "--orphans", "--config", config]))).toEqual([]);
  });

  it("lets --relation-field replace the config's relationFields", () => {
    const dir = relationBundle("config-override-relations", "", "a");
    const config = writeConfig("override.config.json", { relationFields: ["supersedes"] });
    const r = validate([dir, "--json", "--orphans", "--config", config, "--relation-field", "replaces"]);
    expect(orphanFiles(r)).toEqual(["a.md"]);
  });

  it("lets --id-field override the config's idField", () => {
    const dir = relationBundle("config-override-id", "key: ALPHA\n", "ALPHA");
    const config = writeConfig("wrong-id.config.json", { idField: "other", relationFields: ["supersedes"] });
    const args = [dir, "--json", "--orphans", "--config", config];
    expect(orphanFiles(validate(args))).toEqual(["a.md"]);
    expect(orphanFiles(validate([...args, "--id-field", "key"]))).toEqual([]);
  });

  it("accepts --config without --orphans", () => {
    const config = writeConfig("plain.config.json", { relationFields: ["supersedes"] });
    const r = validate([FIXTURE, "--json", "--config", config]);
    expect(r.status).toBe(0);
    expect(orphanFiles(r)).toEqual([]);
  });

  it("rejects --config without a value or with an unreadable file", () => {
    const missing = validate([FIXTURE, "--orphans", "--config"]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/--config needs a config file/);
    const bad = validate([FIXTURE, "--orphans", "--config", path.join(tmp, "nope.json")]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/^error: cannot load config /);
    expect(bad.stderr).not.toMatch(/\bat .*:\d+:\d+/);
    const invalid = path.join(tmp, "invalid.config.json");
    writeFileSync(invalid, "{ not json");
    const parse = validate([FIXTURE, "--orphans", "--config", invalid]);
    expect(parse.status).toBe(2);
    expect(parse.stderr).toMatch(/^error: cannot load config /);
  });

  it("rejects --id-field with no relation field to resolve", () => {
    const r = validate([FIXTURE, "--orphans", "--id-field", "key"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("error: --id-field only applies with --relation-field (or relationFields in --config)");
    const config = writeConfig("relations-only.config.json", { relationFields: ["supersedes"] });
    expect(validate([FIXTURE, "--orphans", "--id-field", "key", "--config", config]).status).toBe(0);
    // An idField from the config alone is never an error.
    const idOnly = writeConfig("id-only.config.json", { idField: "key" });
    expect(validate([FIXTURE, "--orphans", "--config", idOnly]).status).toBe(0);
  });

  it("rejects --relation-field without --orphans", () => {
    const r = validate([FIXTURE, "--relation-field", "supersedes"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/only apply with --orphans/);
  });
});

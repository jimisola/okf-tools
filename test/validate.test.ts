import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  formatReport,
  normalizeVerified,
  validateBundle,
  type Finding,
  type ValidationReport,
} from "../src/validate.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/bundle", import.meta.url));

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Write a throwaway bundle: `{ "REF/REF.001.md": "…" }`. */
function bundle(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "okf-validate-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const codes = (findings: Finding[]) => findings.map((f) => f.code);
const has = (findings: Finding[], code: string) =>
  findings.some((f) => f.code === code);

const CONCEPT = `---
type: note
title: A note
description: Something.
---

Body.
`;

describe("§11.1 — every non-reserved .md has a parseable frontmatter block", () => {
  it("accepts a concept with a frontmatter block", () => {
    const report = validateBundle(bundle({ "a.md": CONCEPT }));
    expect(report.conformant).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("rejects a concept with no frontmatter block", () => {
    const report = validateBundle(bundle({ "a.md": "# Just a heading\n" }));
    expect(report.conformant).toBe(false);
    expect(codes(report.errors)).toEqual(["frontmatter.missing"]);
    expect(report.errors[0]).toMatchObject({ file: "a.md", section: "§11.1" });
  });

  it("rejects a concept whose frontmatter is not parseable YAML", () => {
    const report = validateBundle(
      bundle({ "deep/a.md": "---\ntype: [unclosed\n---\n\nBody.\n" }),
    );
    expect(report.conformant).toBe(false);
    expect(codes(report.errors)).toEqual(["frontmatter.unparseable"]);
    expect(report.errors[0]?.file).toBe("deep/a.md");
  });
});

describe("§11.2 — every frontmatter block has a non-empty type", () => {
  it("accepts a non-empty type", () => {
    expect(validateBundle(bundle({ "a.md": CONCEPT })).errors).toEqual([]);
  });

  it("rejects a missing type", () => {
    const report = validateBundle(bundle({ "a.md": "---\ntitle: X\n---\n" }));
    expect(report.conformant).toBe(false);
    expect(codes(report.errors)).toEqual(["type.missing"]);
  });

  it("rejects an empty type", () => {
    const report = validateBundle(bundle({ "a.md": '---\ntype: ""\n---\n' }));
    expect(report.conformant).toBe(false);
    expect(codes(report.errors)).toEqual(["type.empty"]);
  });

  it("rejects a whitespace-only type", () => {
    const report = validateBundle(bundle({ "a.md": '---\ntype: "   "\n---\n' }));
    expect(report.conformant).toBe(false);
    expect(codes(report.errors)).toEqual(["type.empty"]);
  });
});

describe("§11.3 / §8 — index.md structure", () => {
  it("accepts an index.md with no frontmatter", () => {
    const report = validateBundle(
      bundle({
        "index.md": "# Bundle\n\n* [A](a.md) - the a concept\n",
        "a.md": CONCEPT,
      }),
    );
    expect(report.errors).toEqual([]);
    expect(report.counts).toEqual({ concepts: 1, indexes: 1, logs: 0 });
  });

  it("accepts okf_version in the bundle-root index.md", () => {
    const report = validateBundle(
      bundle({
        "index.md": '---\nokf_version: "0.2"\n---\n\n* [A](a.md) - a\n',
        "a.md": CONCEPT,
      }),
    );
    expect(report.conformant).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("rejects other keys in the bundle-root index.md", () => {
    const report = validateBundle(
      bundle({ "index.md": '---\nokf_version: "0.2"\ntype: index\n---\n' }),
    );
    expect(report.conformant).toBe(false);
    expect(codes(report.errors)).toEqual(["index.frontmatter.extra_keys"]);
    expect(report.errors[0]?.message).toContain("`type`");
  });

  it("rejects frontmatter in a non-root index.md", () => {
    const report = validateBundle(
      bundle({ "sub/index.md": '---\nokf_version: "0.2"\n---\n' }),
    );
    expect(report.conformant).toBe(false);
    expect(codes(report.errors)).toEqual(["index.frontmatter.present"]);
    expect(report.errors[0]?.file).toBe("sub/index.md");
  });

  it("warns, but does not reject, on a malformed entry line", () => {
    const report = validateBundle(
      bundle({ "index.md": "# Bundle\n\n* a plain bullet\n" }),
    );
    expect(report.conformant).toBe(true);
    expect(has(report.warnings, "index.entry.malformed")).toBe(true);
  });

  it("reports line numbers as they appear in the file, not in the body", () => {
    const report = validateBundle(
      bundle({
        "index.md": '---\nokf_version: "0.2"\n---\n\n# Bundle\n\n* a plain bullet\n',
      }),
    );
    expect(report.warnings.find((w) => w.code === "index.entry.malformed")?.line).toBe(
      7,
    );
  });
});

describe("§11.3 / §9 — log.md structure", () => {
  it("accepts ISO 8601 date headings, newest first", () => {
    const report = validateBundle(
      bundle({
        "log.md": "# Update history\n\n## 2026-02-01\n\n- b\n\n## 2026-01-15\n\n- a\n",
      }),
    );
    expect(report.conformant).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.counts.logs).toBe(1);
  });

  it("rejects a non-ISO date heading", () => {
    const report = validateBundle(
      bundle({ "log.md": "# Update history\n\n## 2026/02/01\n\n- b\n" }),
    );
    expect(report.conformant).toBe(false);
    expect(codes(report.errors)).toEqual(["log.date.not_iso"]);
    expect(report.errors[0]).toMatchObject({ file: "log.md", section: "§9" });
    expect(report.errors[0]?.line).toBe(3);
  });

  it("rejects an impossible ISO-shaped date", () => {
    const report = validateBundle(bundle({ "log.md": "## 2026-02-31\n" }));
    expect(codes(report.errors)).toEqual(["log.date.not_iso"]);
  });

  it("warns, but does not reject, when entries are not newest first", () => {
    const report = validateBundle(
      bundle({ "log.md": "## 2026-01-01\n\n- a\n\n## 2026-02-01\n\n- b\n" }),
    );
    expect(report.conformant).toBe(true);
    expect(has(report.warnings, "log.order")).toBe(true);
  });
});

describe("§11 — what a consumer MUST NOT reject a bundle for", () => {
  it("accepts unknown type values, unknown keys and missing optional fields", () => {
    const report = validateBundle(
      bundle({
        "a.md": "---\ntype: wholly-invented-kind\nquux: 7\n---\n\nBody.\n",
      }),
    );
    expect(report.conformant).toBe(true);
    expect(report.errors).toEqual([]);
    expect(has(report.warnings, "field.title.missing")).toBe(true);
    expect(codes(report.warnings)).not.toContain("type.unknown");
  });

  it("accepts broken cross-links", () => {
    const report = validateBundle(
      bundle({ "a.md": `${CONCEPT}\nSee [gone](./missing.md).\n` }),
    );
    expect(report.conformant).toBe(true);
    expect(has(report.warnings, "link.broken")).toBe(true);
  });

  it("accepts a bundle with no index.md", () => {
    const report = validateBundle(bundle({ "a.md": CONCEPT }));
    expect(report.conformant).toBe(true);
    expect(has(report.warnings, "index.missing")).toBe(true);
  });

  it("accepts an unknown status value as a warning only", () => {
    const report = validateBundle(
      bundle({ "a.md": "---\ntype: note\nstatus: retired\n---\n" }),
    );
    expect(report.conformant).toBe(true);
    expect(has(report.warnings, "status.unknown")).toBe(true);
  });
});

describe("§5.2 — a bare verified mapping is a one-element list", () => {
  it("normalizes a bare mapping, a list and an absent value", () => {
    expect(normalizeVerified({ by: "someone", at: "2026-01-01" })).toEqual([
      { by: "someone", at: "2026-01-01" },
    ]);
    expect(normalizeVerified([{ by: "a" }, { by: "b" }])).toHaveLength(2);
    expect(normalizeVerified(undefined)).toEqual([]);
  });

  it("validates a bare mapping exactly like a one-element list", () => {
    const fm = (verified: string) =>
      `---\ntype: note\ntitle: T\ndescription: D\n${verified}---\n`;
    const bare = validateBundle(
      bundle({ "a.md": fm('verified:\n  by: someone\n  at: "2026-01-01"\n') }),
    );
    const list = validateBundle(
      bundle({ "a.md": fm('verified:\n  - by: someone\n    at: "2026-01-01"\n') }),
    );
    expect(bare.conformant).toBe(true);
    expect(codes(bare.warnings)).toEqual(codes(list.warnings));
    expect(codes(bare.warnings)).not.toContain("verified.malformed");
  });

  it("surfaces, rather than drops, an attestation older than the content", () => {
    const report = validateBundle(
      bundle({
        "a.md":
          "---\ntype: note\ntitle: T\ndescription: D\n" +
          'generated:\n  by: pipeline\n  at: "2026-05-01T00:00:00Z"\n' +
          'verified:\n  by: someone\n  at: "2026-01-01T00:00:00Z"\n---\n',
      }),
    );
    expect(report.conformant).toBe(true);
    expect(has(report.warnings, "verified.superseded")).toBe(true);
  });
});

describe("§6 — staleness", () => {
  const now = new Date("2026-06-01T00:00:00Z");

  it("marks a concept whose stale_after has passed", () => {
    const report = validateBundle(
      bundle({ "a.md": '---\ntype: note\nstale_after: "2026-01-01"\n---\n' }),
      { now },
    );
    expect(report.conformant).toBe(true);
    expect(has(report.warnings, "concept.stale")).toBe(true);
  });

  it("leaves a future stale_after alone", () => {
    const report = validateBundle(
      bundle({ "a.md": '---\ntype: note\nstale_after: "2027-01-01"\n---\n' }),
      { now },
    );
    expect(has(report.warnings, "concept.stale")).toBe(false);
  });

  it("warns, but does not reject, an unparseable stale_after", () => {
    const report = validateBundle(
      bundle({ "a.md": "---\ntype: note\nstale_after: sometime soon\n---\n" }),
      { now },
    );
    expect(report.conformant).toBe(true);
    expect(has(report.warnings, "stale_after.unparseable")).toBe(true);
  });
});

describe("report shape", () => {
  let report: ValidationReport;
  const dir = bundle({
    "index.md": '---\nokf_version: "0.2"\n---\n\n* [A](DOC/a.md) - a\n',
    "log.md": "## 2026-01-01\n\n- created\n",
    "DOC/a.md": CONCEPT,
    "DOC/b.md": "no frontmatter here\n",
  });

  it("counts each kind of file and separates errors from warnings", () => {
    report = validateBundle(dir);
    expect(report.bundle).toBe(dir);
    expect(report.counts).toEqual({ concepts: 2, indexes: 1, logs: 1 });
    expect(report.conformant).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.file).toBe("DOC/b.md");
    expect(report.warnings.every((w) => w.section !== "§11.1")).toBe(true);
  });

  it("uses bundle-relative POSIX paths and cites a section everywhere", () => {
    for (const f of [...report.errors, ...report.warnings]) {
      expect(f.file).not.toContain("\\");
      expect(path.isAbsolute(f.file)).toBe(false);
      expect(f.section.startsWith("§")).toBe(true);
      expect(f.code).toBeTruthy();
    }
  });

  it("renders a human-readable summary", () => {
    const text = formatReport(report);
    expect(text).toContain("2 concepts, 1 index files, 1 log files");
    expect(text).toContain("NOT CONFORMANT");
    expect(formatReport(validateBundle(bundle({ "a.md": CONCEPT })))).toContain(
      "CONFORMANT with OKF v0.2",
    );
  });
});

describe("the repository's own fixture bundle", () => {
  it("is conformant", () => {
    const report = validateBundle(FIXTURE);
    expect(report.errors).toEqual([]);
    expect(report.conformant).toBe(true);
    expect(report.counts.concepts).toBe(4);
  });
});

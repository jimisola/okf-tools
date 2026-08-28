import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  markdownLinkTargets,
  readFrontmatter,
  walkMarkdown,
  type FrontmatterResult,
} from "./parse.js";

/** Filenames that are structural, not concept documents (§8, §9). */
export const RESERVED_FILENAMES = ["index.md", "log.md"] as const;

/** Frontmatter `status` values named by the spec; anything else is soft. */
export const KNOWN_STATUS = ["draft", "stable", "deprecated"] as const;

/** The only frontmatter key a bundle-root `index.md` may carry (§8). */
const ROOT_INDEX_KEY = "okf_version";

export interface Finding {
  /** Offending file, bundle-relative, POSIX separators. */
  file: string;
  /** Spec section this cites, e.g. "§11.2". */
  section: string;
  /** Stable machine-readable identifier for the check. */
  code: string;
  message: string;
  /** 1-based line in the file, when the check knows one. */
  line?: number;
}

export interface ValidationReport {
  /** The bundle directory as given to the validator. */
  bundle: string;
  /** True unless a numbered §11 conformance rule was broken. */
  conformant: boolean;
  counts: { concepts: number; indexes: number; logs: number };
  errors: Finding[];
  warnings: Finding[];
}

/** One entry of the `verified` family (§5.2). */
export interface VerifiedEntry {
  by?: unknown;
  at?: unknown;
  [key: string]: unknown;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/**
 * §5.2: consumers MUST treat a bare `verified` mapping as a one-element
 * list. Absent verification is an empty list, never an error.
 */
export function normalizeVerified(value: unknown): VerifiedEntry[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.filter(isMapping);
  if (isMapping(value)) return [value];
  return [];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function calendarDate(text: string): boolean {
  if (!ISO_DATE.test(text)) return false;
  const t = Date.parse(`${text}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === text;
}

/** Parse an ISO 8601 instant; `undefined` when the value is not one. */
function isoInstant(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(+value) ? undefined : value;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!ISO_INSTANT.test(text)) return undefined;
  const ms = Date.parse(ISO_DATE.test(text) ? `${text}T00:00:00Z` : text);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

/**
 * Does a `log.md` heading look like it was meant as a date? Only headings
 * that do are held to the ISO 8601 requirement — prose headings such as
 * "Update history" are left alone.
 */
function looksLikeDate(text: string): boolean {
  const t = text.trim();
  if (/^\d{4}-\d{2}-\d{2}\b/.test(t)) return true;
  if (/\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(t)) return true;
  return /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(
    t,
  );
}

interface Ctx {
  errors: Finding[];
  warnings: Finding[];
  now: Date;
}

function error(ctx: Ctx, f: Finding): void {
  ctx.errors.push(f);
}
function warn(ctx: Ctx, f: Finding): void {
  ctx.warnings.push(f);
}

function countLines(text: string): number {
  return text.split(/\r?\n/).length;
}

/** ATX headings with their 1-based line numbers, fenced code skipped. */
function headings(body: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let fence: string | undefined;
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] as string;
      if (fence === undefined) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const m = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) out.push({ text: m[1] as string, line: i + 1 });
  }
  return out;
}

/** §8 entry line: `* [Title](relative-url) - description`. */
const INDEX_ENTRY = /^\s*[-*+]\s+\[[^\]]*\]\([^)]*\)(?:\s+[-–—]\s+.*)?\s*$/;

function checkConcept(
  ctx: Ctx,
  file: string,
  fm: FrontmatterResult,
): void {
  // §11.1 — a parseable YAML frontmatter block.
  if (fm.kind === "absent") {
    error(ctx, {
      file,
      section: "§11.1",
      code: "frontmatter.missing",
      message: "no YAML frontmatter block",
    });
    return;
  }
  if (fm.kind === "invalid") {
    error(ctx, {
      file,
      section: "§11.1",
      code: "frontmatter.unparseable",
      message: `frontmatter is not parseable YAML: ${fm.error.split("\n")[0]}`,
    });
    return;
  }
  if (!isMapping(fm.data)) {
    error(ctx, {
      file,
      section: "§11.2",
      code: "type.missing",
      message: "frontmatter is not a mapping, so it has no `type` field",
    });
    return;
  }

  const data = fm.data;

  // §11.2 — a non-empty `type`.
  const type = data["type"];
  if (type === undefined || type === null) {
    error(ctx, {
      file,
      section: "§11.2",
      code: "type.missing",
      message: "frontmatter has no `type` field",
    });
  } else if (typeof type !== "string" || type.trim() === "") {
    error(ctx, {
      file,
      section: "§11.2",
      code: "type.empty",
      message: "`type` is present but empty",
    });
  }
  // An unknown `type` value is explicitly not a defect (§11).

  // Everything below is SHOULD-level: warnings only. The spec forbids
  // rejecting a bundle for any of it.
  for (const field of ["title", "description"]) {
    const value = data[field];
    if (typeof value !== "string" || value.trim() === "") {
      warn(ctx, {
        file,
        section: "§4",
        code: `field.${field}.missing`,
        message: `recommended field \`${field}\` is absent or empty`,
      });
    }
  }

  const status = data["status"];
  if (
    status !== undefined &&
    (typeof status !== "string" ||
      !(KNOWN_STATUS as readonly string[]).includes(status))
  ) {
    warn(ctx, {
      file,
      section: "§4",
      code: "status.unknown",
      message: `\`status\` is ${JSON.stringify(status)}; expected one of ${KNOWN_STATUS.join(", ")}`,
    });
  }

  // §6 lifecycle.
  const staleAfter = data["stale_after"];
  if (staleAfter !== undefined) {
    const at = isoInstant(staleAfter);
    if (!at) {
      warn(ctx, {
        file,
        section: "§6",
        code: "stale_after.unparseable",
        message: "`stale_after` is not an ISO 8601 instant",
      });
    } else if (at.getTime() < ctx.now.getTime()) {
      warn(ctx, {
        file,
        section: "§6",
        code: "concept.stale",
        message: `stale: \`stale_after\` (${at.toISOString()}) is in the past`,
      });
    }
  }

  // §7 provenance.
  const generated = data["generated"];
  let generatedAt: Date | undefined;
  if (generated !== undefined) {
    if (!isMapping(generated)) {
      warn(ctx, {
        file,
        section: "§7",
        code: "generated.malformed",
        message: "`generated` is not a mapping of {by, at}",
      });
    } else {
      if (generated["by"] === undefined) {
        warn(ctx, {
          file,
          section: "§7",
          code: "generated.by.missing",
          message: "`generated` has no `by`",
        });
      }
      generatedAt = isoInstant(generated["at"]);
      if (generated["at"] !== undefined && !generatedAt) {
        warn(ctx, {
          file,
          section: "§7",
          code: "generated.at.unparseable",
          message: "`generated.at` is not an ISO 8601 instant",
        });
      }
    }
  }

  // §5.2 / §10.5 attestation. A bare mapping is one element, never a defect.
  const verifiedRaw = data["verified"];
  if (verifiedRaw !== undefined) {
    const entries = normalizeVerified(verifiedRaw);
    if (entries.length === 0) {
      warn(ctx, {
        file,
        section: "§5.2",
        code: "verified.malformed",
        message: "`verified` is neither a mapping nor a list of mappings",
      });
    }
    entries.forEach((entry, i) => {
      const where = `verified[${i}]`;
      if (entry["by"] === undefined) {
        warn(ctx, {
          file,
          section: "§5.2",
          code: "verified.by.missing",
          message: `${where} has no \`by\``,
        });
      }
      const at = isoInstant(entry["at"]);
      if (!at) {
        warn(ctx, {
          file,
          section: "§5.2",
          code: "verified.at.unparseable",
          message: `${where} has no parseable ISO 8601 \`at\``,
        });
      } else if (generatedAt && at.getTime() < generatedAt.getTime()) {
        // §10.5: surface a failing attestation rather than dropping it.
        warn(ctx, {
          file,
          section: "§10.5",
          code: "verified.superseded",
          message: `${where} predates \`generated.at\`; the attestation no longer covers this content`,
        });
      }
    });
  }

  const sources = data["sources"];
  if (sources !== undefined) {
    if (!Array.isArray(sources)) {
      warn(ctx, {
        file,
        section: "§7",
        code: "sources.malformed",
        message: "`sources` is not a list",
      });
    } else {
      sources.forEach((entry, i) => {
        if (!isMapping(entry) || entry["resource"] === undefined) {
          warn(ctx, {
            file,
            section: "§7",
            code: "sources.resource.missing",
            message: `sources[${i}] has no \`resource\``,
          });
        }
      });
    }
  }
}

/** §8 — index files: no frontmatter, except `okf_version` at the root. */
function checkIndex(
  ctx: Ctx,
  file: string,
  isRoot: boolean,
  fm: FrontmatterResult,
  lineOffset: number,
): void {
  if (fm.kind === "invalid") {
    error(ctx, {
      file,
      section: "§8",
      code: "index.frontmatter.unparseable",
      message: "index frontmatter block is not parseable YAML",
    });
  } else if (fm.kind === "present") {
    if (!isRoot) {
      error(ctx, {
        file,
        section: "§8",
        code: "index.frontmatter.present",
        message:
          "an index.md carries no frontmatter; only the bundle-root index.md may, and only `okf_version`",
      });
    } else {
      const keys = isMapping(fm.data) ? Object.keys(fm.data) : [];
      const extra = keys.filter((k) => k !== ROOT_INDEX_KEY);
      if (!isMapping(fm.data) || extra.length > 0) {
        error(ctx, {
          file,
          section: "§8",
          code: "index.frontmatter.extra_keys",
          message: `the bundle-root index.md may carry only \`${ROOT_INDEX_KEY}\`; found ${
            extra.length > 0 ? extra.map((k) => `\`${k}\``).join(", ") : "a non-mapping block"
          }`,
        });
      }
    }
  }

  // Entry shape is soft: a line that is not `* [Title](url) - description`
  // is reported, but never rejects the bundle.
  for (const [i, line] of fm.body.split(/\r?\n/).entries()) {
    if (!/^\s*[-*+]\s+/.test(line)) continue;
    if (INDEX_ENTRY.test(line)) continue;
    warn(ctx, {
      file,
      section: "§8",
      code: "index.entry.malformed",
      message: "list item is not `* [Title](relative-url) - description`",
      line: lineOffset + i + 1,
    });
  }
}

/** §9 — log files: newest first, ISO 8601 `YYYY-MM-DD` date headings. */
function checkLog(
  ctx: Ctx,
  file: string,
  fm: FrontmatterResult,
  lineOffset: number,
): void {
  if (fm.kind !== "absent") {
    warn(ctx, {
      file,
      section: "§9",
      code: "log.frontmatter.present",
      message: "log.md is an update history, not a concept; frontmatter is unexpected",
    });
  }

  const dates: { text: string; line: number }[] = [];
  for (const h of headings(fm.body)) {
    if (!looksLikeDate(h.text)) continue;
    const line = lineOffset + h.line;
    if (calendarDate(h.text.trim())) {
      dates.push({ text: h.text.trim(), line });
      continue;
    }
    error(ctx, {
      file,
      section: "§9",
      code: "log.date.not_iso",
      message: `date heading "${h.text.trim()}" is not ISO 8601 YYYY-MM-DD`,
      line,
    });
  }

  for (let i = 1; i < dates.length; i++) {
    const prev = dates[i - 1] as { text: string; line: number };
    const cur = dates[i] as { text: string; line: number };
    if (cur.text > prev.text) {
      warn(ctx, {
        file,
        section: "§9",
        code: "log.order",
        message: `entries should run newest first: ${cur.text} follows ${prev.text}`,
        line: cur.line,
      });
      break;
    }
  }
}

function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort((a, b) =>
    a.file !== b.file
      ? a.file < b.file
        ? -1
        : 1
      : (a.line ?? 0) - (b.line ?? 0) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
}

export interface ValidateOptions {
  /** Reference instant for staleness; defaults to now. */
  now?: Date;
}

/**
 * Check a bundle against OKF v0.2 §11.
 *
 * Only the three numbered conformance rules produce errors. Every other
 * finding is a warning: §11 forbids rejecting a bundle for missing optional
 * fields, unknown `type` values, unknown extra keys, broken cross-links or
 * missing `index.md` files, so a bundle with warnings alone stays conformant.
 */
export function validateBundle(
  bundleDir: string,
  options: ValidateOptions = {},
): ValidationReport {
  const root = path.resolve(bundleDir);
  const ctx: Ctx = { errors: [], warnings: [], now: options.now ?? new Date() };
  const files = walkMarkdown(root);
  const rel = (abs: string) => path.relative(root, abs).split(path.sep).join("/");
  const known = new Set(files.map((f) => path.resolve(f)));

  let concepts = 0;
  let indexes = 0;
  let logs = 0;

  for (const abs of files) {
    const file = rel(abs);
    const name = path.basename(abs);
    const text = readFileSync(abs, "utf8");
    const fm = readFrontmatter(text);
    // Body line numbers are shifted by however much frontmatter was stripped,
    // so findings can quote the line as it appears in the file.
    const lineOffset = countLines(text) - countLines(fm.body);

    if (name === "index.md") {
      indexes++;
      checkIndex(ctx, file, path.dirname(abs) === root, fm, lineOffset);
    } else if (name === "log.md") {
      logs++;
      checkLog(ctx, file, fm, lineOffset);
    } else {
      concepts++;
      checkConcept(ctx, file, fm);
    }

    // Broken cross-links are soft (§11).
    for (const target of markdownLinkTargets(fm.body)) {
      let resolved: string;
      try {
        resolved = path.resolve(path.dirname(abs), decodeURIComponent(target));
      } catch {
        resolved = path.resolve(path.dirname(abs), target);
      }
      if (known.has(resolved)) continue;
      warn(ctx, {
        file,
        section: "§11",
        code: "link.broken",
        message: `link target does not resolve inside the bundle: ${target}`,
      });
    }
  }

  if (!known.has(path.join(root, "index.md"))) {
    warn(ctx, {
      file: "index.md",
      section: "§8",
      code: "index.missing",
      message: "the bundle root has no index.md",
    });
  }

  return {
    bundle: bundleDir,
    conformant: ctx.errors.length === 0,
    counts: { concepts, indexes, logs },
    errors: sortFindings(ctx.errors),
    warnings: sortFindings(ctx.warnings),
  };
}

/** Render a report the way the CLI prints it without `--json`. */
export function formatReport(report: ValidationReport): string {
  const lines: string[] = [];
  const { concepts, indexes, logs } = report.counts;
  lines.push(`bundle: ${report.bundle}`);
  lines.push(`${concepts} concepts, ${indexes} index files, ${logs} log files`);
  const render = (label: string, findings: Finding[]) => {
    if (findings.length === 0) return;
    lines.push("");
    lines.push(`${label} (${findings.length}):`);
    for (const f of findings) {
      const where = f.line ? `${f.file}:${f.line}` : f.file;
      lines.push(`  ${where} [${f.section} ${f.code}] ${f.message}`);
    }
  };
  render("errors", report.errors);
  render("warnings", report.warnings);
  lines.push("");
  lines.push(
    report.conformant
      ? `CONFORMANT with OKF v0.2 (${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"})`
      : `NOT CONFORMANT with OKF v0.2 (${report.errors.length} error${report.errors.length === 1 ? "" : "s"}, ${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"})`,
  );
  return lines.join("\n");
}

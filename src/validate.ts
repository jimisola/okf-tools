import { readFileSync } from "node:fs";
import * as path from "node:path";
import { resolveBundleTarget } from "./links.js";
import { ATX_HEADING, LIST_ITEM, proseLines, SETEXT_UNDERLINE, THEMATIC_BREAK } from "./markdown.js";
import {
  markdownLinkTargets,
  readFrontmatter,
  walkMarkdown,
  type FrontmatterResult,
} from "./parse.js";

/** Filenames that are structural, not concept documents (§3.1). */
export const RESERVED_FILENAMES = ["index.md", "log.md"] as const;

/** Frontmatter `status` values named by the spec (§5.4); anything else is soft. */
export const KNOWN_STATUS = ["draft", "stable", "deprecated"] as const;

/** The only frontmatter key a bundle-root `index.md` may carry (§8). */
const ROOT_INDEX_KEY = "okf_version";

export interface Finding {
  /** Offending file, bundle-relative, POSIX separators. */
  file: string;
  /** Spec section this cites, e.g. "§5.2"; "§11.2" is §11's second numbered rule. */
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
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/** §7 actor convention: `human:<id>`, `process:<id>` or `<producer>/<version>`. */
const ACTOR = /^(?:human:\S+|process:\S+|[^\s/:]+\/\S+)$/;

const ATTESTED_COMPUTATION = "Attested Computation";

function calendarDate(text: string): boolean {
  if (!ISO_DATE.test(text)) return false;
  const t = Date.parse(`${text}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === text;
}

/**
 * Parse an ISO 8601 date or datetime; `undefined` when the value is neither.
 * `offset` is false for a bare date or an offset-less datetime, which are
 * read as UTC so the result does not depend on the host's time zone.
 */
function isoInstant(value: unknown): { at: Date; offset: boolean } | undefined {
  // The yaml core schema keeps timestamps as strings. A Date comes only from
  // a YAML 1.1 parse, which has already dropped the offset text.
  if (value instanceof Date) {
    return Number.isNaN(+value) ? undefined : { at: value, offset: true };
  }
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  const dt = ISO_DATETIME.exec(text);
  if (!dt && !ISO_DATE.test(text)) return undefined;
  if (!calendarDate(text.slice(0, 10))) return undefined;
  const offset = dt?.[1] !== undefined;
  const iso = !dt ? `${text}T00:00:00Z` : `${text.replace(" ", "T")}${offset ? "" : "Z"}`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : { at: new Date(ms), offset };
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

/**
 * §5: every timestamp-valued key is an ISO 8601 datetime with an explicit UTC
 * offset. Anything else is a warning; the parsed instant is still returned.
 */
function checkInstant(
  ctx: Ctx,
  file: string,
  code: string,
  label: string,
  value: unknown,
): Date | undefined {
  const parsed = isoInstant(value);
  if (!parsed) {
    warn(ctx, {
      file,
      section: "§5",
      code: `${code}.unparseable`,
      message: `\`${label}\` is not an ISO 8601 datetime`,
    });
    return undefined;
  }
  if (!parsed.offset) {
    warn(ctx, {
      file,
      section: "§5",
      code: `${code}.no_offset`,
      message: `\`${label}\` has no explicit UTC offset, e.g. 2026-06-30T14:00:00Z`,
    });
  }
  return parsed.at;
}

function checkActor(ctx: Ctx, file: string, code: string, label: string, value: unknown): void {
  if (typeof value === "string" && ACTOR.test(value.trim())) return;
  warn(ctx, {
    file,
    section: "§7",
    code,
    message: `\`${label}\` is ${JSON.stringify(value)}; expected \`human:<id>\`, \`process:<id>\` or \`<producer>/<version>\``,
  });
}

function checkUsageWindow(ctx: Ctx, file: string, label: string, value: unknown): void {
  if (!isMapping(value)) {
    warn(ctx, {
      file,
      section: "§5.1",
      code: "usage_window.malformed",
      message: `\`${label}\` is not a mapping of {from, to}`,
    });
    return;
  }
  for (const key of ["from", "to"]) {
    if (value[key] !== undefined) {
      checkInstant(ctx, file, "usage_window", `${label}.${key}`, value[key]);
    }
  }
}

function countLines(text: string): number {
  return text.split(/\r?\n/).length;
}

/** A line that cannot be setext heading text: blank, or opening another block. */
const NOT_PARAGRAPH = /^\s*$|^ {0,3}(?:[-*+](?:\s|$)|>|\d{1,9}[.)](?:\s|$)|#{1,6}(?:\s|$)|\|)/;

/**
 * Headings with their 1-based line numbers, fenced code skipped: ATX (`# Title`)
 * and setext (a paragraph line underlined with `===` or `---`).
 */
function headings(body: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  const lines = proseLines(body);
  for (const [i, { text, line }] of lines.entries()) {
    const atx = ATX_HEADING.exec(text);
    const next = lines[i + 1];
    if (atx) out.push({ text: atx[1] ?? "", line });
    else if (next?.line === line + 1 && SETEXT_UNDERLINE.test(next.text) && isParagraph(lines, i)) {
      out.push({ text: text.trim(), line });
    }
  }
  return out;
}


/**
 * Whether the lines up to `end` that form its block — back to a blank line or
 * an ATX heading — are plain paragraph text: no list, quote, table or HTML
 * line (`<`), and at most three spaces of indentation, as CommonMark allows
 * for setext heading text. An indented block is a paragraph only when what
 * precedes it is not a list: there it is the item's own paragraph (a loose
 * list), and a `---` under it is a thematic break.
 */
function isParagraph(lines: { text: string; line: number }[], end: number): boolean {
  for (let i = end; i >= 0; i--) {
    const { text, line } = lines[i] as { text: string; line: number };
    if (NOT_PARAGRAPH.test(text) || /^(?: {4}|\t)/.test(text) || /^ {0,3}</.test(text)) return false;
    const prev = lines[i - 1];
    if (prev === undefined || prev.line !== line - 1 || /^\s*$/.test(prev.text) || ATX_HEADING.test(prev.text)) {
      return !/^\s/.test(text) || !insideList(lines, i);
    }
  }
  return true;
}

/**
 * Whether the block above `start` (past blank lines, back to the next blank
 * line) is list content: any of its lines a list item or indented. A lazily
 * wrapped bullet ends in an unindented line, so its last line alone says nothing.
 */
function insideList(lines: { text: string; line: number }[], start: number): boolean {
  let j = start - 1;
  while (j >= 0 && /^\s*$/.test((lines[j] as { text: string }).text)) j--;
  for (; j >= 0; j--) {
    const { text } = lines[j] as { text: string };
    if (/^\s*$/.test(text)) return false;
    if (LIST_ITEM.test(text) || /^\s/.test(text)) return true;
  }
  return false;
}


/**
 * Whether the line at `start` sits in a list item: a list item opens above it
 * with no heading (ATX or `===` setext), thematic break or blockquote in between, and every blank
 * line crossed has list content above it (a loose list). Indented lines and
 * lazily wrapped text between them belong to that item; indented lines alone
 * are code.
 */
function inListItem(lines: { text: string; line: number }[], start: number): boolean {
  for (let j = start - 1; j >= 0; j--) {
    const { text } = lines[j] as { text: string };
    if (ATX_HEADING.test(text) || THEMATIC_BREAK.test(text) || /^ {0,3}(?:>|=+[ \t]*$)/.test(text)) return false;
    if (LIST_ITEM.test(text)) return true;
    if (/^\s*$/.test(text) && !insideList(lines, j)) return false;
  }
  return false;
}

/** §8 entry line: `* [Title](relative-url) - description`; the title may hold escaped brackets (`\[JWT\]`). */
const INDEX_ENTRY = /^\s*[-*+]\s+\[(?:[^\]\\]|\\.)*\]\([^)]*\)(?:\s+[-–—]\s+.*)?\s*$/;

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
        section: "§4.1",
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
      section: "§5.4",
      code: "status.unknown",
      message: `\`status\` is ${JSON.stringify(status)}; expected one of ${KNOWN_STATUS.join(", ")}`,
    });
  }

  // §5.5: stale when now >= stale_after.
  const staleAfter = data["stale_after"];
  if (staleAfter !== undefined) {
    const at = checkInstant(ctx, file, "stale_after", "stale_after", staleAfter);
    if (at && at.getTime() <= ctx.now.getTime()) {
      warn(ctx, {
        file,
        section: "§5.5",
        code: "concept.stale",
        message: `stale: \`stale_after\` (${at.toISOString()}) has passed`,
      });
    }
  }

  // §5.2 trust.
  const generated = data["generated"];
  let generatedAt: Date | undefined;
  if (generated !== undefined) {
    if (!isMapping(generated)) {
      warn(ctx, {
        file,
        section: "§5.2",
        code: "generated.malformed",
        message: "`generated` is not a mapping of {by, at}",
      });
    } else {
      if (generated["by"] === undefined) {
        warn(ctx, {
          file,
          section: "§5.2",
          code: "generated.by.missing",
          message: "`generated` has no `by`",
        });
      } else {
        checkActor(ctx, file, "generated.by.actor", "generated.by", generated["by"]);
      }
      if (generated["at"] !== undefined) {
        generatedAt = checkInstant(ctx, file, "generated.at", "generated.at", generated["at"]);
      }
    }
  }

  // A bare `verified` mapping is one element, never a defect.
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
    let latest: Date | undefined;
    entries.forEach((entry, i) => {
      const where = `verified[${i}]`;
      if (entry["by"] === undefined) {
        warn(ctx, {
          file,
          section: "§5.2",
          code: "verified.by.missing",
          message: `${where} has no \`by\``,
        });
      } else {
        checkActor(ctx, file, "verified.by.actor", `${where}.by`, entry["by"]);
      }
      const at = checkInstant(ctx, file, "verified.at", `${where}.at`, entry["at"]);
      if (at && (!latest || at.getTime() > latest.getTime())) latest = at;
    });
    // Advisory, not a spec rule: §5.2 keeps `verified` independent of
    // `generated.at`, but content edited since its last check is worth knowing.
    if (latest && generatedAt && latest.getTime() < generatedAt.getTime()) {
      warn(ctx, {
        file,
        section: "§5.2",
        code: "verified.superseded",
        message: "advisory: the content changed after its last verification (latest `verified[].at` predates `generated.at`)",
      });
    }
  }

  // §5.1 provenance.
  const sources = data["sources"];
  if (sources !== undefined) {
    if (!Array.isArray(sources)) {
      warn(ctx, {
        file,
        section: "§5.1",
        code: "sources.malformed",
        message: "`sources` is not a list",
      });
    } else {
      sources.forEach((entry, i) => {
        if (!isMapping(entry) || entry["resource"] === undefined) {
          warn(ctx, {
            file,
            section: "§5.1",
            code: "sources.resource.missing",
            message: `sources[${i}] has no \`resource\``,
          });
        }
        if (!isMapping(entry)) return;
        if (entry["last_modified"] !== undefined) {
          checkInstant(
            ctx,
            file,
            "sources.last_modified",
            `sources[${i}].last_modified`,
            entry["last_modified"],
          );
        }
        if (entry["usage_window"] !== undefined) {
          checkUsageWindow(ctx, file, `sources[${i}].usage_window`, entry["usage_window"]);
        }
      });
    }
  }
  if (data["usage_window"] !== undefined) {
    checkUsageWindow(ctx, file, "usage_window", data["usage_window"]);
  }

  // §10.2: `runtime` is REQUIRED for an Attested Computation.
  if (typeof type === "string" && type.trim() === ATTESTED_COMPUTATION) {
    const runtime = data["runtime"];
    if (typeof runtime !== "string" || runtime.trim() === "") {
      warn(ctx, {
        file,
        section: "§10.2",
        code: "runtime.missing",
        message: `a \`type: ${ATTESTED_COMPUTATION}\` concept has no \`runtime\``,
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

  // An unparseable block is already an error; a version warning on it would only repeat it.
  if (isRoot && fm.kind !== "invalid") checkOkfVersion(ctx, file, fm);

  // Entry shape is soft: a line that is not `* [Title](url) - description`
  // is reported, but never rejects the bundle. A bullet in fenced code (a
  // sample of the entry syntax, say) is neither an entry nor malformed.
  const entryLines: number[] = [];
  const scanned = proseLines(fm.body);
  for (const [i, { text, line }] of scanned.entries()) {
    if (!/^\s*[-*+]\s+/.test(text)) continue;
    // Four or more columns in is indented code, unless it continues a list: a nested item.
    if (!/^ {0,3}[-*+]\s/.test(text) && !inListItem(scanned, i)) continue;
    if (INDEX_ENTRY.test(text)) {
      entryLines.push(line);
      continue;
    }
    warn(ctx, {
      file,
      section: "§8",
      code: "index.entry.malformed",
      message: "list item is not `* [Title](relative-url) - description`",
      line: lineOffset + line,
    });
  }

  // The sections themselves are §8 structure, which §11.3 makes a
  // conformance rule: at least one entry grouped under a heading.
  const firstHeading = headings(fm.body)[0]?.line;
  if (firstHeading === undefined || !entryLines.some((l) => l > firstHeading)) {
    error(ctx, {
      file,
      section: "§11.3",
      code: "index.structure.no_sections",
      message:
        "an index.md groups its entries in sections: a heading followed by `* [Title](relative-url) - description` entries",
    });
  }
}

/** The OKF version this validator checks against (§12). */
export const OKF_VERSION = "0.2";

/**
 * §12 — the bundle-root `okf_version` declaration. Declaring it is optional,
 * but a bundle that once declared it and lost it (an index regenerated by a
 * tool that drops frontmatter) is worth a warning, and so is a version this
 * validator does not check against.
 */
function checkOkfVersion(ctx: Ctx, file: string, fm: FrontmatterResult): void {
  const declared = fm.kind === "present" && isMapping(fm.data) ? fm.data[ROOT_INDEX_KEY] : undefined;
  if (declared === undefined) {
    warn(ctx, {
      file,
      section: "§12",
      code: "okf_version.missing",
      message: `the bundle-root index.md declares no \`${ROOT_INDEX_KEY}\`; add \`${ROOT_INDEX_KEY}: "${OKF_VERSION}"\``,
    });
  } else if (declared !== OKF_VERSION) {
    const unquoted = typeof declared === "number" && String(declared) === OKF_VERSION;
    warn(ctx, {
      file,
      section: "§12",
      code: "okf_version.unsupported",
      message: unquoted
        ? `\`${ROOT_INDEX_KEY}: ${OKF_VERSION}\` is a YAML number; quote it: \`${ROOT_INDEX_KEY}: "${OKF_VERSION}"\``
        : `\`${ROOT_INDEX_KEY}: ${JSON.stringify(declared)}\` is not the quoted string "${OKF_VERSION}" this validator checks against`,
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

    // Broken cross-links are soft: consumers MUST tolerate them (§6.1, §11).
    for (const target of markdownLinkTargets(fm.body)) {
      const resolved = resolveBundleTarget(root, abs, target);
      if (resolved !== undefined && known.has(resolved)) continue;
      warn(ctx, {
        file,
        section: "§6.1",
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

/** The warnings `--strict` fails on: all of them except the `allowed` codes. */
export function blockingWarnings(
  report: ValidationReport,
  allowed: ReadonlySet<string> = new Set(),
): Finding[] {
  return report.warnings.filter((w) => !allowed.has(w.code));
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

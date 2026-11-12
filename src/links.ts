/**
 * Markdown links between concepts, found the way CommonMark finds them: inline
 * links (titled or not), and reference-style links whose label is used. Links
 * inside fenced or indented code blocks and inside code spans are not links.
 *
 * Every tool reading a bundle has to see the same links, or the citation graph
 * differs between them. The cases in test/links.test.ts pin the behaviour; a
 * consumer that parses links itself should pass the same cases.
 */
import * as path from "node:path";
import { ATX_HEADING, blank, maskCode, SETEXT_UNDERLINE, THEMATIC_BREAK } from "./markdown.js";

const INLINE_LINK = /\]\(\s*<?([^()\s<>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/g;
const REFERENCE_DEF =
  /^ {0,3}\[(?!\^)((?:[^[\]\\]|\\.)+)\]:[ \t]*(?:\r?\n[ \t]*)?<?([^\s<>]+)>?(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*(?=\r?\n|$)/gm;
/** One line that is itself a definition (title optional): consecutive definitions each start a block. */
const REFERENCE_DEF_LINE = /^ {0,3}\[(?!\^)(?:[^[\]\\]|\\.)+\]:[ \t]*<?[^\s<>]+>?(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*\r?$/;
const REFERENCE_USE = /(?<!\\)\[((?:[^[\]\\]|\\.)+)\](?:\[((?:[^[\]\\]|\\.)*)\])?/g;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;


const normalizeLabel = (label: string): string => label.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Whether the line at `offset` starts a block, as a link definition must: it opens the
 * text, or follows a line that ends one — blank (code is already blanked), an ATX heading,
 * a thematic break or setext underline, or a definition, one-line or two-line. A
 * definition-like line right under paragraph text is part of that paragraph.
 */
function startsBlock(text: string, offset: number): boolean {
  if (offset === 0) return true;
  const lines = text.slice(0, offset - 1).split("\n");
  const previous = lines[lines.length - 1] ?? "";
  const twoBack = lines[lines.length - 2] ?? "";
  return (
    /^\s*$/.test(previous) ||
    ATX_HEADING.test(previous.replace(/\r$/, "")) ||
    THEMATIC_BREAK.test(previous.replace(/\r$/, "")) ||
    SETEXT_UNDERLINE.test(previous) ||
    REFERENCE_DEF_LINE.test(previous) ||
    (DEFINITION_LABEL_LINE.test(twoBack) && DEFINITION_DESTINATION_LINE.test(previous))
  );
}

/** The two lines of a definition split after its label: `[label]:` then the destination. */
const DEFINITION_LABEL_LINE = /^ {0,3}\[(?!\^)(?:[^[\]\\]|\\.)+\]:[ \t]*\r?$/;
const DEFINITION_DESTINATION_LINE = /^[ \t]*<?[^\s<>]+>?(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*\r?$/;

function bundleMarkdownTarget(raw: string): string | undefined {
  if (HAS_SCHEME.test(raw) || raw.startsWith("#") || raw.startsWith("//")) return undefined;
  const written = raw.replace(/[#?].*$/, "");
  let target = written;
  try {
    target = decodeURIComponent(written);
  } catch {
    // Malformed percent-encoding (`100%.md`): keep the target as written.
  }
  return target.toLowerCase().endsWith(".md") ? target : undefined;
}

/**
 * Each definition-shaped match in `masked` (`body` with code blanked) that starts a
 * block, its label sliced from `body` so code spans in it survive. Blank labels are
 * yielded too: they resolve nothing, but markdownLinks still blanks the line.
 */
function* definitionMatches(
  body: string,
  masked: string,
): Generator<{ index: number; match: string; label: string; destination: string }> {
  for (const m of masked.matchAll(REFERENCE_DEF)) {
    if (!startsBlock(masked, m.index)) continue;
    const start = m.index + m[0].indexOf("[") + 1;
    const label = body.slice(start, start + (m[1] as string).length);
    yield { index: m.index, match: m[0], label, destination: m[2] as string };
  }
}

/** A link reference definition: `[label]: destination "title"`, the destination possibly on the next line. */
export interface LinkDefinition {
  label: string;
  destination: string;
}

/**
 * The link reference definitions markdownLinks reads in `body`, keyed by every
 * 0-based body line each one spans (two for a destination on the next line). A
 * line that only looks like one (in code, a footnote `[^1]: …`, or right under
 * paragraph text) is absent: it is prose.
 *
 * A definition whose label is blank (`[ ]: …`) is absent too: markdownLinks
 * never resolves it. Several definitions of one label are all listed, in body
 * order, but only the first is used, as in markdownLinks; compare labels with
 * referenceLabel.
 *
 * For tools that edit links in place, e.g. one that rewrites plain references
 * into links and must leave definition lines and defined labels alone.
 */
export function linkDefinitions(body: string): Map<number, LinkDefinition> {
  const masked = maskCode(body);
  const out = new Map<number, LinkDefinition>();
  for (const { index, match, label, destination } of definitionMatches(body, masked)) {
    if (normalizeLabel(label) === "") continue;
    const definition = { label, destination };
    const first = masked.slice(0, index).split("\n").length - 1;
    const lines = match.split("\n").length;
    for (let i = first; i < first + lines; i++) out.set(i, definition);
  }
  return out;
}

/**
 * The form two reference labels are compared in: trimmed, inner whitespace
 * collapsed, lowercased. `[Foo  Bar]` uses the definition `[foo bar]: …`.
 */
export const referenceLabel = normalizeLabel;

/** A link to a `.md` file in the bundle: its decoded target, and an offset inside the link (for a line number). */
export interface MarkdownLink {
  target: string;
  index: number;
}

/**
 * `.md` links inside the bundle, relative or bundle-absolute (a leading `/`,
 * §6.1), in document order, anchors and queries stripped and percent-encoding
 * decoded. Code is ignored; a reference definition counts only where its label
 * is used. URLs with a scheme and protocol-relative `//` links are not bundle
 * links.
 */
export function markdownLinks(body: string): MarkdownLink[] {
  const masked = maskCode(body);
  const definitions = new Map<string, string>();
  let text = "";
  let end = 0;
  for (const { index, match, label, destination } of definitionMatches(body, masked)) {
    const key = normalizeLabel(label);
    if (key !== "" && !definitions.has(key)) definitions.set(key, destination);
    text += masked.slice(end, index) + blank(match);
    end = index + match.length;
  }
  text += masked.slice(end);

  const found: { at: number; raw: string }[] = [];
  for (const m of text.matchAll(INLINE_LINK)) found.push({ at: m.index, raw: m[1] as string });
  for (const m of text.matchAll(REFERENCE_USE)) {
    const [whole, first = "", second] = m;
    if (second === undefined && text[m.index + whole.length] === "(") continue;
    const start = second ? m.index + first.length + 3 : m.index + 1;
    const raw = definitions.get(normalizeLabel(body.slice(start, start + (second || first).length)));
    if (raw !== undefined) found.push({ at: m.index, raw });
  }
  return found
    .sort((a, b) => a.at - b.at)
    .flatMap(({ at, raw }) => {
      const target = bundleMarkdownTarget(raw);
      return target === undefined ? [] : [{ target, index: at }];
    });
}

/**
 * The absolute path a decoded link target in `fromFile` points at: a leading
 * `/` resolves against the bundle `root`, anything else against the linking
 * file's directory. `undefined` when the result lies outside `root`.
 */
export function resolveBundleTarget(
  root: string,
  fromFile: string,
  target: string,
): string | undefined {
  const resolved = target.startsWith("/")
    ? path.join(root, target.slice(1))
    : path.resolve(path.dirname(fromFile), target);
  const rel = path.relative(root, resolved);
  return rel === "" || rel.startsWith("..") || path.isAbsolute(rel) ? undefined : resolved;
}

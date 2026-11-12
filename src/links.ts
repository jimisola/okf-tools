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
import {
  ATX_HEADING,
  blank,
  htmlBlockEnd,
  maskBlockCode,
  maskCode,
  paragraphEnds,
  SETEXT_UNDERLINE,
  THEMATIC_BREAK,
} from "./markdown.js";

const INLINE_LINK = /\]\(\s*<?([^()\s<>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/g;
// The parts of a link reference definition, read one after another (CommonMark §4.7).
const DEFINITION_LABEL = / {0,3}\[(?!\^)((?:[^[\]\\]|\\[\s\S]){1,999})\]:/y;
const DEFINITION_SPACE = /[ \t]*(?:(?:\r\n?|\n)[ \t]*)?/y;
const DEFINITION_DESTINATION = /<((?:[^<>\\\r\n]|\\.)*)>|([^\s<]\S*)/y;
const DEFINITION_TITLE = /"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|\((?:[^()\\]|\\[\s\S])*\)/y;
const LINE_REST = /[ \t]*(?=[\r\n]|$)/y;
const LINE = /[^\r\n]*/y;
const REFERENCE_USE = /(?<!\\)\[((?:[^[\]\\]|\\.)+)\](?:\[((?:[^[\]\\]|\\.)*)\])?/g;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const normalizeLabel = (label: string): string => label.trim().replace(/\s+/g, " ").toLowerCase();

/** The end of `re`'s sticky match at `from` in `text`, or -1. */
function endOf(re: RegExp, text: string, from: number): number {
  re.lastIndex = from;
  return re.test(text) ? re.lastIndex : -1;
}

/**
 * The definition starting at line start `at` in `text`, read no further than `limit` (where
 * its paragraph ends): where it ends (a line end), its label's offset and its destination.
 */
function readDefinition(
  text: string,
  at: number,
  limit: number,
): { end: number; labelStart: number; labelLength: number; destination: string } | undefined {
  DEFINITION_LABEL.lastIndex = at;
  const label = DEFINITION_LABEL.exec(text);
  if (label === null || DEFINITION_LABEL.lastIndex > limit) return undefined;
  DEFINITION_DESTINATION.lastIndex = endOf(DEFINITION_SPACE, text, DEFINITION_LABEL.lastIndex);
  const destination = DEFINITION_DESTINATION.exec(text);
  const destinationEnd = DEFINITION_DESTINATION.lastIndex;
  if (destination === null || destinationEnd > limit) return undefined;
  const result = (end: number) => ({
    end,
    labelStart: at + label[0].indexOf("[") + 1,
    labelLength: (label[1] as string).length,
    destination: destination[1] ?? (destination[2] as string),
  });
  // A title, after a space or on the next line, must end its line; else the definition ends before it.
  const titleStart = endOf(DEFINITION_SPACE, text, destinationEnd);
  const titleEnd = titleStart > destinationEnd ? endOf(DEFINITION_TITLE, text, titleStart) : -1;
  const end = titleEnd !== -1 && titleEnd <= limit ? endOf(LINE_REST, text, titleEnd) : -1;
  if (end !== -1) return result(end);
  const destinationLineEnd = endOf(LINE_REST, text, destinationEnd);
  return destinationLineEnd === -1 ? undefined : result(destinationLineEnd);
}

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
 * Each definition in `masked` (`body` with code blanked), its label sliced from `body` so code
 * spans in it survive. A definition opens at the start of the text, right after a definition
 * with a non-blank label, or under a line that ends a block: blank, an ATX heading, a thematic
 * break, a setext underline below paragraph text, or the last line of an HTML block. Under
 * anything else it is paragraph text: a definition cannot interrupt a paragraph. Blank labels
 * are yielded too: they resolve nothing, but markdownLinks still blanks them.
 */
function* definitionMatches(
  body: string,
  masked: string,
): Generator<{ index: number; match: string; label: string; destination: string }> {
  const blocks = maskBlockCode(body);
  const ends = paragraphEnds(blocks);
  let e = 0;
  let open = true; // whether this line may open a definition
  let paragraph = false; // whether the line above is paragraph text
  let html: RegExp | undefined; // the end condition of the HTML block this line is in
  const nextLine = (end: number) => end + (blocks.startsWith("\r\n", end) ? 2 : 1);
  for (let at = 0; at < body.length; ) {
    const lineEnd = endOf(LINE, blocks, at);
    const line = blocks.slice(at, lineEnd);
    if (html !== undefined) {
      if (html.test(line)) html = undefined;
      open = html === undefined;
      paragraph = false;
      at = nextLine(lineEnd);
      continue;
    }
    while (e < ends.length && (ends[e] as number) < at) e++;
    const definition = open ? readDefinition(masked, at, ends[e] ?? body.length) : undefined;
    if (definition !== undefined) {
      const { end, labelStart, labelLength, destination } = definition;
      const label = body.slice(labelStart, labelStart + labelLength);
      // A blank label is no definition: its lines are paragraph text.
      open = normalizeLabel(label) !== "";
      paragraph = !open;
      yield { index: at, match: masked.slice(at, end), label, destination };
      at = nextLine(end);
      continue;
    }
    const empty = /^\s*$/.test(line);
    const htmlEnd: RegExp | undefined = empty ? undefined : htmlBlockEnd(line, paragraph);
    // An HTML block runs until a line meets its end condition, possibly this one.
    if (htmlEnd !== undefined && !htmlEnd.test(line)) html = htmlEnd;
    open =
      empty ||
      (htmlEnd !== undefined && html === undefined) ||
      ATX_HEADING.test(line) ||
      THEMATIC_BREAK.test(line) ||
      (paragraph && SETEXT_UNDERLINE.test(line));
    paragraph = !open && html === undefined;
    at = nextLine(lineEnd);
  }
}

/** A link reference definition: `[label]: destination "title"`, the destination possibly on the next line. */
export interface LinkDefinition {
  label: string;
  destination: string;
}

/**
 * The link reference definitions markdownLinks reads in `body`, keyed by every
 * 0-based body line each one spans (a destination or title may sit on a later line). A
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
  // The 0-based line at `counted`, carried forward so line numbers cost linear time.
  let line = 0;
  let counted = 0;
  for (const { index, match, label, destination } of definitionMatches(body, masked)) {
    if (normalizeLabel(label) === "") continue;
    for (let i = masked.indexOf("\n", counted); i !== -1 && i < index; i = masked.indexOf("\n", i + 1)) line++;
    counted = index;
    const definition = { label, destination };
    const lines = match.split("\n").length;
    for (let i = line; i < line + lines; i++) out.set(i, definition);
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

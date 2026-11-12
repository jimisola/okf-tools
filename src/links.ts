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

const INLINE_LINK = /\]\(\s*<?([^()\s<>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/g;
const REFERENCE_DEF =
  /^ {0,3}\[(?!\^)((?:[^[\]\\]|\\.)+)\]:[ \t]*(?:\r?\n[ \t]*)?<?([^\s<>]+)>?(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*(?=\r?\n|$)/gm;
/** One line that is itself a definition (title optional): consecutive definitions each start a block. */
const REFERENCE_DEF_LINE = /^ {0,3}\[(?!\^)(?:[^[\]\\]|\\.)+\]:[ \t]*<?[^\s<>]+>?(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*\r?$/;
const REFERENCE_USE = /(?<!\\)\[((?:[^[\]\\]|\\.)+)\](?:\[((?:[^[\]\\]|\\.)*)\])?/g;
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)\r?$/;
const FENCE_CLOSE = /^(`{3,}|~{3,})\s*$/;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const blank = (s: string): string => s.replace(/[^\n]/g, " ");
const QUOTE_MARKERS = /^(?: {0,3}> ?)+/;
const QUOTE_MARKER = /^ {0,3}> ?/;

/** How many blockquote markers open the line. */
function quoteDepth(line: string): number {
  return (QUOTE_MARKERS.exec(line)?.[0] ?? "").split(">").length - 1;
}

/** The first `depth` blockquote markers of the line (fewer if it has fewer). */
function quotePrefix(line: string, depth: number): string {
  let prefix = "";
  for (let d = 0; d < depth; d++) {
    const m = QUOTE_MARKER.exec(line.slice(prefix.length));
    if (m === null) break;
    prefix += m[0];
  }
  return prefix;
}

/**
 * Blank fenced code blocks. A fence may be indented up to three columns past the content
 * column of the list item it sits in, so list items are tracked; more than that is an
 * indented code block, which maskIndentedBlocks handles.
 */
function maskFencedBlocks(body: string): string {
  const lines = body.split("\n");
  const items: number[] = [];
  let open: { fence: string; column: number; depth: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    // A fence in a blockquote (`> ~~~`) is read past its `>` markers, and belongs to that
    // quote: inside it only those markers are stripped, and it ends when the quote does.
    const depth = quoteDepth(line);
    if (open !== undefined && depth < open.depth) open = undefined;
    const quote = open === undefined ? (QUOTE_MARKERS.exec(line)?.[0] ?? "") : quotePrefix(line, open.depth);
    const { width, length } = indentation(line.slice(quote.length));
    const rest = line.slice(quote.length + length);
    if (open === undefined) {
      if (rest.trim() === "") continue;
      while (items.length > 0 && width < (items[items.length - 1] as number)) items.pop();
      // A marker four or more columns past the enclosing item's content is indented code.
      const marker = width - (items[items.length - 1] ?? 0) <= 3 ? LIST_MARKER.exec(rest) : null;
      if (marker !== null) {
        const after = rest.slice(marker[0].length);
        const gap = indentation(after, width + marker[0].length).width;
        const column = width + marker[0].length + (after.trim() === "" || gap >= 5 ? 1 : gap);
        items.push(column);
        // The text after the marker may open a fence itself, as in "- ~~~js".
        const m = gap < 5 ? FENCE_OPEN.exec(after.slice(indentation(after).length)) : null;
        if (m === null || ((m[1] as string)[0] === "`" && (m[2] as string).includes("`"))) continue;
        open = { fence: m[1] as string, column, depth };
        // Keep the marker and one placeholder where the fence starts, so maskIndentedBlocks
        // still sees a non-empty item at its real content column.
        const lead = indentation(after).length;
        lines[i] =
          line.slice(0, quote.length + length + marker[0].length) + after.slice(0, lead) + "x" + blank(after.slice(lead + 1));
        continue;
      }
      const column = items[items.length - 1] ?? 0;
      const m = width - column <= 3 ? FENCE_OPEN.exec(rest) : null;
      if (m === null || ((m[1] as string)[0] === "`" && (m[2] as string).includes("`"))) continue;
      open = { fence: m[1] as string, column, depth };
    } else {
      const m = width - open.column <= 3 ? FENCE_CLOSE.exec(rest) : null;
      const run = m?.[1];
      if (run !== undefined && run[0] === open.fence[0] && run.length >= open.fence.length) open = undefined;
    }
    lines[i] = blank(line);
  }
  return lines.join("\n");
}

const LIST_MARKER = /^([-*+]|(\d{1,9})[.)])(?=[ \t]|$)/;
const THEMATIC_BREAK = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ATX_HEADING = /^#{1,6}(?:[ \t]|$)/;

/** Columns of leading whitespace from `column`, tabs to the next multiple of four, and its length. */
function indentation(text: string, column = 0): { width: number; length: number } {
  let width = column;
  let length = 0;
  for (; length < text.length && (text[length] === " " || text[length] === "\t"); length++) {
    width += text[length] === "\t" ? 4 - (width % 4) : 1;
  }
  return { width: width - column, length };
}

/**
 * Blank CommonMark indented code blocks: four columns past the enclosing list item's content
 * column, not continuing a paragraph. Expects fenced blocks already blanked.
 */
function maskIndentedBlocks(body: string): string {
  const lines = body.split("\n");
  const items: number[] = [];
  let paragraph = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const { width, length } = indentation(line);
    const rest = line.slice(length);
    if (rest.trim() === "") {
      paragraph = false;
      continue;
    }
    let depth = 0;
    while (depth < items.length && width >= (items[depth] as number)) depth++;
    if (width - (items[depth - 1] ?? 0) >= 4) {
      if (paragraph) continue;
      items.length = depth;
      lines[i] = blank(line);
      continue;
    }
    if (THEMATIC_BREAK.test(rest) || ATX_HEADING.test(rest)) {
      items.length = depth;
      paragraph = false;
      continue;
    }
    const marker = LIST_MARKER.exec(rest);
    const after = marker === null ? "" : rest.slice(marker[0].length);
    const empty = after.trim() === "";
    const interrupts = paragraph && depth === items.length;
    if (marker !== null && !(interrupts && (empty || (marker[2] ?? "1") !== "1"))) {
      const start = width + marker[0].length;
      const gap = indentation(after, start).width;
      items.length = depth;
      items.push(start + (empty || gap >= 5 ? 1 : gap));
      if (gap >= 5) lines[i] = line.slice(0, length + marker[0].length) + blank(after);
      paragraph = !empty && gap < 5;
      continue;
    }
    if (!paragraph) items.length = depth;
    paragraph = true;
  }
  return lines.join("\n");
}

/**
 * Where a paragraph, and any code span in it, ends: a blank line, or a line opening a list
 * item, heading, table row or quote, or a thematic break or setext underline.
 */
const PARAGRAPH_END =
  /\r?\n(?:[ \t]*\r?\n| {0,3}(?=(?:[-*+]|\d{1,9}[.)])(?:[ \t]|\r?$)|#{1,6}(?:[ \t]|\r?$)|[|>]|(?:=+|-+)[ \t]*\r?$|(?:\*[ \t]*){3,}\r?$|(?:_[ \t]*){3,}\r?$))/m;

function maskCodeSpans(text: string): string {
  // Paragraph ends, found once: a code span never crosses one.
  const ends = [...text.matchAll(new RegExp(PARAGRAPH_END.source, "gm"))].map((e) => e.index);
  let nextEnd = 0;
  const closers = new Map<number, RegExp>();
  const unclosed = new Map<number, number>();
  const runs = /\\[\s\S]|`+/g;
  let out = "";
  let last = 0;
  for (let m = runs.exec(text); m !== null; m = runs.exec(text)) {
    if (m[0][0] === "\\") continue;
    while (nextEnd < ends.length && (ends[nextEnd] as number) < runs.lastIndex) nextEnd++;
    const scope = nextEnd < ends.length ? (ends[nextEnd] as number) : text.length;
    const length = m[0].length;
    let closer = closers.get(length);
    if (!closer) {
      closer = new RegExp(`(?<!\`)\`{${length}}(?!\`)`, "g");
      closers.set(length, closer);
    }
    // Search only up to the paragraph end, and only once per run length and
    // paragraph when nothing closes it: later runs of that length can't close either.
    if (unclosed.get(length) === scope) continue;
    closer.lastIndex = 0;
    const c = closer.exec(text.slice(runs.lastIndex, scope));
    if (c === null) {
      unclosed.set(length, scope);
      continue;
    }
    const end = runs.lastIndex + c.index + length;
    out += text.slice(last, m.index) + blank(text.slice(m.index, end));
    last = end;
    runs.lastIndex = end;
  }
  return out + text.slice(last);
}

/** `body` with fenced and indented code blocks and code spans blanked, offsets and newlines kept. */
function maskCode(body: string): string {
  return maskCodeSpans(maskIndentedBlocks(maskFencedBlocks(body)));
}

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
    /^ {0,3}#{1,6}(?:[ \t]|$)/.test(previous) ||
    THEMATIC_BREAK.test(previous.replace(/^ {0,3}/, "")) ||
    /^ {0,3}(?:=+|-+)[ \t]*\r?$/.test(previous) ||
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
  const definitions = new Map<string, string>();
  const text = maskCode(body).replace(
    REFERENCE_DEF,
    (match: string, label: string, dest: string, offset: number, masked: string) => {
      if (!startsBlock(masked, offset)) return match;
      const start = offset + match.indexOf("[") + 1;
      const key = normalizeLabel(body.slice(start, start + label.length));
      if (key !== "" && !definitions.has(key)) definitions.set(key, dest);
      return blank(match);
    },
  );

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

/**
 * The block-level markdown reading shared by the link parser and the
 * validator, so both see the same code blocks, headings and list items:
 * CommonMark fenced and indented code blocks (in list items and blockquotes
 * too), code spans, HTML block starts, and the line patterns for headings,
 * thematic breaks and list items. Masking keeps offsets and newlines: code
 * becomes spaces.
 */

/** An ATX heading line (`# Title`, up to three spaces in); group 1 is its text. */
export const ATX_HEADING = /^ {0,3}#{1,6}(?!#)(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
/** A setext heading underline (`===` or `---`). */
export const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*\r?$/;
/** A thematic break: three or more `-`, `*` or `_`, spaces allowed between. */
export const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/** A list marker at the start of already-unindented text; group 2 is an ordered item's number. */
export const LIST_MARKER = /^([-*+]|(\d{1,9})[.)])(?=[ \t]|$)/;
/** A list item line, up to three spaces in. */
export const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;

const FENCE_OPEN = /^(`{3,}|~{3,})(.*)\r?$/;
const FENCE_CLOSE = /^(`{3,}|~{3,})\s*$/;
export const blank = (s: string): string => s.replace(/[^\n]/g, " ");
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
  /\r?\n(?:[ \t]*\r?\n| {0,3}(?=(?:[-*+]|\d{1,9}[.)])(?:[ \t]|\r?$)|#{1,6}(?:[ \t]|\r?$)|[|>]|(?:=+|-+)[ \t]*\r?$|(?:\*[ \t]*){3,}\r?$|(?:_[ \t]*){3,}\r?$))/gm;

/** The offsets of the line ends in `text` where a paragraph ends, in order. */
export function paragraphEnds(text: string): number[] {
  return [...text.matchAll(PARAGRAPH_END)].map((e) => e.index);
}

const HTML_BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|" +
  "fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|" +
  "menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const HTML_ATTRIBUTE = `[ \\t]+[A-Za-z_:][\\w.:-]*(?:[ \\t]*=[ \\t]*(?:[^\\s"'=<>\`]+|'[^']*'|"[^"]*"))?`;
const ENDS_AT_BLANK = /^[ \t]*$/;
/** CommonMark HTML block start conditions (types 1-6) and the end condition of each. */
const HTML_BLOCKS: [RegExp, RegExp][] = [
  [/^ {0,3}<(?:pre|script|style|textarea)(?:[ \t>]|$)/i, /<\/(?:pre|script|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
  [new RegExp(`^ {0,3}</?(?:${HTML_BLOCK_TAGS})(?:[ \\t>]|/>|$)`, "i"), ENDS_AT_BLANK],
];
/** Type 7: a lone complete open or closing tag; it cannot interrupt a paragraph. */
const HTML_BLOCK_7 = new RegExp(
  `^ {0,3}(?:<(?!(?:pre|script|style|textarea)(?![A-Za-z0-9-]))[A-Za-z][A-Za-z0-9-]*(?:${HTML_ATTRIBUTE})*[ \\t]*/?>|</[A-Za-z][A-Za-z0-9-]*[ \\t]*>)[ \\t]*$`,
  "i",
);

/**
 * The end condition of the HTML block `line` opens, or undefined if it opens none: the block
 * runs to the first line, from this one on, that matches it (a blank line for types 6 and 7).
 */
export function htmlBlockEnd(line: string, inParagraph: boolean): RegExp | undefined {
  for (const [start, end] of HTML_BLOCKS) if (start.test(line)) return end;
  return !inParagraph && HTML_BLOCK_7.test(line) ? ENDS_AT_BLANK : undefined;
}

function maskCodeSpans(text: string): string {
  // Paragraph ends, found once: a code span never crosses one.
  const ends = paragraphEnds(text);
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
export function maskCode(body: string): string {
  return maskCodeSpans(maskIndentedBlocks(maskFencedBlocks(body)));
}

/** `body` with fenced and indented code blocks blanked (code spans kept), offsets and newlines kept. */
export function maskBlockCode(body: string): string {
  return maskIndentedBlocks(maskFencedBlocks(body));
}

/**
 * The body's lines outside fenced and indented code, with their 1-based line
 * numbers, as written (code spans included).
 */
export function proseLines(body: string): { text: string; line: number }[] {
  const lines = body.split(/\r?\n/);
  const masked = maskBlockCode(lines.join("\n")).split("\n");
  const out: { text: string; line: number }[] = [];
  for (const [i, text] of lines.entries()) {
    if (text.trim() !== "" && (masked[i] ?? "").trim() === "") continue;
    out.push({ text, line: i + 1 });
  }
  return out;
}

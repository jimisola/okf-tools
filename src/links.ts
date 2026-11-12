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

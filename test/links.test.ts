import { describe, expect, it } from "vitest";
import { markdownLinks, resolveBundleTarget } from "../src/links.js";
import { markdownLinkTargets } from "../src/parse.js";

describe("markdownLinkTargets", () => {
  it("keeps relative .md targets and strips anchors and queries", () => {
    const body = [
      "See [a](DOC.003.md), [b](../REF/REF.001.md#principle-3) and [c](./REF.003.md?plain=1).",
      'Also [d](<DOC.004.md> "title") and the [ref] rule.',
      "",
      "[ref]: DOC.001.md",
    ].join("\n");
    expect(markdownLinkTargets(body)).toEqual([
      "DOC.003.md",
      "../REF/REF.001.md",
      "./REF.003.md",
      "DOC.004.md",
      "DOC.001.md",
    ]);
  });

  it("ignores absolute URLs, protocol-relative links, pure anchors and non-markdown targets", () => {
    const body =
      "[x](https://example.test/DOC.005.md) [y](mailto:a@b.test) [z](#section) [u](//host/DOC.005.md) [v](diagram.png)";
    expect(markdownLinkTargets(body)).toEqual([]);
  });

  it("keeps bundle-absolute targets (OKF §6.1)", () => {
    expect(markdownLinkTargets("[w](/DOC/DOC.005.md#x)")).toEqual(["/DOC/DOC.005.md"]);
  });

  it("decodes percent-encoded targets", () => {
    expect(markdownLinkTargets("[x](My%20Doc.md)")).toEqual(["My Doc.md"]);
  });

  it("keeps a target with malformed percent-encoding as written", () => {
    expect(markdownLinkTargets("[x](100%.md) [y](50%-off.md#a)")).toEqual(["100%.md", "50%-off.md"]);
  });
});

describe("markdownLinkTargets block boundaries", () => {
  it("masks a fence indented inside a list item, not only one at 0-3 spaces", () => {
    expect(markdownLinkTargets("- Step one:\n\n    ~~~\n    [a](DOC.003.md)\n    ~~~\n\n[b](DOC.004.md)")).toEqual([
      "DOC.004.md",
    ]);
  });

  it("masks a fence opened on the list marker's own line, and reads the links after it", () => {
    for (const body of [
      "- ```js\n  [a](DOC.003.md)\n  ```\n\n[b](DOC.004.md)",
      "1. ~~~\n   [a](DOC.003.md)\n   ~~~\n\n[b](DOC.004.md)",
    ]) {
      expect(markdownLinkTargets(body), body).toEqual(["DOC.004.md"]);
    }
  });

  it("keeps a wide list item's indented paragraph after its fence as text, not indented code", () => {
    const body = "-   ```js\n    [a](DOC.003.md)\n    ```\n\n    Continued [c](DOC.001.md).";
    expect(markdownLinkTargets(body)).toEqual(["DOC.001.md"]);
  });

  it("does not open a fence from a list-marker line inside indented code", () => {
    expect(markdownLinkTargets("Text.\n\n    - ```md\n    sample\n\n[b](DOC.004.md)")).toEqual(["DOC.004.md"]);
  });

  it("keeps a fence-opening list item after a paragraph a real item, with its later paragraph's links", () => {
    expect(markdownLinkTargets("Intro.\n-   ```js\n    code\n    ```\n\n    More [c](DOC.001.md).")).toEqual(["DOC.001.md"]);
  });

  it("masks a fence inside a blockquote", () => {
    expect(markdownLinkTargets("> ```\n> [a](DOC.003.md)\n> ```\n\n[b](DOC.004.md)")).toEqual(["DOC.004.md"]);
    expect(markdownLinkTargets("> > ~~~\n> > [a](DOC.003.md)\n> > ~~~\n> [b](DOC.004.md)")).toEqual(["DOC.004.md"]);
  });

  it("reads a link whose title is in parentheses", () => {
    expect(markdownLinkTargets("[a](DOC.003.md (title)) [b](DOC.004.md)")).toEqual(["DOC.003.md", "DOC.004.md"]);
  });

  it("does not let a definition interrupt a paragraph, while consecutive definitions all count", () => {
    expect(markdownLinkTargets("Text\n[r]: DOC.003.md\n\n[r]")).toEqual([]);
    expect(markdownLinkTargets("[r] [s]\n\n# Refs\n[r]: DOC.003.md\n[s]: DOC.004.md")).toEqual(["DOC.003.md", "DOC.004.md"]);
  });

  it("does not let a quoted fence line close a fence opened outside the quote", () => {
    expect(markdownLinkTargets("```md\n> ```\n[a](DOC.003.md)\n```\n\n[b](DOC.004.md)")).toEqual(["DOC.004.md"]);
  });

  it("ends a fence opened in a blockquote when the quote ends", () => {
    expect(markdownLinkTargets("> ```\n> [a](DOC.003.md)\n\n[b](DOC.004.md)")).toEqual(["DOC.004.md"]);
  });

  it("reads a definition right after a thematic break, a setext underline or a two-line definition", () => {
    for (const before of ["---", "Title\n=====", "[q]:\n  DOC.003.md"]) {
      expect(markdownLinkTargets(`[r]\n\n${before}\n[r]: DOC.004.md`), before).toContain("DOC.004.md");
    }
  });

  it("reads no definition from indented code (in a blockquote too) or from a list item's paragraph text", () => {
    expect(markdownLinkTargets(">     [r]: DOC.003.md\n\n[r]")).toEqual([]);
    expect(markdownLinkTargets("Text.\n\n    [r]: DOC.003.md\n\n[r]")).toEqual([]);
    expect(markdownLinkTargets("- item\n  [r]: DOC.003.md\n\n[r]")).toEqual([]);
  });

  it("ends a code span's paragraph at a thematic break or setext underline", () => {
    for (const rule of ["---", "***", "Title\n====="]) {
      expect(markdownLinkTargets(`A \` here.\n${rule}\nSee [x](DOC.999.md) \`y\`.`), rule).toEqual(["DOC.999.md"]);
    }
  });

  it("does not end a code span's paragraph at a mixed-marker run or an indented block start", () => {
    for (const line of ["*_*", "    ---", "    =====", "    # not a heading", "    - not an item"]) {
      expect(markdownLinkTargets(`A \` here.\n${line}\nSee [x](DOC.999.md) \`y\`.`), line).toEqual([]);
    }
  });

  it("still treats a fence-like line four columns past the list content as indented code", () => {
    expect(markdownLinkTargets("Text.\n\n    ```\n    [a](DOC.003.md)\n\n[b](DOC.004.md)")).toEqual(["DOC.004.md"]);
  });

  it("does not pair a stray backtick with one in the next list item, heading or table row", () => {
    for (const body of [
      "- Press the ` key.\n- See [x](DOC.999.md) for `y`.",
      "A ` here.\n# See [x](DOC.999.md) `y`",
      "| a ` | b |\n| [x](DOC.999.md) | `y` |",
    ]) {
      expect(markdownLinkTargets(body), body).toEqual(["DOC.999.md"]);
    }
  });

  it("ends a code span's paragraph at a CRLF blank line too", () => {
    expect(markdownLinkTargets("A ` here.\r\n\r\nSee [x](DOC.999.md) `y`.")).toEqual(["DOC.999.md"]);
  });

  it("keeps an inline link that opens a footnote or definition-like line", () => {
    expect(markdownLinkTargets("Text.[^1]\n\n[^1]: [DOC.001](DOC.001.md), section 3.")).toEqual(["DOC.001.md"]);
    expect(markdownLinkTargets("[r]\n\n[r]: [x](A.md) trailing words")).toEqual(["A.md"]);
  });

  it("still reads a definition with a title, in any of the three title forms", () => {
    expect(markdownLinkTargets('[a] [b] [c]\n\n[a]: A.md "t"\n[b]: B.md \'t\'\n[c]: <C.md> (t)')).toEqual([
      "A.md",
      "B.md",
      "C.md",
    ]);
  });
});

describe("markdownLinkTargets in code", () => {
  it("ignores links inside backtick and tilde fences", () => {
    const body = [
      "```markdown",
      "[a](DOC.003.md)",
      "```",
      "  ~~~~",
      "[b](DOC.004.md)",
      "~~~",
      "[c](DOC.005.md)",
      "~~~~",
      "[d](DOC.006.md)",
    ].join("\n");
    expect(markdownLinkTargets(body)).toEqual(["DOC.006.md"]);
  });

  it("treats an unclosed fence as code to the end of the body", () => {
    expect(markdownLinkTargets("[a](A.md)\n```\n[b](B.md)")).toEqual(["A.md"]);
  });

  it("ignores links inside inline code spans", () => {
    expect(markdownLinkTargets("Write `[x](DOC.003.md)` to link.")).toEqual([]);
  });

  it("matches equal-length backtick runs, so a span may contain a backtick", () => {
    expect(markdownLinkTargets("``a ` [x](DOC.003.md)`` and [y](DOC.004.md)")).toEqual(["DOC.004.md"]);
  });

  it("keeps a real link next to code, including one whose text is code", () => {
    const body = "Use `[x](A.md)` as in [the rule](B.md) or [`DOC.004`](DOC.004.md).";
    expect(markdownLinkTargets(body)).toEqual(["B.md", "DOC.004.md"]);
  });

  it("does not pair a stray backtick with one in a later paragraph", () => {
    expect(markdownLinkTargets("a ` b\n\n[x](A.md) `c`")).toEqual(["A.md"]);
  });
});

describe("markdownLinkTargets in indented code", () => {
  it("ignores a four-space indented block at the start or after a blank line", () => {
    const body = "    [a](A.md)\n\nText.\n\n    [b](B.md)\n\n      [c](C.md)\n[d](D.md)";
    expect(markdownLinkTargets(body)).toEqual(["D.md"]);
  });

  it("ignores a tab-indented block, and an indented block right after a heading", () => {
    expect(markdownLinkTargets("Text.\n\n\t[a](A.md)\n\n# Heading\n    [b](B.md)")).toEqual([]);
  });

  it("keeps an indented line that continues a paragraph", () => {
    expect(markdownLinkTargets("Some text\n    [a](A.md)")).toEqual(["A.md"]);
  });

  it("keeps indented continuation of a list item, nested or not", () => {
    const body = "- item\n\n    [a](A.md)\n\n1. item\n   - nested\n\n     [b](B.md)";
    expect(markdownLinkTargets(body)).toEqual(["A.md", "B.md"]);
  });

  it("ignores code indented four columns past a list item's content", () => {
    expect(markdownLinkTargets("- item\n\n      [a](A.md)\n\n  [b](B.md)")).toEqual(["B.md"]);
  });

  it("ends a list item at a line indented less than its content", () => {
    expect(markdownLinkTargets("   - item\n\n    [a](A.md)")).toEqual([]);
  });
});

describe("markdownLinkTargets reference links", () => {
  it("ignores a definition whose label is never used", () => {
    expect(markdownLinkTargets("No links here.\n\n[unused]: DOC.001.md")).toEqual([]);
  });

  it.each([
    ["full", "See [the rule][r]."],
    ["collapsed", "See [r][]."],
    ["shortcut", "See [r]."],
  ])("counts a definition used in %s form", (_form, text) => {
    expect(markdownLinkTargets(`${text}\n\n[r]: DOC.001.md`)).toEqual(["DOC.001.md"]);
  });

  it("orders by first use in the body, merged with inline links", () => {
    const body = "[first][late] then [second](DOC.002.md).\n\n[late]: DOC.001.md";
    expect(markdownLinkTargets(body)).toEqual(["DOC.001.md", "DOC.002.md"]);
  });

  it("matches labels case-insensitively with whitespace collapsed", () => {
    const body = "See [The  Error\nRule][].\n\n[the error rule]: DOC.003.md";
    expect(markdownLinkTargets(body)).toEqual(["DOC.003.md"]);
  });

  it("ignores definitions inside code", () => {
    expect(markdownLinkTargets("See [r].\n\n```\n[r]: DOC.001.md\n```")).toEqual([]);
  });

  it("lets the first definition of a label win", () => {
    expect(markdownLinkTargets("[r]\n\n[r]: A.md\n[R]: B.md")).toEqual(["A.md"]);
  });
});


describe("markdownLinks", () => {
  it("reports an offset inside each link, so callers can name its line", () => {
    const body = "intro\n\nsee [a](DOC.001.md)\n\nand [b][r]\n\n[r]: /REF/REF.001.md\n";
    const line = (index: number) => body.slice(0, index).split("\n").length;
    expect(markdownLinks(body).map((l) => [l.target, line(l.index)])).toEqual([
      ["DOC.001.md", 3],
      ["/REF/REF.001.md", 5],
    ]);
  });
});

describe("resolveBundleTarget", () => {
  it("resolves bundle-absolute targets against the root and relative ones against the file", () => {
    const root = "/b";
    expect(resolveBundleTarget(root, "/b/DOC/A.md", "/REF/B.md")).toBe("/b/REF/B.md");
    expect(resolveBundleTarget(root, "/b/DOC/A.md", "../REF/B.md")).toBe("/b/REF/B.md");
  });

  it("is undefined for a target that leaves the bundle root", () => {
    expect(resolveBundleTarget("/b", "/b/DOC/A.md", "/../../x.md")).toBeUndefined();
    expect(resolveBundleTarget("/b", "/b/DOC/A.md", "../../x.md")).toBeUndefined();
    expect(resolveBundleTarget("/b", "/b/DOC/A.md", "../x.md")).toBe("/b/x.md");
  });

  it("does not decode again: targets arrive decoded", () => {
    expect(resolveBundleTarget("/b", "/b/A.md", "100%25.md")).toBe("/b/100%25.md");
  });
});

describe("code spans at scale", () => {
  it("stays fast on many unmatched backticks", () => {
    const body = "`a ".repeat(200000) + "\n\n[x](A.md)\n";
    const started = performance.now();
    expect(markdownLinks(body).map((l) => l.target)).toEqual(["A.md"]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

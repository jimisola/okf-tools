import { describe, expect, it } from "vitest";
import { proseLines } from "../src/markdown.js";
import { markdownLinkTargets } from "../src/parse.js";

const prose = (body: string) => proseLines(body).map((l) => l.line);

describe("proseLines: the validator skips the same code the link parser does", () => {
  it("skips a fence opened in a blockquote", () => {
    const body = "> ```\n> # not a heading\n> ```\n# Real\n";
    expect(prose(body)).toEqual([4, 5]);
  });

  it("skips a fence opened on a list item's line", () => {
    const body = "- ~~~\n  # not a heading\n  ~~~\n\nText\n";
    expect(prose(body)).toEqual([1, 4, 5, 6]);
  });

  it("skips an indented code block, but keeps list continuation lines", () => {
    expect(prose("Para\n\n    # code\n")).toEqual([1, 2, 4]);
    expect(prose("- item\n\n    continued\n")).toEqual([1, 2, 3, 4]);
  });

  it("agrees with the link parser on what is code", () => {
    const body = "Para\n\n    [y](B.md)\n\n- ~~~\n  [x](A.md)\n  ~~~\n\n[z](C.md)\n";
    expect(markdownLinkTargets(body)).toEqual(["C.md"]);
    const kept = proseLines(body).map((l) => l.text).join("\n");
    expect(kept).not.toContain("A.md");
    expect(kept).not.toContain("B.md");
  });
});

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { marked } from "marked";

// Pins the marked behaviour the viewer relies on, through both the ESM export
// and the UMD file that generate.ts inlines into the page.
const require = createRequire(import.meta.url);
const umdPath = path.join(
  path.dirname(require.resolve("marked/package.json")),
  "lib",
  "marked.umd.js",
);

const SAMPLE = [
  "# Title",
  "",
  "Some *emphasis*, **strong** and `code`.",
  "",
  "- one",
  "- two",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "[local](../REF/REF.001.md) and [ext](https://example.com/x)",
  "",
  "```ts",
  "const x = 1;",
  "```",
].join("\n");

describe("marked (ESM)", () => {
  const html = marked.parse(SAMPLE, { async: false });

  it("renders headings, inline formatting, lists, tables and fences", () => {
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<em>emphasis</em>");
    expect(html).toContain("<strong>strong</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toMatch(/<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
    expect(html).toContain("<table>");
    expect(html).toMatch(/<td>1<\/td>\s*<td>2<\/td>/);
    expect(html).toMatch(/<pre><code class="language-ts">const x = 1;/);
  });

  it("keeps link hrefs verbatim so the viewer can rewire relative .md links", () => {
    expect(html).toContain('<a href="../REF/REF.001.md">local</a>');
    expect(html).toContain('<a href="https://example.com/x">ext</a>');
  });
});

describe("marked (inlined UMD build, evaluated in happy-dom)", () => {
  it("exposes window.marked.parse and renders the same output as the ESM build", () => {
    const window = new Window({
      settings: { enableJavaScriptEvaluation: true },
    });
    window.document.body.innerHTML = '<div id="out"></div>';
    window.eval(readFileSync(umdPath, "utf8"));
    const parsed = window.eval(
      `marked.parse(${JSON.stringify(SAMPLE)})`,
    ) as string;
    window.document.getElementById("out")!.innerHTML = parsed;
    const out = window.document.getElementById("out")!;
    expect(out.querySelector("h1")?.textContent).toBe("Title");
    expect(out.querySelectorAll("li")).toHaveLength(2);
    expect(out.querySelector("a[href='../REF/REF.001.md']")).not.toBeNull();
    expect(parsed).toBe(marked.parse(SAMPLE, { async: false }));
    window.close();
  });
});

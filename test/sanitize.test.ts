import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { generate } from "../src/generate.js";
import { PURIFY_SOURCE } from "./helpers.js";

// The sanitizer runs in jsdom, which DOMPurify supports; happy-dom (used by the
// UI tests) is not faithful enough for it.
const FIXTURE = fileURLToPath(new URL("./fixtures/bundle", import.meta.url));

const page = (extra: Record<string, unknown> = {}) =>
  generate(FIXTURE, resolveConfig({ name: "Sanitize", ...extra })).html;

const windows: { close(): void }[] = [];
afterAll(() => {
  for (const w of windows) w.close();
});

function render(html: string, markdown: string): HTMLElement {
  const dom = new JSDOM(html, { runScripts: "dangerously" });
  windows.push(dom.window);
  const w = dom.window as unknown as {
    renderMarkdownBody(fromFile: string, md: string): HTMLElement;
  };
  return w.renderMarkdownBody("index.md", markdown);
}

describe("markdown bodies are sanitized", () => {
  const hostile = [
    "# Title",
    "",
    "<script>window.pwned = 1</script>",
    '<img src="x" onerror="window.pwned = 1">',
    '<a href="javascript:alert(1)">js</a> <a href="data:text/html,x">data</a>',
    '<a href="vbscript:x">vb</a>',
    "",
    "[md js](javascript:alert(1))",
    "",
    '<iframe src="https://example.com"></iframe><object data="x"></object>',
    '<form action="https://example.com"><input name="q"></form>',
    '<style>body{display:none}</style><p style="color:red">styled</p>',
    '<svg><a xlink:href="javascript:alert(1)">svg</a></svg>',
    "",
    "[web](https://example.com) [rel](./other.md) [frag](#here)",
  ].join("\n");

  it("removes scripts, handlers, unsafe URLs and active elements", () => {
    const body = render(page(), hostile);
    const attrs = [...body.querySelectorAll("*")].flatMap((e) =>
      [...e.attributes].map((a) => `${a.name}=${a.value}`),
    );
    // A lone <input> may stay: it cannot submit, and GFM task lists need checkboxes.
    expect(body.querySelector("script, iframe, object, form, style, svg")).toBeNull();
    expect(attrs.join(" ")).not.toMatch(/onerror|javascript:|vbscript:|data:/i);
    expect([...body.querySelectorAll("a")].map((a) => a.textContent)).toContain("md js");
    expect(body.querySelector("[style]")).toBeNull();
  });

  it("keeps only a disabled task-list checkbox as a form control", () => {
    const body = render(page(), "- [x] done\n- [ ] open\n\n<input name=\"q\"> <input type=\"checkbox\">");
    const inputs = [...body.querySelectorAll("input")];
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input.getAttribute("type")).toBe("checkbox");
      expect(input.hasAttribute("disabled")).toBe(true);
    }
  });

  it("prefixes body ids and names so they cannot shadow the page's own", () => {
    const body = render(page(), '<div id="panel">x</div><a name="stats">y</a>');
    expect(body.querySelector("div")?.id).toBe("user-content-panel");
    expect(body.querySelector("a")?.getAttribute("name")).toBe("user-content-stats");
  });

  it("keeps ordinary markdown, http(s), relative and fragment links", () => {
    const body = render(page(), hostile);
    expect(body.querySelector("h1")?.textContent).toBe("Title");
    const hrefs = [...body.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://example.com", "./other.md", "#here"]);
    expect(body.querySelector('a[href="https://example.com"]')?.getAttribute("rel")).toBe(
      "noopener",
    );
  });

  it("drops remote images unless the config allows them", () => {
    const md = "![a](https://example.com/a.png) ![b](//example.com/b.png) ![c](img/c.png)";
    const off = render(page(), md);
    expect([...off.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([
      null,
      null,
      "img/c.png",
    ]);
    const on = render(page({ remoteImages: true }), md);
    expect([...on.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([
      "https://example.com/a.png",
      "//example.com/b.png",
      "img/c.png",
    ]);
  });

  it("fails closed without DOMPurify: the markdown is shown as text", () => {
    const html = page();
    expect(html).toContain(PURIFY_SOURCE);
    const body = render(html.replace(PURIFY_SOURCE, () => ""), '<img src="x" onerror="1"> **b**');
    expect(body.querySelector("img, strong")).toBeNull();
    expect(body.querySelector("pre")?.textContent).toBe('<img src="x" onerror="1"> **b**');
  });
});

describe("Content-Security-Policy", () => {
  const html = page();
  const doc = new JSDOM(html).window.document;
  const csp =
    doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "";
  const directive = (name: string) =>
    csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `)) ?? "";

  it("comes before any script", () => {
    const head = doc.head.innerHTML;
    expect(head.indexOf("Content-Security-Policy")).toBeGreaterThan(-1);
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script"));
  });

  it("allows exactly the page's own inline scripts, by hash", () => {
    const scripts = [...doc.querySelectorAll("script:not([type])")].map(
      (s) => `'sha256-${createHash("sha256").update(s.textContent ?? "", "utf8").digest("base64")}'`,
    );
    expect(scripts).toHaveLength(3); // marked, DOMPurify, the viewer runtime
    expect(directive("script-src").split(/\s+/).slice(1).sort()).toEqual([...scripts].sort());
  });

  it("loads images from the page's origin only, unless remoteImages is on", () => {
    expect(directive("img-src")).toBe("img-src 'self'");
    const on = new JSDOM(page({ remoteImages: true })).window.document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content");
    expect(on).toContain("img-src 'self' https:");
    expect(on).not.toContain("data:");
  });

  it("loads nothing else: no unsafe-inline scripts, no hosts, no plugins, no base", () => {
    expect(csp).toContain("default-src 'none'");
    expect(directive("script-src")).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });
});

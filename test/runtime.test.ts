import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Browser,
  type Document,
  type Element,
  type HTMLAnchorElement,
  type HTMLButtonElement,
  type HTMLDetailsElement,
  type HTMLElement,
  type HTMLInputElement,
  type HTMLSelectElement,
} from "happy-dom";
import { afterAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { generate } from "../src/generate.js";

// Execute the generated page's inline scripts in a DOM and poke the UI.
const FIXTURE = fileURLToPath(new URL("./fixtures/bundle", import.meta.url));

const config = resolveConfig({
  name: "Fixture Corpus",
  facets: ["type", "domain"],
  typeLabels: { policy: "must", guideline: "should" },
  draft: { field: "lifecycle", value: "draft" },
  backLink: "../",
});

const browser = new Browser({
  settings: {
    enableJavaScriptEvaluation: true, // the page under test is our own output
    suppressInsecureJavaScriptEnvironmentWarning: true,
    disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true,
  },
});

async function loadPage() {
  const { html } = generate(FIXTURE, config);
  const page = browser.newPage();
  page.content = html;
  await page.waitUntilComplete();
  return page;
}

afterAll(async () => {
  await browser.close();
});

describe("generated page runtime", () => {
  it("boots without errors and renders stats, legend, chips and nodes", async () => {
    const page = await loadPage();
    const doc = page.mainFrame.document;
    expect(doc.title).toBe("Fixture Corpus");
    expect(doc.getElementById("stats")?.textContent).toContain("4 publications");
    expect(doc.getElementById("stats")?.textContent).toContain("3 citations");
    expect(doc.getElementById("stats")?.textContent).toContain("1 islands");
    expect(doc.getElementById("stats")?.textContent).toContain("1 drafts");
    expect(doc.getElementById("legend")?.textContent).toContain("policy (must)");
    expect(doc.querySelectorAll("circle[data-id]")).toHaveLength(4);
    // facet chips discovered from the bundle
    const chips = [...doc.querySelectorAll(".controls .chip")].map(
      (c) => c.textContent,
    );
    expect(chips).toContain("guideline");
    expect(chips).toContain("platform");
    // the Index shown when nothing is selected
    expect(doc.getElementById("panel")?.textContent).toContain("Index");
  });

  it("selecting a node renders frontmatter, markdown body and citation lists", async () => {
    const page = await loadPage();
    const doc = page.mainFrame.document;
    const node = doc.querySelector('circle[data-id="DOC.001"]');
    node?.dispatchEvent(new page.mainFrame.window.MouseEvent("click", { bubbles: true }));
    const panel = doc.getElementById("panel");
    expect(panel?.textContent).toContain("Alpha policy");
    expect(panel?.textContent).toContain("appliesWhen");
    expect(panel?.textContent).toContain("Cites (2)");
    expect(panel?.textContent).toContain("Cited by (0) — impact if this changes");
    // body rendered as HTML via marked
    expect(panel?.querySelector(".body-md h1")?.textContent).toBe("Alpha");
    // relative .md links in the body got in-pane navigation targets
    const bodyLink = panel?.querySelector('.body-md a[data-go="REF.001"]');
    expect(bodyLink).toBeTruthy();
  });
});

describe("frontmatter URL values", () => {
  async function metaOf() {
    const page = await loadPage();
    const doc = page.mainFrame.document;
    const node = doc.querySelector('circle[data-id="DOC.001"]');
    node?.dispatchEvent(
      new page.mainFrame.window.MouseEvent("click", { bubbles: true }),
    );
    return doc.querySelector("#panel .meta") as HTMLElement;
  }

  it("renders http(s) values inside objects and object arrays as safe links", async () => {
    const meta = await metaOf();
    const links = [...meta.querySelectorAll("a.ext")] as HTMLAnchorElement[];
    const hrefs = links.map((a) => a.getAttribute("href"));
    // source.url (nested object) and sources[].resource (array of objects)
    expect(hrefs).toContain(
      "https://example.com/wiki/spaces/ARCH/pages/123456789/A-very-long-page-title-that-should-be-shortened",
    );
    expect(hrefs).toContain("https://example.com/spec/alpha");
    // a top-level scalar URL
    expect(hrefs).toContain("https://example.com/home");
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      expect(a.getAttribute("title")).toBe(a.getAttribute("href"));
    }
  });

  it("shortens long link text but keeps the full URL in title", async () => {
    const meta = await metaOf();
    const long = [...meta.querySelectorAll("a.ext")].find((a) =>
      a.getAttribute("href")?.includes("A-very-long-page-title"),
    ) as HTMLAnchorElement;
    expect(long.textContent).toContain("…");
    expect(long.textContent!.length).toBeLessThan(
      long.getAttribute("title")!.length,
    );
    expect(long.textContent).toContain("example.com");
  });

  it("never links a javascript: value — it stays inert text", async () => {
    const meta = await metaOf();
    expect(meta.textContent).toContain("javascript:alert(1)");
    // allow-list, not deny-list: every anchor the panel produced is http(s),
    // so no javascript:/data:/vbscript: value can have slipped through
    for (const a of meta.querySelectorAll("a")) {
      expect(a.getAttribute("href")).toMatch(/^https?:\/\//);
    }
    expect(meta.querySelector('a[href^="javascript:"]')).toBeFalsy();
  });

  it("leaves non-URL strings as plain text", async () => {
    const meta = await metaOf();
    // a URL embedded in prose is not a link target
    expect(meta.textContent).toContain("see https://example.com later");
    const hrefs = [...meta.querySelectorAll("a.ext")].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).not.toContain("https://example.com");
    expect(hrefs).not.toContain("designing APIs");
  });
});

describe("multi-select facets", () => {
  // A generated bundle where `domain` has 10 values (> the 8-chip cutoff):
  // doc0..doc9, domain d0..d9 (one publication each), type alternating
  // policy (even) / guideline (odd).
  const MANY = fileURLToPath(new URL("./fixtures/.many-domains-tmp", import.meta.url));
  rmSync(MANY, { recursive: true, force: true });
  mkdirSync(MANY, { recursive: true });
  for (let i = 0; i < 10; i++) {
    writeFileSync(
      path.join(MANY, `doc${i}.md`),
      `---\nid: DOC.${i}\ntitle: Doc ${i}\ntype: ${i % 2 === 0 ? "policy" : "guideline"}\ndomain: d${i}\n---\nBody ${i}.\n`,
    );
  }
  afterAll(() => rmSync(MANY, { recursive: true, force: true }));

  const manyConfig = resolveConfig({
    name: "Many Domains",
    facets: ["type", "domain"], // string entries must keep working
  });

  async function loadMany() {
    const { html } = generate(MANY, manyConfig);
    const page = browser.newPage();
    page.content = html;
    await page.waitUntilComplete();
    return page;
  }

  const circles = (doc: Document) => doc.querySelectorAll("circle[data-id]");
  const change = (page: Awaited<ReturnType<typeof loadMany>>, box: Element) => {
    box.dispatchEvent(new page.mainFrame.window.Event("change", { bubbles: true }));
  };

  it("a facet with >8 values renders as a dropdown; small facets stay chips", async () => {
    const page = await loadMany();
    const doc = page.mainFrame.document;
    const btn = doc.querySelector(".controls .dd-btn");
    expect(btn?.textContent).toBe("domain: all");
    expect(btn?.getAttribute("aria-haspopup")).toBe("true");
    // type has 2 values: still a chip row
    expect(doc.querySelector('.controls .chip[data-facet="type"][data-value="policy"]')).toBeTruthy();
    expect(doc.querySelector('.controls [data-facet="domain"]')).toBeFalsy();
  });

  it("checked values OR within the facet, AND across facets, clear restores", async () => {
    const page = await loadMany();
    const doc = page.mainFrame.document;
    expect(circles(doc)).toHaveLength(10);

    const btn = doc.querySelector(".controls .dd-btn") as HTMLButtonElement;
    btn.click();
    const pop = doc.querySelector(".controls .dd-pop") as HTMLElement;
    expect(pop.hidden).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const boxes = [...pop.querySelectorAll("input[type=checkbox]")] as HTMLInputElement[];
    expect(boxes).toHaveLength(10);
    // each value shows its publication count
    expect(pop.querySelector(".dd-cnt")?.textContent).toBe("1");

    // OR within the facet: d1 ∪ d2
    change(page, boxes.find((b) => b.value === "d1")!);
    change(page, boxes.find((b) => b.value === "d2")!);
    expect(btn.textContent).toBe("domain: 2 selected");
    expect(circles(doc)).toHaveLength(2);

    // AND across facets: (d1 ∪ d2) ∩ policy = doc2 only
    const policyChip = doc.querySelector(
      '.controls .chip[data-facet="type"][data-value="policy"]',
    ) as HTMLButtonElement;
    policyChip.click();
    expect(policyChip.getAttribute("aria-pressed")).toBe("true");
    expect(circles(doc)).toHaveLength(1);
    expect(doc.querySelector('circle[data-id="DOC.2"]')).toBeTruthy();

    // clear the dropdown facet: back to all 5 policy docs
    (pop.querySelector(".dd-clear") as HTMLButtonElement).click();
    expect(btn.textContent).toBe("domain: all");
    expect(circles(doc)).toHaveLength(5);
    for (const b of boxes) expect(b.checked).toBe(false);

    // clear the chip facet via its "all" chip: everything is back
    (doc.querySelector('.controls .chip[data-facet="type"][data-value=""]') as HTMLButtonElement).click();
    expect(circles(doc)).toHaveLength(10);
  });

  it("legend clicks toggle the same type selection as the chips", async () => {
    const page = await loadMany();
    const doc = page.mainFrame.document;
    const legendBtn = doc.querySelector('[data-legend-type="guideline"]') as HTMLButtonElement;
    legendBtn.click();
    expect(circles(doc)).toHaveLength(5);
    const chip = doc.querySelector('.controls .chip[data-facet="type"][data-value="guideline"]');
    expect(chip?.getAttribute("aria-pressed")).toBe("true");
    legendBtn.click(); // toggle off
    expect(circles(doc)).toHaveLength(10);
    expect(chip?.getAttribute("aria-pressed")).toBe("false");
  });

  it("Escape closes the popover and returns focus to the button", async () => {
    const page = await loadMany();
    const doc = page.mainFrame.document;
    const btn = doc.querySelector(".controls .dd-btn") as HTMLButtonElement;
    btn.click();
    const pop = doc.querySelector(".controls .dd-pop") as HTMLElement;
    expect(pop.hidden).toBe(false);
    pop.dispatchEvent(
      new page.mainFrame.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(pop.hidden).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(doc.activeElement).toBe(btn);
  });
});

describe("details-panel empty state: Overview vs Index", () => {
  // A bundle with a root index.md. The index links one concept (a real
  // citation target) and one reserved file (never a concept, so inert).
  const INDEXED = fileURLToPath(new URL("./fixtures/.indexed-tmp", import.meta.url));
  rmSync(INDEXED, { recursive: true, force: true });
  mkdirSync(path.join(INDEXED, "DOC"), { recursive: true });
  writeFileSync(
    path.join(INDEXED, "index.md"),
    '---\nokf_version: "0.2"\n---\n\n# Bundle overview\n\nHow to read this corpus.\n\n* [First doc](DOC/DOC.001.md) - the entry point\n* [Change log](log.md) - not a concept\n',
  );
  writeFileSync(path.join(INDEXED, "log.md"), "## 2026-08-28\n\nEntry.\n");
  writeFileSync(
    path.join(INDEXED, "DOC", "DOC.001.md"),
    "---\nid: DOC.001\ntitle: First doc\ntype: policy\n---\n\n# First\n\nBody one.\n",
  );
  writeFileSync(
    path.join(INDEXED, "DOC", "DOC.002.md"),
    "---\nid: DOC.002\ntitle: Second doc\ntype: policy\n---\n\n# Second\n\nSee [First doc](DOC.001.md).\n",
  );
  afterAll(() => rmSync(INDEXED, { recursive: true, force: true }));

  const indexedConfig = resolveConfig({ name: "Indexed Corpus", facets: ["type"] });

  async function loadIndexed(stored?: string) {
    const { html } = generate(INDEXED, indexedConfig);
    const page = browser.newPage();
    if (stored !== undefined)
      page.mainFrame.window.localStorage.setItem("okf-viewer-empty-view", stored);
    page.content = html;
    await page.waitUntilComplete();
    return page;
  }

  const tabs = (doc: Document) =>
    [...doc.querySelectorAll("#panel .seg-opt")] as HTMLButtonElement[];

  it("the index is embedded in the page but is not a node", async () => {
    const page = await loadIndexed();
    const doc = page.mainFrame.document;
    expect(doc.querySelectorAll("circle[data-id]")).toHaveLength(2);
    expect(doc.getElementById("stats")?.textContent).toContain("2 publications");
    expect(doc.querySelector('circle[data-id="index"]')).toBeFalsy();
    expect(
      JSON.parse(doc.getElementById("viewer-data")!.textContent!).index.body,
    ).toContain("# Bundle overview");
  });

  it("defaults to the Index even when the bundle has an index.md", async () => {
    const page = await loadIndexed();
    const doc = page.mainFrame.document;
    const panel = doc.getElementById("panel") as HTMLElement;
    expect(tabs(doc).map((b) => b.textContent)).toEqual(["Overview", "Index"]);
    expect(tabs(doc).map((b) => b.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
    ]);
    expect(panel.querySelector(".seg")?.getAttribute("role")).toBe("tablist");
    expect(tabs(doc)[0]!.getAttribute("role")).toBe("tab");
    expect(panel.querySelector("table.rank")).toBeTruthy();
    expect(panel.querySelector(".body-md")).toBeFalsy();
  });

  it("switching to Overview renders the index body as markdown, and persists", async () => {
    const page = await loadIndexed();
    const doc = page.mainFrame.document;
    const panel = doc.getElementById("panel") as HTMLElement;
    tabs(doc)[0]!.click();
    expect(panel.querySelector(".body-md h1")?.textContent).toBe("Bundle overview");
    expect(panel.textContent).toContain("How to read this corpus.");
    expect(panel.querySelector("table.rank")).toBeFalsy();
    expect(doc.activeElement).toBe(tabs(doc)[0]);
    expect(
      page.mainFrame.window.localStorage.getItem("okf-viewer-empty-view"),
    ).toBe("overview");
  });

  it("relative .md links in the Overview navigate in-pane; non-concepts stay inert", async () => {
    const page = await loadIndexed("overview");
    const doc = page.mainFrame.document;
    const panel = doc.getElementById("panel") as HTMLElement;
    const links = [...panel.querySelectorAll(".body-md a")] as HTMLAnchorElement[];
    expect(links.map((a) => a.dataset.go)).toEqual(["DOC.001", undefined]);
    // cancelable: the handler calls preventDefault, so the frame must not navigate
    links[0]!.dispatchEvent(
      new page.mainFrame.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(panel.querySelector(".pid")?.textContent).toBe("DOC.001");
    expect(panel.textContent).toContain("Cited by (1) — impact if this changes");
    // going back returns to the active empty-state view — the Overview
    (panel.querySelector("button.chip") as HTMLButtonElement).click();
    expect(panel.querySelector(".body-md h1")?.textContent).toBe("Bundle overview");
  });

  it("the Index lists every visible publication, not only the cited ones", async () => {
    const page = await loadIndexed();
    const doc = page.mainFrame.document;
    const panel = doc.getElementById("panel") as HTMLElement;
    const rows = [...panel.querySelectorAll("table.rank tbody tr")];
    expect(rows.map((r) => r.querySelector(".mono")?.textContent)).toEqual([
      "DOC.001",
      "DOC.002",
    ]);
    expect(panel.textContent).toContain("2 publications");
    // unfiltered, so nothing to clear
    expect(panel.querySelector(".idx-clear")).toBeFalsy();
    expect(panel.querySelector(".body-md")).toBeFalsy();
  });

  it("arrow keys move between the two options", async () => {
    const page = await loadIndexed();
    const doc = page.mainFrame.document;
    const panel = doc.getElementById("panel") as HTMLElement;
    expect(tabs(doc).map((b) => b.tabIndex)).toEqual([-1, 0]);
    panel.querySelector(".seg")!.dispatchEvent(
      new page.mainFrame.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    expect(panel.querySelector(".body-md h1")?.textContent).toBe("Bundle overview");
    expect(tabs(doc).map((b) => b.tabIndex)).toEqual([0, -1]);
    panel.querySelector(".seg")!.dispatchEvent(
      new page.mainFrame.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(panel.querySelector("table.rank")).toBeTruthy();
  });

  it("honours a stored choice on a later visit, incl. the legacy name", async () => {
    // "ranking" is what this view was called before it became the Index
    const page = await loadIndexed("ranking");
    const panel = page.mainFrame.document.getElementById("panel") as HTMLElement;
    expect(panel.querySelector("table.rank")).toBeTruthy();
    expect(panel.querySelector(".body-md")).toBeFalsy();
    const back = await loadIndexed("overview");
    expect(
      (back.mainFrame.document.getElementById("panel") as HTMLElement).querySelector(
        ".body-md h1",
      )?.textContent,
    ).toBe("Bundle overview");
  });

  it("a bundle with no index.md has no toggle and shows the Index, stored choice or not", async () => {
    for (const stored of [undefined, "overview"]) {
      const { html } = generate(FIXTURE, config);
      const page = browser.newPage();
      if (stored) page.mainFrame.window.localStorage.setItem("okf-viewer-empty-view", stored);
      page.content = html;
      await page.waitUntilComplete();
      const doc = page.mainFrame.document;
      const panel = doc.getElementById("panel") as HTMLElement;
      expect(panel.querySelector(".seg")).toBeFalsy();
      expect(panel.textContent).toContain("Index");
      expect(panel.querySelector("table.rank")).toBeTruthy();
      expect(
        JSON.parse(doc.getElementById("viewer-data")!.textContent!).index,
      ).toBeUndefined();
    }
  });
});

describe("the Index: the page filter state, sortable", () => {
  // The fixture bundle has no index.md, so the Index is the empty state and
  // there is no toggle in the way.
  async function loadIndex(storedSort?: string) {
    const { html } = generate(FIXTURE, config);
    const page = browser.newPage();
    if (storedSort !== undefined)
      page.mainFrame.window.localStorage.setItem("okf-viewer-index-sort", storedSort);
    page.content = html;
    await page.waitUntilComplete();
    return page;
  }

  type Page = ReturnType<typeof browser.newPage>;

  const panelOf = (page: Page) =>
    page.mainFrame.document.getElementById("panel") as HTMLElement;
  const ids = (panel: HTMLElement) =>
    [...panel.querySelectorAll("table.rank tbody tr")].map(
      (r) => r.querySelector(".mono")?.textContent,
    );
  const headers = (panel: HTMLElement) =>
    [...panel.querySelectorAll("table.rank th")] as HTMLElement[];

  // The one search box, in the header — the same control that filters the graph
  function type(page: Page, value: string) {
    const input = page.mainFrame.document.getElementById("search") as HTMLInputElement;
    input.focus();
    input.value = value;
    input.dispatchEvent(new page.mainFrame.window.Event("input", { bubbles: true }));
    return input;
  }

  it("lists every publication, most cited first, and says how many", async () => {
    const page = await loadIndex();
    const panel = panelOf(page);
    expect(ids(panel)).toEqual(["REF.001", "DOC.002", "DOC.001", "island"]);
    expect(panel.textContent).toContain("4 publications");
    expect(panel.querySelector(".idx-clear")).toBeFalsy();
    expect(headers(panel).map((th) => th.textContent?.replace(/[\u25b2\u25bc]/, ""))).toEqual([
      "ID",
      "Title",
      "Citations",
    ]);
    expect(headers(panel).map((th) => th.getAttribute("aria-sort"))).toEqual([
      "none",
      "none",
      "descending",
    ]);
  });

  it("follows the header search on each keystroke, and says it is filtered", async () => {
    const page = await loadIndex();
    const input = type(page, "alpha");
    expect(ids(panelOf(page))).toEqual(["DOC.001"]);
    expect(panelOf(page).textContent).toContain("1 of 4 publications");
    expect(panelOf(page).querySelector(".idx-clear")).toBeTruthy();
    // the field is in the header, outside the panel that re-renders, so
    // typing never costs it focus or value
    expect(page.mainFrame.document.activeElement).toBe(input);
    expect(input.value).toBe("alpha");

    type(page, "policy");
    expect(ids(panelOf(page))).toEqual(["DOC.002", "DOC.001"]);

    type(page, "");
    expect(ids(panelOf(page))).toEqual(["REF.001", "DOC.002", "DOC.001", "island"]);
    expect(panelOf(page).textContent).toContain("4 publications");
  });

  it("shows the same set as the graph — facet filters included", async () => {
    const page = await loadIndex();
    const doc = page.mainFrame.document;
    // the `policy` type chip: one facet value, ANDed with everything else
    const chip = [...doc.querySelectorAll(".controls .chip")].find(
      (c) => c.textContent === "policy",
    ) as HTMLButtonElement;
    chip.click();
    const onGraph = [...doc.querySelectorAll("circle[data-id]")].map(
      (c) => (c as HTMLElement).dataset.id,
    );
    expect(ids(panelOf(page))).toEqual(onGraph.sort((a, b) => (a! < b! ? 1 : -1)));
    expect(panelOf(page).textContent).toContain("2 of 4 publications");
  });

  it("no match is an empty table with an explanation, not an error", async () => {
    const page = await loadIndex();
    type(page, "nothing matches this");
    expect(ids(panelOf(page))).toEqual([]);
    expect(panelOf(page).textContent).toContain("0 of 4 publications");
    expect(panelOf(page).textContent).toContain("Nothing matches");
  });

  it("the header Clear filters appears only when there is something to clear", async () => {
    const page = await loadIndex();
    const doc = page.mainFrame.document;
    const reset = () => doc.getElementById("reset") as HTMLButtonElement;
    expect(reset().hidden).toBe(true);

    type(page, "alpha");
    expect(reset().hidden).toBe(false);
    reset().click();
    expect(ids(panelOf(page))).toEqual(["REF.001", "DOC.002", "DOC.001", "island"]);
    expect(reset().hidden).toBe(true);

    // a selection counts as something to clear, and clearing returns the view
    (doc.querySelector('circle[data-id="REF.001"]') as HTMLElement).dispatchEvent(
      new page.mainFrame.window.MouseEvent("click", { bubbles: true }),
    );
    expect(reset().hidden).toBe(false);
    reset().click();
    expect(reset().hidden).toBe(true);
    expect(panelOf(page).querySelector("table.rank")).toBeTruthy();
  });

  it("Clear filters resets the search and the facets from inside the panel", async () => {
    const page = await loadIndex();
    const doc = page.mainFrame.document;
    const input = type(page, "alpha");
    const chip = [...doc.querySelectorAll(".controls .chip")].find(
      (c) => c.textContent === "policy",
    ) as HTMLButtonElement;
    chip.click();
    expect(ids(panelOf(page))).toEqual(["DOC.001"]);

    (panelOf(page).querySelector(".idx-clear") as HTMLButtonElement).click();
    expect(ids(panelOf(page))).toEqual(["REF.001", "DOC.002", "DOC.001", "island"]);
    // the header box is emptied too — the state and its control stay in step
    expect(
      (doc.getElementById("search") as HTMLInputElement).value,
    ).toBe("");
    expect(input.value).toBe("");
    expect(panelOf(page).querySelector(".idx-clear")).toBeFalsy();
  });

  it("sorts by ID, then reverses on a second click", async () => {
    const page = await loadIndex();
    const panel = panelOf(page);
    (panel.querySelector('[data-sort="id"]') as HTMLButtonElement).click();
    // case-insensitive, so the un-prefixed `island` sorts among the rest
    expect(ids(panelOf(page))).toEqual(["DOC.001", "DOC.002", "island", "REF.001"]);
    expect(headers(panelOf(page))[0]!.getAttribute("aria-sort")).toBe("ascending");
    // focus follows the control that was clicked, which the re-render replaced
    expect(page.mainFrame.document.activeElement).toBe(
      panelOf(page).querySelector('[data-sort="id"]'),
    );

    (panelOf(page).querySelector('[data-sort="id"]') as HTMLButtonElement).click();
    expect(ids(panelOf(page))).toEqual(["REF.001", "island", "DOC.002", "DOC.001"]);
    expect(headers(panelOf(page))[0]!.getAttribute("aria-sort")).toBe("descending");
  });

  it("sorts by title, case-insensitively", async () => {
    const page = await loadIndex();
    const panel = panelOf(page);
    (panel.querySelector('[data-sort="title"]') as HTMLButtonElement).click();
    // Alpha policy, Beta policy, Gamma guideline, No id field here
    expect(ids(panelOf(page))).toEqual(["DOC.001", "DOC.002", "REF.001", "island"]);
  });

  it("remembers the sort across visits and ignores a corrupt stored value", async () => {
    const first = await loadIndex();
    (panelOf(first).querySelector('[data-sort="id"]') as HTMLButtonElement).click();
    expect(
      first.mainFrame.window.localStorage.getItem("okf-viewer-index-sort"),
    ).toBe("id:1");

    const back = await loadIndex("id:1");
    expect(ids(panelOf(back))).toEqual(["DOC.001", "DOC.002", "island", "REF.001"]);

    const corrupt = await loadIndex("nonsense:9");
    expect(ids(panelOf(corrupt))).toEqual(["REF.001", "DOC.002", "DOC.001", "island"]);
  });

  it("a row links into the publication", async () => {
    const page = await loadIndex();
    const panel = panelOf(page);
    const link = panel.querySelector("table.rank tbody a") as HTMLAnchorElement;
    expect(link.dataset.go).toBe("REF.001");
    link.dispatchEvent(
      new page.mainFrame.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(panelOf(page).querySelector(".pid")?.textContent).toBe("REF.001");
  });
});

describe("the Overview folds into sections", () => {
  // A front page with several top sections — what an index.md becomes once a
  // corpus covers more than one practice.
  const FOLDED = fileURLToPath(new URL("./fixtures/.folded-tmp", import.meta.url));
  rmSync(FOLDED, { recursive: true, force: true });
  mkdirSync(path.join(FOLDED, "DOC"), { recursive: true });
  writeFileSync(
    path.join(FOLDED, "index.md"),
    [
      '---\nokf_version: "0.2"\n---\n',
      "# Corpus front page\n",
      "How to read this corpus.\n",
      "## Principles\n",
      "* [First doc](DOC/DOC.001.md)\n* [Second doc](DOC/DOC.002.md)\n",
      "## Standards\n",
      "Prose, then one item.\n",
      "* [First doc](DOC/DOC.001.md)\n",
      "## Advisories\n",
      "Nothing listed yet.\n",
    ].join("\n"),
  );
  writeFileSync(
    path.join(FOLDED, "DOC", "DOC.001.md"),
    "---\nid: DOC.001\ntitle: First doc\ntype: policy\n---\n\nBody one.\n",
  );
  writeFileSync(
    path.join(FOLDED, "DOC", "DOC.002.md"),
    "---\nid: DOC.002\ntitle: Second doc\ntype: policy\n---\n\nBody two.\n",
  );
  afterAll(() => rmSync(FOLDED, { recursive: true, force: true }));

  const foldedConfig = resolveConfig({ name: "Folded Corpus", facets: ["type"] });

  async function loadFolded(open?: string[]) {
    const { html } = generate(FOLDED, foldedConfig);
    const page = browser.newPage();
    page.mainFrame.window.localStorage.setItem("okf-viewer-empty-view", "overview");
    if (open)
      page.mainFrame.window.localStorage.setItem(
        "okf-viewer-overview-open",
        JSON.stringify(open),
      );
    page.content = html;
    await page.waitUntilComplete();
    return page;
  }

  const panelOf = (page: ReturnType<typeof browser.newPage>) =>
    page.mainFrame.document.getElementById("panel") as HTMLElement;
  const sections = (panel: HTMLElement) =>
    [...panel.querySelectorAll("details.sect")] as HTMLElement[];
  const summaryText = (panel: HTMLElement) =>
    sections(panel).map((d) => d.querySelector(".sect-t")?.textContent);

  it("folds at the heading level below the title and keeps the lede open", async () => {
    const panel = panelOf(await loadFolded());
    expect(summaryText(panel)).toEqual(["Principles", "Standards", "Advisories"]);
    // the h1 and the sentence under it are the overview proper — never folded
    expect(panel.querySelector(".body-md > h1")?.textContent).toBe("Corpus front page");
    expect(panel.querySelector(".body-md > p")?.textContent).toBe(
      "How to read this corpus.",
    );
    // closed by default: that is the point — you see the shape first
    expect(sections(panel).map((d) => (d as HTMLDetailsElement).open)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("a closed section still says how much is in it", async () => {
    const panel = panelOf(await loadFolded());
    expect(sections(panel).map((d) => d.querySelector(".sect-n")?.textContent)).toEqual([
      "2",
      "1",
      undefined,
    ]);
  });

  it("links inside a folded section still navigate in-pane", async () => {
    const page = await loadFolded(["Principles"]);
    const panel = panelOf(page);
    expect((sections(panel)[0] as HTMLDetailsElement).open).toBe(true);
    const link = sections(panel)[0]!.querySelector("a") as HTMLAnchorElement;
    expect(link.dataset.go).toBe("DOC.001");
    link.dispatchEvent(
      new page.mainFrame.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(panelOf(page).querySelector(".pid")?.textContent).toBe("DOC.001");
  });

  it("remembers which sections were open", async () => {
    const page = await loadFolded();
    const panel = panelOf(page);
    (sections(panel)[1] as HTMLDetailsElement).open = true;
    expect(
      JSON.parse(
        page.mainFrame.window.localStorage.getItem("okf-viewer-overview-open")!,
      ),
    ).toEqual(["Standards"]);

    const back = panelOf(await loadFolded(["Standards"]));
    expect(sections(back).map((d) => (d as HTMLDetailsElement).open)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("expand all opens every section, then offers to collapse them", async () => {
    const page = await loadFolded();
    const btn = () => panelOf(page).querySelector(".fold-all") as HTMLButtonElement;
    expect(btn().textContent).toBe("Expand all");
    btn().click();
    expect(
      sections(panelOf(page)).map((d) => (d as HTMLDetailsElement).open),
    ).toEqual([true, true, true]);
    expect(btn().textContent).toBe("Collapse all");
    btn().click();
    expect(
      sections(panelOf(page)).map((d) => (d as HTMLDetailsElement).open),
    ).toEqual([false, false, false]);
    expect(btn().textContent).toBe("Expand all");
  });

  it("an index.md with nothing to fold is left exactly as it was", async () => {
    // a front page with a title and a list, but no sections to fold at
    const FLAT = fileURLToPath(new URL("./fixtures/.flat-tmp", import.meta.url));
    rmSync(FLAT, { recursive: true, force: true });
    mkdirSync(path.join(FLAT, "DOC"), { recursive: true });
    writeFileSync(
      path.join(FLAT, "index.md"),
      '---\nokf_version: "0.2"\n---\n\n# Flat front page\n\nOne list:\n\n* [First doc](DOC/DOC.001.md)\n',
    );
    writeFileSync(
      path.join(FLAT, "DOC", "DOC.001.md"),
      "---\nid: DOC.001\ntitle: First doc\ntype: policy\n---\n\nBody one.\n",
    );
    const page = browser.newPage();
    page.mainFrame.window.localStorage.setItem("okf-viewer-empty-view", "overview");
    const { html } = generate(FLAT, resolveConfig({ name: "Flat" }));
    page.content = html;
    await page.waitUntilComplete();
    const panel = panelOf(page);
    expect(panel.querySelector("details.sect")).toBeFalsy();
    expect(panel.querySelector(".fold-all")).toBeFalsy();
    expect(panel.querySelector(".body-md h1")?.textContent).toBe("Flat front page");
    rmSync(FLAT, { recursive: true, force: true });
  });
});
describe("the Overview groups on frontmatter when groupings are configured", () => {
  // owner is uniform (as a young corpus's is), domain and type vary.
  const GROUPED = fileURLToPath(new URL("./fixtures/.grouped-tmp", import.meta.url));
  rmSync(GROUPED, { recursive: true, force: true });
  mkdirSync(path.join(GROUPED, "DOC"), { recursive: true });
  writeFileSync(
    path.join(GROUPED, "index.md"),
    '---\nokf_version: "0.2"\n---\n\n# Corpus front page\n\nHow to read this corpus.\n\n## Everything\n\n* [One](DOC/DOC.001.md)\n',
  );
  const doc = (id: string, type: string, domain: string, owner = "core") =>
    writeFileSync(
      path.join(GROUPED, "DOC", id + ".md"),
      `---\nid: ${id}\ntitle: Doc ${id}\ntype: ${type}\ndomain: ${domain}\nowner: ${owner}\n---\n\nBody.\n`,
    );
  doc("DOC.001", "policy", "api");
  doc("DOC.002", "policy", "api");
  doc("DOC.003", "policy", "platform");
  doc("DOC.004", "guideline", "platform");
  afterAll(() => rmSync(GROUPED, { recursive: true, force: true }));

  const groupedConfig = (overviewGroupings: unknown) =>
    resolveConfig({
      name: "Grouped Corpus",
      facets: ["type"],
      typeLabels: { policy: "must" },
      overviewGroupings,
    });

  const OWNER_FIRST = [
    { label: "Owner + Type", fields: ["owner", "type"] },
    { label: "Owner", fields: ["owner"] },
    { label: "Domain", fields: ["domain"] },
  ];

  async function loadGrouped(groupings: unknown = OWNER_FIRST, stored?: string) {
    const { html } = generate(GROUPED, groupedConfig(groupings));
    const page = browser.newPage();
    page.mainFrame.window.localStorage.setItem("okf-viewer-empty-view", "overview");
    if (stored !== undefined)
      page.mainFrame.window.localStorage.setItem("okf-viewer-overview-group", stored);
    page.content = html;
    await page.waitUntilComplete();
    return page;
  }

  const panelOf = (page: ReturnType<typeof browser.newPage>) =>
    page.mainFrame.document.getElementById("panel") as HTMLElement;
  const top = (panel: HTMLElement) =>
    [...panel.querySelectorAll(".body-md > details.sect")] as HTMLElement[];
  const titles = (list: HTMLElement[]) =>
    list.map((d) => d.querySelector("summary .sect-t")?.textContent);
  const counts = (list: HTMLElement[]) =>
    list.map((d) => d.querySelector("summary .sect-n")?.textContent);

  it("keeps the authored lede and replaces index.md's own sections", async () => {
    const panel = panelOf(await loadGrouped());
    expect(panel.querySelector(".body-md h1")?.textContent).toBe("Corpus front page");
    expect(panel.textContent).toContain("How to read this corpus.");
    // index.md's "## Everything" heading is gone — groups come from frontmatter
    expect(titles(top(panel))).not.toContain("Everything");
  });

  it("nests the second field inside the first, largest group first", async () => {
    const panel = panelOf(await loadGrouped());
    expect(titles(top(panel))).toEqual(["core"]);
    expect(counts(top(panel))).toEqual(["4"]);
    const inner = [...top(panel)[0]!.querySelectorAll("details.sect")] as HTMLElement[];
    // typeLabels annotate the type level; policy (3) outranks guideline (1)
    expect(titles(inner)).toEqual(["policy (must)", "guideline"]);
    expect(counts(inner)).toEqual(["3", "1"]);
    expect(
      [...inner[0]!.querySelectorAll("a[data-go]")].map((a) => (a as HTMLElement).dataset.go),
    ).toEqual(["DOC.001", "DOC.002", "DOC.003"]);
  });

  it("defaults past a grouping whose innermost field does not vary", async () => {
    // "Owner" alone would be one group holding everything, so it is not the
    // default — but a uniform owner as an outer level is fine, and is used.
    const select = panelOf(await loadGrouped()).querySelector(
      ".groupby select",
    ) as HTMLSelectElement;
    expect(select.value).toBe("0");
    const domainFirst = panelOf(
      await loadGrouped([
        { label: "Owner", fields: ["owner"] },
        { label: "Domain", fields: ["domain"] },
      ]),
    );
    expect(
      (domainFirst.querySelector(".groupby select") as HTMLSelectElement).value,
    ).toBe("1");
    expect(titles(top(domainFirst))).toEqual(["api", "platform"]);
  });

  it("switching grouping regroups and is remembered by label", async () => {
    const page = await loadGrouped();
    const select = () =>
      panelOf(page).querySelector(".groupby select") as HTMLSelectElement;
    select().value = "2";
    select().dispatchEvent(new page.mainFrame.window.Event("change", { bubbles: true }));
    expect(titles(top(panelOf(page)))).toEqual(["api", "platform"]);
    expect(
      page.mainFrame.window.localStorage.getItem("okf-viewer-overview-group"),
    ).toBe("Domain");

    // a stored choice beats the adaptive default on the next visit
    const back = await loadGrouped(OWNER_FIRST, "Domain");
    expect(titles(top(panelOf(back)))).toEqual(["api", "platform"]);
  });

  it("without groupings configured it still folds index.md's own headings", async () => {
    const panel = panelOf(await loadGrouped([]));
    expect(panel.querySelector(".groupby")).toBeFalsy();
    expect(panel.querySelector("details.sect")).toBeFalsy(); // one section only
    expect(panel.querySelector(".body-md h2")?.textContent).toBe("Everything");
  });
});

describe("the Index shows configured frontmatter columns", () => {
  async function loadWithColumns() {
    const { html } = generate(
      FIXTURE,
      resolveConfig({
        name: "Fixture Corpus",
        facets: ["type"],
        draft: { field: "lifecycle", value: "draft" },
        indexColumns: ["id", { field: "domain", label: "Domain" }, "title", "citations"],
      }),
    );
    const page = browser.newPage();
    page.content = html;
    await page.waitUntilComplete();
    return page;
  }

  const panelOf = (page: ReturnType<typeof browser.newPage>) =>
    page.mainFrame.document.getElementById("panel") as HTMLElement;
  const cells = (panel: HTMLElement) =>
    [...panel.querySelectorAll("table.rank tbody tr")].map((r) =>
      [...r.querySelectorAll("td")].map((td) => td.textContent),
    );

  it("renders the configured columns in the configured order", async () => {
    const panel = panelOf(await loadWithColumns());
    // built-ins are placeable anywhere: a frontmatter column sits before Title
    expect(
      [...panel.querySelectorAll("table.rank th")].map((th) =>
        th.textContent?.replace(/[\u25b2\u25bc]/, ""),
      ),
    ).toEqual(["ID", "Domain", "Title", "Citations"]);
    expect(cells(panel)[0]).toEqual(["REF.001", "platform", "Gamma guideline", "2"]);
  });

  it("sorts on a configured column, with blanks last", async () => {
    const page = await loadWithColumns();
    (
      panelOf(page).querySelector('[data-sort="f:domain"]') as HTMLButtonElement
    ).click();
    const shown = cells(panelOf(page)).map((r) => [r[0], r[1]]);
    // api before platform; the node with no domain sorts last, not first
    expect(shown).toEqual([
      ["DOC.001", "api"],
      ["DOC.002", "api"],
      ["REF.001", "platform"],
      ["island", "—"],
    ]);
    expect(
      panelOf(page).querySelectorAll("table.rank th")[1]!.getAttribute("aria-sort"),
    ).toBe("ascending");
  });

  it("prepends id when a config names neither id nor title", async () => {
    const { html } = generate(
      FIXTURE,
      resolveConfig({ name: "Fixture Corpus", indexColumns: ["domain"] }),
    );
    const page = browser.newPage();
    page.content = html;
    await page.waitUntilComplete();
    const panel = panelOf(page);
    expect(
      [...panel.querySelectorAll("table.rank th")].map((th) =>
        th.textContent?.replace(/[\u25b2\u25bc]/, ""),
      ),
    ).toEqual(["ID", "domain"]);
    // and the row is still navigable
    expect(
      (panel.querySelector("table.rank tbody a") as HTMLAnchorElement).dataset.go,
    ).toBeTruthy();
  });

  it("columns size themselves until dragged, then keep what you set", async () => {
    const page = await loadWithColumns();
    const panel = panelOf(page);
    const table = panel.querySelector("table.rank") as HTMLElement;
    // untouched: no explicit widths, so the browser sizes each column to fit
    expect(table.style.tableLayout).toBe("");
    expect([...table.querySelectorAll("col")].map((c) => c.style.width)).toEqual([
      "",
      "",
      "",
      "",
    ]);
    const grips = [...panel.querySelectorAll(".col-grip")];
    expect(grips).toHaveLength(3); // none after the last column

    const win = page.mainFrame.window;
    grips[0]!.dispatchEvent(
      new win.MouseEvent("pointerdown", { bubbles: true, clientX: 0 }),
    );
    grips[0]!.dispatchEvent(
      new win.MouseEvent("pointermove", { bubbles: true, clientX: 40 }),
    );
    grips[0]!.dispatchEvent(new win.MouseEvent("pointerup", { bubbles: true }));

    expect(table.style.tableLayout).toBe("fixed");
    const widths = JSON.parse(win.localStorage.getItem("okf-viewer-index-widths")!);
    expect(Object.keys(widths).sort()).toEqual(["citations", "f:domain", "id", "title"]);
    // width came out of the neighbour, so the four still add up to the whole
    const total = Object.values(widths).reduce((a, b) => (a as number) + (b as number), 0);
    expect(total).toBeCloseTo(1, 5);

    // double-click a divider and the automatic widths come back
    grips[0]!.dispatchEvent(new win.Event("dblclick", { bubbles: true }));
    expect(table.style.tableLayout).toBe("");
    expect(win.localStorage.getItem("okf-viewer-index-widths")).toBeNull();
  });

  it("with none configured the Index is ID, Title, Citations", async () => {
    const { html } = generate(FIXTURE, config);
    const page = browser.newPage();
    page.content = html;
    await page.waitUntilComplete();
    expect(
      [...panelOf(page).querySelectorAll("table.rank th")].map((th) =>
        th.textContent?.replace(/[\u25b2\u25bc]/, ""),
      ),
    ).toEqual(["ID", "Title", "Citations"]);
  });
});

describe("bundle-absolute body links (OKF §6.1)", () => {
  const ABS = fileURLToPath(new URL("./fixtures/.absolute-tmp", import.meta.url));
  rmSync(ABS, { recursive: true, force: true });
  mkdirSync(path.join(ABS, "lib", "DOC"), { recursive: true });
  mkdirSync(path.join(ABS, "lib", "REF"), { recursive: true });
  writeFileSync(
    path.join(ABS, "lib", "DOC", "A.md"),
    "---\nid: A\ntitle: A\ntype: policy\n---\n\nSee [B](/lib/REF/B.md).\n",
  );
  writeFileSync(
    path.join(ABS, "lib", "REF", "B.md"),
    "---\nid: B\ntitle: B\ntype: policy\n---\n\nBody.\n",
  );
  afterAll(() => rmSync(ABS, { recursive: true, force: true }));

  it("counts the edge and navigates the link in-pane", async () => {
    const { html } = generate(ABS, resolveConfig({ name: "Absolute" }));
    const page = browser.newPage();
    page.content = html;
    await page.waitUntilComplete();
    const doc = page.mainFrame.document;
    expect(doc.getElementById("stats")?.textContent).toContain("1 citations");
    doc
      .querySelector('circle[data-id="A"]')
      ?.dispatchEvent(new page.mainFrame.window.MouseEvent("click", { bubbles: true }));
    expect(doc.querySelector('#panel .body-md a[data-go="B"]')).toBeTruthy();
  });
});

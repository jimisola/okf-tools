import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Browser,
  type Document,
  type Element,
  type HTMLAnchorElement,
  type HTMLButtonElement,
  type HTMLElement,
  type HTMLInputElement,
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
    // most-cited ranking shown when nothing is selected
    expect(doc.getElementById("panel")?.textContent).toContain("Most cited");
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

describe("details-panel empty state: Overview vs Most cited", () => {
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

  it("defaults to Overview, renders the index body as markdown", async () => {
    const page = await loadIndexed();
    const doc = page.mainFrame.document;
    const panel = doc.getElementById("panel") as HTMLElement;
    expect(tabs(doc).map((b) => b.textContent)).toEqual(["Overview", "Most cited"]);
    expect(tabs(doc).map((b) => b.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
    ]);
    expect(panel.querySelector(".seg")?.getAttribute("role")).toBe("tablist");
    expect(tabs(doc)[0]!.getAttribute("role")).toBe("tab");
    expect(panel.querySelector(".body-md h1")?.textContent).toBe("Bundle overview");
    expect(panel.textContent).toContain("How to read this corpus.");
    expect(panel.textContent).not.toContain("the most cited");
    expect(panel.querySelector("table.rank")).toBeFalsy();
  });

  it("relative .md links in the Overview navigate in-pane; non-concepts stay inert", async () => {
    const page = await loadIndexed();
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

  it("switching to Most cited shows the ranking and persists the choice", async () => {
    const page = await loadIndexed();
    const doc = page.mainFrame.document;
    const panel = doc.getElementById("panel") as HTMLElement;
    tabs(doc)[1]!.click();
    expect(panel.textContent).toContain("Most cited");
    const rows = [...panel.querySelectorAll("table.rank tr")];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("DOC.001");
    expect(panel.querySelector(".body-md")).toBeFalsy();
    expect(tabs(doc).map((b) => b.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
    ]);
    expect(doc.activeElement).toBe(tabs(doc)[1]);
    expect(
      page.mainFrame.window.localStorage.getItem("okf-viewer-empty-view"),
    ).toBe("ranking");
  });

  it("arrow keys move between the two options", async () => {
    const page = await loadIndexed();
    const doc = page.mainFrame.document;
    const panel = doc.getElementById("panel") as HTMLElement;
    expect(tabs(doc).map((b) => b.tabIndex)).toEqual([0, -1]);
    panel.querySelector(".seg")!.dispatchEvent(
      new page.mainFrame.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(panel.querySelector("table.rank")).toBeTruthy();
    expect(tabs(doc).map((b) => b.tabIndex)).toEqual([-1, 0]);
    panel.querySelector(".seg")!.dispatchEvent(
      new page.mainFrame.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    expect(panel.querySelector(".body-md h1")?.textContent).toBe("Bundle overview");
  });

  it("honours a stored choice on a later visit", async () => {
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

  it("a bundle with no index has no toggle and shows the ranking, stored choice or not", async () => {
    for (const stored of [undefined, "overview"]) {
      const { html } = generate(FIXTURE, config);
      const page = browser.newPage();
      if (stored) page.mainFrame.window.localStorage.setItem("okf-viewer-empty-view", stored);
      page.content = html;
      await page.waitUntilComplete();
      const doc = page.mainFrame.document;
      const panel = doc.getElementById("panel") as HTMLElement;
      expect(panel.querySelector(".seg")).toBeFalsy();
      expect(panel.textContent).toContain("Most cited");
      expect(panel.querySelector("table.rank")).toBeTruthy();
      expect(
        JSON.parse(doc.getElementById("viewer-data")!.textContent!).index,
      ).toBeUndefined();
    }
  });
});

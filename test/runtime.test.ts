import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Browser,
  type Document,
  type Element,
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

import { fileURLToPath } from "node:url";
import { Browser, type HTMLButtonElement } from "happy-dom";
import { afterAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { generate } from "../src/generate.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/bundle", import.meta.url));
const config = resolveConfig({
  name: "Dropdowns",
  facets: [
    { key: "type", widget: "dropdown", label: "Type" },
    { key: "domain", widget: "dropdown", label: "Domain" },
    { key: "lifecycle", widget: "dropdown", label: "Lifecycle" },
  ],
  draft: { field: "lifecycle", value: "draft" },
});
const browser = new Browser({
  settings: {
    enableJavaScriptEvaluation: true,
    suppressInsecureJavaScriptEnvironmentWarning: true,
    disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true,
  },
});
afterAll(async () => await browser.close());

describe("multiple dropdown facets", () => {
  it("only one popover open at a time", async () => {
    const { html } = generate(FIXTURE, config);
    const page = browser.newPage();
    page.content = html;
    await page.waitUntilComplete();
    const doc = page.mainFrame.document;
    const btns = [...doc.querySelectorAll(".dd-btn")] as HTMLButtonElement[];
    expect(btns).toHaveLength(3);
    // assert what the user sees: computed display, not just the hidden property
    // (an author `display:flex` rule outranks the UA [hidden] rule).
    const win = page.mainFrame.window as any;
    const visible = () =>
      [...doc.querySelectorAll(".dd-pop")].filter(
        (p) => win.getComputedStyle(p as any).display !== "none",
      );
    const openCount = () => visible().length;
    const press = (b: any) => {
      b.dispatchEvent(new (page.mainFrame.window as any).PointerEvent("pointerdown", { bubbles: true }));
      b.click();
    };
    press(btns[0]);
    expect(openCount()).toBe(1);
    press(btns[1]);
    console.log("after clicking 2nd button, open popovers:", openCount());
    expect(openCount()).toBe(1);
    press(btns[2]);
    expect(openCount()).toBe(1);
  });
});

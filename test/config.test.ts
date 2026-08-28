import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveConfig, searchText } from "../src/config.js";
import type { BundleNode } from "../src/parse.js";

const node = (frontmatter: Record<string, unknown>): BundleNode => ({
  id: "X.1",
  file: "X.1.md",
  frontmatter,
  body: "",
  in: 0,
  out: 0,
});

describe("resolveConfig", () => {
  it("fills every default for {}", () => {
    expect(resolveConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it("keeps explicit values and drops malformed ones", () => {
    const c = resolveConfig({
      name: "My Corpus",
      facets: ["type", "domain", 7],
      draft: { field: "lifecycle", value: "draft" },
      backLink: "../",
      palette: { standard: "#3b82f6" },
    });
    expect(c.name).toBe("My Corpus");
    expect(c.facets).toEqual([{ key: "type" }, { key: "domain" }]);
    expect(c.draft).toEqual({ field: "lifecycle", value: "draft" });
    expect(c.backLink).toBe("../");
    expect(c.palette).toEqual({ standard: "#3b82f6" });
    expect(c.idField).toBe("id"); // untouched default
  });

  it("ignores an incomplete draft rule", () => {
    expect(resolveConfig({ draft: { field: "lifecycle" } }).draft).toBeUndefined();
  });

  it("normalizes facet entries: strings and objects mix", () => {
    const c = resolveConfig({
      facets: [
        "type",
        { key: "domain", widget: "dropdown", label: "Domain" },
        { key: "lifecycle", widget: "chips" },
      ],
    });
    expect(c.facets).toEqual([
      { key: "type" },
      { key: "domain", widget: "dropdown", label: "Domain" },
      { key: "lifecycle", widget: "chips" },
    ]);
  });

  it("drops malformed facet entries and invalid widget/label values", () => {
    const c = resolveConfig({
      facets: [
        { key: "domain", widget: "carousel", label: 7 }, // bad widget + label dropped
        { widget: "chips" }, // no key: entry dropped
        ["type"], // arrays are not facet entries
        null,
      ],
    });
    expect(c.facets).toEqual([{ key: "domain" }]);
  });
});

describe("searchText", () => {
  const fm = {
    id: "X.1",
    title: "Alpha Standard",
    description: "How to name things",
    tags: ["rest", "Naming"],
    appliesWhen: "designing APIs",
    count: 42,
    source: { system: "wiki" },
  };

  it("default (empty searchFields): id, title, plus every string or string-array value", () => {
    const text = searchText(node(fm), DEFAULT_CONFIG);
    expect(text).toContain("x.1");
    expect(text).toContain("alpha standard");
    expect(text).toContain("how to name things");
    expect(text).toContain("naming"); // array member, lowercased
    expect(text).toContain("designing apis");
    expect(text).not.toContain("42"); // numbers are not searched
    expect(text).not.toContain("wiki"); // nested objects are not searched
  });

  it("explicit searchFields limit the searched keys (id always included)", () => {
    const config = { ...DEFAULT_CONFIG, searchFields: ["tags"] };
    const text = searchText(node(fm), config);
    expect(text).toContain("rest");
    expect(text).toContain("x.1");
    expect(text).not.toContain("alpha standard");
  });
});

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveConfig } from "../src/config.js";
import { generate } from "../src/generate.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/bundle", import.meta.url));

describe("generate", () => {
  const config = resolveConfig({
    name: "Fixture Corpus",
    facets: ["type", "domain"],
    draft: { field: "lifecycle", value: "draft" },
  });
  const { html } = generate(FIXTURE, config);

  it("embeds the bundle data and the config as JSON", () => {
    expect(html).toContain('"DOC.001"');
    expect(html).toContain('"Alpha standard"');
    expect(html).toContain("Gamma body."); // markdown bodies travel too
    expect(html).toContain('"Fixture Corpus"');
    expect(html).toContain('"draft":{"field":"lifecycle","value":"draft"}');
  });

  it("is fully self-contained: no script/link/img loads from any URL", () => {
    expect(html).not.toMatch(/<script[^>]*\bsrc\s*=/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(\s*['"]?https?:/i);
  });

  it("inlines marked", () => {
    expect(html).toContain("marked");
    expect(html).toMatch(/marked v\d+\.\d+\.\d+ - a markdown parser/);
  });

  it("escapes </script> sequences in embedded JSON", () => {
    expect(html).not.toContain("</script>alert"); // no way to break out via bodies
    const dataStart = html.indexOf('id="viewer-data"');
    const dataEnd = html.indexOf("</script>", dataStart);
    const json = html.slice(html.indexOf(">", dataStart) + 1, dataEnd);
    expect(json).not.toContain("</");
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("two consecutive builds are byte-identical", () => {
    const again = generate(FIXTURE, config);
    expect(again.html).toBe(html);
  });

  it("works with the bare default config", () => {
    const { html: plain } = generate(FIXTURE, DEFAULT_CONFIG);
    expect(plain).toContain("OKF Bundle");
    expect(plain).not.toContain('"draft":{');
  });
});

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

/** The DOMPurify build the generator inlines, exactly as it appears in a page. */
export const PURIFY_SOURCE = readFileSync(
  path.join(path.dirname(createRequire(import.meta.url).resolve("dompurify")), "purify.min.js"),
  "utf8",
);

const PASS_THROUGH =
  "window.DOMPurify = { isSupported: true, sanitize: (html) => html, addHook: () => {} };";

/**
 * A generated page with the inlined DOMPurify swapped for a pass-through.
 * happy-dom's DOM is not faithful enough for DOMPurify (it drops safe tags and
 * keeps event handlers there), so the happy-dom UI tests use this; the real
 * sanitizer runs in jsdom in test/sanitize.test.ts.
 */
export function withoutSanitizer(html: string): string {
  if (!html.includes(PURIFY_SOURCE)) throw new Error("inlined DOMPurify not found");
  return html.replace(PURIFY_SOURCE, () => PASS_THROUGH);
}

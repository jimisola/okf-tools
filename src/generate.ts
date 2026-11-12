import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { searchText, type ViewerConfig } from "./config.js";
import { parseBundle, type Bundle } from "./parse.js";

const TEMPLATE_DIR = fileURLToPath(new URL("./template/", import.meta.url));
const require = createRequire(import.meta.url);

/** JSON safe to embed inside a <script> element. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * JS source safe to inline inside a <script> element. Only `</script` can
 * terminate the element early; escaping just that sequence keeps regex
 * literals like `/^</` intact (`<\/script` === `</script` in JS strings).
 */
function embedJs(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

function markedSource(): string {
  const pkgDir = path.dirname(require.resolve("marked/package.json"));
  return readFileSync(path.join(pkgDir, "lib", "marked.umd.js"), "utf8");
}

function domPurifySource(): string {
  // dompurify's exports map hides package.json; its main entry sits in dist/.
  const distDir = path.dirname(require.resolve("dompurify"));
  return readFileSync(path.join(distDir, "purify.min.js"), "utf8");
}

/** The executable inline scripts: plain `<script>` elements, not the JSON ones. */
const INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/g;

/**
 * The page's Content-Security-Policy. Scripts run only when their text hashes
 * to one of the page's own inline scripts, so markup that slips into a rendered
 * body cannot run script. Images load only from the page's own origin, and
 * from https: URLs too when the config's `remoteImages` is on.
 * Styles stay inline (the stylesheet and the graph's style attributes).
 */
export function contentSecurityPolicy(
  inlineScripts: string[],
  { remoteImages = false }: { remoteImages?: boolean } = {},
): string {
  const hashes = inlineScripts.map(
    (s) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`,
  );
  return [
    "default-src 'none'",
    `script-src ${hashes.join(" ")}`,
    "style-src 'unsafe-inline'",
    remoteImages ? "img-src 'self' https:" : "img-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}

export interface GenerateResult {
  html: string;
  bundle: Bundle;
}

/**
 * Generate one self-contained HTML page for a parsed bundle: template +
 * CSS + runtime JS + bundle JSON + config JSON + marked + DOMPurify, all
 * inlined, under a Content-Security-Policy that allows only those scripts.
 * The page loads no script or style from any network.
 */
export function generateHtml(bundle: Bundle, config: ViewerConfig): string {
  const data = {
    nodes: bundle.nodes.map((n) => ({
      id: n.id,
      file: n.file,
      frontmatter: n.frontmatter,
      body: n.body,
      in: n.in,
      out: n.out,
      search: searchText(n, config),
    })),
    edges: bundle.edges,
    // The bundle-root index.md, rendered as the panel's "Overview". Absent
    // when the bundle has none, and never a node either way.
    ...(bundle.index ? { index: bundle.index } : {}),
  };

  const html = readFileSync(path.join(TEMPLATE_DIR, "viewer.html"), "utf8");
  const css = readFileSync(path.join(TEMPLATE_DIR, "viewer.css"), "utf8");
  const runtime = readFileSync(path.join(TEMPLATE_DIR, "viewer.js"), "utf8");

  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const page = html
    .split("__TITLE__")
    .join(escapeHtml(config.name))
    .split("/*__CSS__*/")
    .join(css)
    .split("/*__MARKED__*/")
    .join(embedJs(markedSource()))
    .split("/*__DOMPURIFY__*/")
    .join(embedJs(domPurifySource()))
    .split("__DATA__")
    .join(embedJson(data))
    .split("__CONFIG__")
    .join(embedJson(config))
    .split("/*__RUNTIME__*/")
    .join(embedJs(runtime));

  // Last, once every script is final. The placeholder sits in <head>, before
  // any bundle data, so the first occurrence is always the template's own.
  const scripts = [...page.matchAll(INLINE_SCRIPT)].map((m) => m[1] as string);
  const csp = contentSecurityPolicy(scripts, { remoteImages: config.remoteImages === true });
  return page.replace("__CSP__", () => csp);
}

export function generate(bundleDir: string, config: ViewerConfig): GenerateResult {
  const bundle = parseBundle(bundleDir, config.idField, config.relationFields);
  return { html: generateHtml(bundle, config), bundle };
}

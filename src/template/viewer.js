"use strict";
/* Runtime for the OKF bundle graph viewer. Vanilla JS, no network access.
   Frontmatter is always rendered inertly (textContent / createElement).
   Markdown bodies are rendered as HTML via the inlined marked — the bundle
   is trusted input (you render your own corpus). */

const DATA = JSON.parse(document.getElementById("viewer-data").textContent);
const CONFIG = JSON.parse(document.getElementById("viewer-config").textContent);

const nodes = DATA.nodes;
const byId = new Map(nodes.map((n) => [n.id, n]));
const byFile = new Map(nodes.map((n) => [n.file, n]));
const edges = DATA.edges.filter(([s, t]) => byId.has(s) && byId.has(t));
// The bundle-root index.md, if the bundle has one. Not a node: it is the
// bundle's front page, shown as the "Overview" of the empty details panel.
const INDEX = DATA.index || null;

const str = (v) => (typeof v === "string" ? v : "");
const titleOf = (n) => str(n.frontmatter[CONFIG.titleField]) || n.id;
const typeOf = (n) => str(n.frontmatter[CONFIG.typeField]) || "untyped";
const isDraft = (n) =>
  !!CONFIG.draft &&
  String(n.frontmatter[CONFIG.draft.field]) === CONFIG.draft.value;

// ---- colors: config palette, else stable hash-derived HSL ----
function hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
const colorOf = (t) =>
  (CONFIG.palette && CONFIG.palette[t]) || `hsl(${hashHue(t)} 55% 45%)`;

// discovered types: palette-config order first, then the rest sorted
const discovered = [...new Set(nodes.map(typeOf))];
const paletteOrder = Object.keys(CONFIG.palette || {});
const types = [
  ...paletteOrder.filter((t) => discovered.includes(t)),
  ...discovered.filter((t) => !paletteOrder.includes(t)).sort(),
];

// ---- facet values ----
const facetValues = (n, field) => {
  const v = n.frontmatter[field];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  return [];
};
// A facet renders as chips up to this many discovered values, else a dropdown
// (config `widget` overrides either way).
const CHIP_MAX = 8;
const facets = (CONFIG.facets || [])
  .map((f) => (typeof f === "string" ? { key: f } : f)) // tolerate un-normalized config
  .filter((f) => f && typeof f.key === "string")
  .map((f) => {
    const counts = new Map(); // value -> number of publications
    for (const n of nodes) {
      for (const v of facetValues(n, f.key)) {
        counts.set(v, (counts.get(v) || 0) + 1);
      }
    }
    const values = [...counts.keys()].sort();
    return {
      field: f.key,
      label: f.label || f.key,
      widget: f.widget || (values.length <= CHIP_MAX ? "chips" : "dropdown"),
      values,
      counts,
    };
  });

// ---- state ----
// field -> Set of selected values (incl. typeField for the legend).
// Empty/absent set = "all" for that facet. Values OR within a facet,
// facets AND across each other.
const filterState = new Map();
let showDrafts = true;
let selected = null;
let query = "";
let layoutName = "force";

function matchesFilters(n) {
  for (const [field, sel] of filterState) {
    if (!sel || sel.size === 0) continue;
    const vals =
      field === CONFIG.typeField ? [typeOf(n)] : facetValues(n, field);
    if (!vals.some((v) => sel.has(v))) return false;
  }
  return true;
}
const matchesSearch = (n) => !query || n.search.includes(query);
const visible = (n) =>
  n.id === selected ||
  ((showDrafts || !isDraft(n)) && matchesFilters(n) && matchesSearch(n));

// ---- deterministic layouts (no libs, no randomness beyond the seeded LCG) ----
const W = 1200;
const H = 800;

function forceLayout() {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pos = new Map(
    nodes.map((n) => [
      n.id,
      { x: W / 2 + (rnd() - 0.5) * 600, y: H / 2 + (rnd() - 0.5) * 450 },
    ]),
  );
  const iter = 420;
  for (let k = 0; k < iter; k++) {
    const t = 1 - k / iter;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = pos.get(nodes[i].id);
        const b = pos.get(nodes[j].id);
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const d2 = dx * dx + dy * dy || 1;
        if (d2 < 26000) {
          const f = (1300 / d2) * t;
          dx *= f;
          dy *= f;
          a.x += dx;
          a.y += dy;
          b.x -= dx;
          b.y -= dy;
        }
      }
    }
    for (const [s, tg] of edges) {
      const a = pos.get(s);
      const b = pos.get(tg);
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((d - 150) / d) * 0.04 * t;
      a.x += dx * f;
      a.y += dy * f;
      b.x -= dx * f;
      b.y -= dy * f;
    }
    for (const n of nodes) {
      const p = pos.get(n.id);
      p.x += (W / 2 - p.x) * 0.004 * t;
      p.y += (H / 2 - p.y) * 0.004 * t;
      p.x = Math.max(40, Math.min(W - 40, p.x));
      p.y = Math.max(34, Math.min(H - 30, p.y));
    }
  }
  return pos;
}

function concentricLayout() {
  // rings by citations received: most-cited nodes innermost
  const levels = [...new Set(nodes.map((n) => n.in))].sort((a, b) => b - a);
  const rings = levels.map((lv) =>
    nodes.filter((n) => n.in === lv).sort((a, b) => (a.id < b.id ? -1 : 1)),
  );
  const pos = new Map();
  const maxR = Math.min(W, H) / 2 - 60;
  const step = rings.length > 1 ? maxR / (rings.length - 1) : 0;
  rings.forEach((ring, i) => {
    const r = rings.length === 1 ? maxR / 2 : i * step;
    ring.forEach((n, j) => {
      if (r === 0 && ring.length === 1) {
        pos.set(n.id, { x: W / 2, y: H / 2 });
        return;
      }
      const rr = r === 0 ? 30 : r; // several nodes share the center ring
      const angle = (2 * Math.PI * j) / ring.length + i * 0.5;
      pos.set(n.id, {
        x: W / 2 + rr * Math.cos(angle),
        y: H / 2 + (rr * Math.sin(angle) * (H - 100)) / (W - 100),
      });
    });
  });
  return pos;
}

function gridLayout() {
  const sorted = [...nodes].sort((a, b) => (a.id < b.id ? -1 : 1));
  const cols = Math.ceil(Math.sqrt((sorted.length * W) / H));
  const rows = Math.ceil(sorted.length / cols);
  const pos = new Map();
  sorted.forEach((n, i) => {
    pos.set(n.id, {
      x: 70 + ((i % cols) * (W - 140)) / Math.max(cols - 1, 1),
      y: 60 + (Math.floor(i / cols) * (H - 120)) / Math.max(rows - 1, 1),
    });
  });
  return pos;
}

const layoutCache = new Map();
function positions() {
  if (!layoutCache.has(layoutName)) {
    const fn = { force: forceLayout, concentric: concentricLayout, grid: gridLayout }[
      layoutName
    ];
    layoutCache.set(layoutName, fn());
  }
  return layoutCache.get(layoutName);
}

const R = (n) => 7 + Math.min(n.in, 7) * 3;

// ---- svg render (all interpolated data escaped) ----
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const svg = document.getElementById("svg");
svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
const tip = document.getElementById("tip");

function render() {
  const pos = positions();
  const vis = new Set(nodes.filter(visible).map((n) => n.id));
  const neigh = new Set();
  if (selected) {
    for (const [s, t] of edges) {
      if (s === selected) neigh.add(t);
      if (t === selected) neigh.add(s);
    }
  }
  let gE = "";
  let gN = "";
  let gL = "";
  for (const [s, t] of edges) {
    if (!vis.has(s) || !vis.has(t)) continue;
    const a = pos.get(s);
    const b = pos.get(t);
    const hot = selected && (s === selected || t === selected);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const x2 = b.x - (dx / d) * (R(byId.get(t)) + 4);
    const y2 = b.y - (dy / d) * (R(byId.get(t)) + 4);
    gE += `<line x1="${a.x}" y1="${a.y}" x2="${x2}" y2="${y2}"
      stroke="${hot ? "var(--accent)" : "var(--ink-3)"}" stroke-opacity="${selected ? (hot ? 0.9 : 0.12) : 0.35}"
      stroke-width="${hot ? 2 : 1.2}" marker-end="url(#arr${hot ? "H" : ""})"/>`;
  }
  for (const n of nodes) {
    if (!vis.has(n.id)) continue;
    const p = pos.get(n.id);
    const dim = selected && n.id !== selected && !neigh.has(n.id);
    const col = esc(colorOf(typeOf(n)));
    const draft = isDraft(n);
    gN += `<circle data-id="${esc(n.id)}" cx="${p.x}" cy="${p.y}" r="${R(n)}"
      fill="${draft ? "var(--bg)" : col}" stroke="${draft ? col : "var(--bg)"}"
      stroke-width="${draft ? 2 : 1.5}" opacity="${dim ? 0.25 : 1}"
      style="cursor:pointer" tabindex="0" role="button"
      aria-label="${esc(n.id)} ${esc(titleOf(n))}"/>`;
    const labelled =
      n.in >= 2 || n.out >= 3 || n.id === selected || neigh.has(n.id) ||
      layoutName !== "force" || nodes.length <= 40;
    if (labelled) {
      gL += `<text class="node-label ${n.in >= 3 ? "hub" : ""}" x="${p.x}" y="${p.y - R(n) - 15}"
        text-anchor="middle" opacity="${dim ? 0.3 : 1}">${esc(n.id)}</text>`;
      const title = titleOf(n);
      if (title && title !== n.id) {
        gL += `<text class="node-title" x="${p.x}" y="${p.y - R(n) - 5}"
          text-anchor="middle" opacity="${dim ? 0.3 : 1}">${esc(truncate(title, 24))}</text>`;
      }
    }
  }
  svg.innerHTML = `<defs>
    <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,1 L7,4 L0,7" fill="none" stroke="var(--ink-3)" stroke-opacity=".5"/></marker>
    <marker id="arrH" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,1 L7,4 L0,7" fill="none" stroke="var(--accent)"/></marker>
    </defs><g>${gE}</g><g>${gN}</g><g>${gL}</g>`;
  renderPanel();
  renderStats();
}

svg.addEventListener("pointermove", (e) => {
  const c = e.target.closest("circle[data-id]");
  if (!c) {
    tip.hidden = true;
    return;
  }
  const n = byId.get(c.dataset.id);
  tip.textContent = "";
  const idSpan = document.createElement("span");
  idSpan.className = "mono";
  idSpan.textContent = n.id;
  tip.append(idSpan, " " + titleOf(n));
  const r = document.getElementById("stage").getBoundingClientRect();
  tip.hidden = false;
  tip.style.left = Math.min(e.clientX - r.left + 14, r.width - 270) + "px";
  tip.style.top = e.clientY - r.top + 10 + "px";
});
svg.addEventListener("pointerleave", () => (tip.hidden = true));

function activate(e) {
  const c = e.target.closest("circle[data-id]");
  if (!c) return;
  selected = selected === c.dataset.id ? null : c.dataset.id;
  render();
}
svg.addEventListener("click", activate);
svg.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    activate(e);
  }
});

// ---- detail pane (frontmatter rendered inertly, body via marked) ----
const panel = document.getElementById("panel");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function goLink(id, title) {
  const a = el("a", null);
  a.href = "#";
  a.dataset.go = id;
  a.append(el("span", "mono", id), el("span", "t", title));
  return a;
}

function refList(ids) {
  if (!ids.length) return el("p", "empty", "none");
  const ul = el("ul", "refs");
  for (const id of ids) {
    const li = el("li");
    li.append(goLink(id, titleOf(byId.get(id))));
    ul.append(li);
  }
  return ul;
}

// Only absolute http(s) URLs ever become links. Everything else — javascript:,
// data:, mailto:, relative paths, arbitrary strings — stays inert text.
const HTTP_URL = /^https?:\/\/[^\s<>"]+$/i;
const isHttpUrl = (v) => typeof v === "string" && HTTP_URL.test(v.trim());

// Link text: the URL without its scheme, elided in the middle when long. The
// full URL stays in `title` (and in href).
function shortUrl(u, max = 46) {
  const bare = u.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (bare.length <= max) return bare;
  const slash = bare.indexOf("/");
  const host = slash === -1 ? bare : bare.slice(0, slash);
  const rest = slash === -1 ? "" : bare.slice(slash);
  const keep = Math.max(10, max - host.length - 2);
  return host + "/…" + rest.slice(-keep);
}

function urlLink(value) {
  const url = value.trim();
  const a = el("a", "ext", shortUrl(url));
  a.href = url;
  a.title = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

const SVG_NS = "http://www.w3.org/2000/svg";

// Built with createElementNS/setAttribute — never innerHTML — same rule as
// every other DOM node in this file.
function svgIcon(pathData) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  for (const d of pathData) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

const ICON_PATHS = {
  github: [
    "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z",
  ],
  external: [
    "M6.22 8.72a.75.75 0 0 0 1.06 1.06l5.22-5.22v1.69a.75.75 0 0 0 1.5 0v-3.5a.75.75 0 0 0-.75-.75h-3.5a.75.75 0 0 0 0 1.5h1.69L6.22 8.72Z",
    "M3.75 3A.75.75 0 0 0 3 3.75v9.5c0 .414.336.75.75.75h9.5a.75.75 0 0 0 .75-.75V9.75a.75.75 0 0 0-1.5 0V12.5H4.5v-8h2.75a.75.75 0 0 0 0-1.5h-3.5Z",
  ],
};

// A node's "View source" link, built from CONFIG.sourceBaseUrl + n.file. The
// icon and label reflect the actual host — a GitHub mark for github.com,
// a generic external-link glyph for anything else — so it never claims
// "GitHub" for a source hosted somewhere it isn't. Parsed and protocol-
// checked rather than regex-tested: `href` is set from the *parsed* URL,
// never the raw concatenated string, so a misconfigured (relative,
// scheme-less, or javascript:) sourceBaseUrl renders nothing.
function sourceLink(n) {
  let parsed;
  try {
    parsed = new URL(CONFIG.sourceBaseUrl + n.file);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const isGitHub = parsed.hostname.replace(/^www\./, "") === "github.com";
  const a = el("a", "ext src-link");
  a.href = parsed.href;
  a.title = "This publication's file in the bundle's source repository";
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  const icon = el("span", "src-icon");
  icon.append(svgIcon(isGitHub ? ICON_PATHS.github : ICON_PATHS.external));
  // The link text is the filename, not a "source" word — a bundle's own
  // frontmatter often has source/sources provenance fields already, and
  // this link isn't provenance, it's just "here is the file you're reading".
  a.append(icon, document.createTextNode(n.file.split("/").pop()));
  return a;
}

// A frontmatter scalar as a DOM node: an anchor for http(s) URLs, plain text
// otherwise. Built with createElement/textContent — never innerHTML.
function scalarNode(value) {
  if (isHttpUrl(value)) return urlLink(value);
  return document.createTextNode(
    typeof value === "object" && value !== null ? JSON.stringify(value) : String(value),
  );
}

function objectEntries(target, obj) {
  for (const [k, x] of Object.entries(obj)) {
    const sub = el("span", "sub");
    sub.append(el("span", "sk", k + ": "), scalarNode(x));
    target.append(sub);
  }
}

function metaValue(value) {
  const v = el("span", "v");
  if (value == null) {
    v.append(el("span", "empty", "—"));
  } else if (Array.isArray(value)) {
    if (value.length === 0) {
      v.append(el("span", "empty", "[]"));
    } else if (value.every((x) => typeof x === "string")) {
      const chips = el("span", "chips");
      for (const x of value) {
        const chip = el("span");
        chip.append(scalarNode(x));
        chips.append(chip);
      }
      v.append(chips);
    } else {
      for (const x of value) {
        if (x !== null && typeof x === "object" && !Array.isArray(x)) {
          const item = el("span", "item");
          objectEntries(item, x);
          v.append(item);
        } else {
          const item = el("span", "sub");
          item.append(scalarNode(x));
          v.append(item);
        }
      }
    }
  } else if (typeof value === "object") {
    objectEntries(v, value);
  } else if (isHttpUrl(value)) {
    v.append(urlLink(value));
  } else {
    v.textContent = String(value);
  }
  return v;
}

function resolveBodyLink(fromFile, href) {
  if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return null;
  let p;
  try {
    p = decodeURIComponent(href.split("#")[0]);
  } catch {
    return null;
  }
  if (!p.endsWith(".md")) return null;
  // A leading "/" is bundle-absolute (OKF §6.1): resolve from the root.
  const parts = p.startsWith("/") ? [] : fromFile.split("/").slice(0, -1);
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return byFile.get(parts.join("/")) || null;
}

/**
 * A markdown body rendered to HTML, with its relative `.md` links rewired to
 * in-pane navigation. `fromFile` is the bundle-relative path the links are
 * resolved against — used for concept bodies and for the bundle index alike.
 */
function renderMarkdownBody(fromFile, markdown) {
  const body = el("div", "body-md");
  // Trusted input: the bundle is your own corpus (see README).
  body.innerHTML = marked.parse(markdown);
  for (const a of body.querySelectorAll("a[href]")) {
    const target = resolveBodyLink(fromFile, a.getAttribute("href"));
    if (target) a.dataset.go = target.id;
    else if (/^[a-z][a-z0-9+.-]*:/i.test(a.getAttribute("href"))) {
      a.target = "_blank";
      a.rel = "noopener";
    }
  }
  return body;
}

// ---- empty state: the Index, or the bundle Overview ----
const EMPTY_VIEWS = ["overview", "index"];
const EMPTY_VIEW_KEY = "okf-viewer-empty-view";
const EMPTY_VIEW_LABELS = { overview: "Overview", index: "Index" };
// "ranking" was this view before it became a searchable, sortable index —
// map a stored choice forward rather than silently dropping it.
const LEGACY_EMPTY_VIEWS = { ranking: "index" };

// The Index by default: most visits are a lookup, and the Overview is one
// click away and remembered once chosen.
let emptyView = "index";
try {
  const saved = localStorage.getItem(EMPTY_VIEW_KEY);
  const view = LEGACY_EMPTY_VIEWS[saved] || saved;
  if (EMPTY_VIEWS.includes(view)) emptyView = view;
} catch {
  /* storage unavailable */
}
if (!INDEX) emptyView = "index";

// Also the way out of a selected node: picking a view clears the selection,
// so the toggle at the top of the panel is always a way back to the corpus.
function setEmptyView(view) {
  const hadSelection = selected !== null;
  selected = null;
  emptyView = view;
  try {
    localStorage.setItem(EMPTY_VIEW_KEY, view);
  } catch {
    /* storage unavailable */
  }
  // A selection also colours the graph, so that has to be redrawn too.
  if (hadSelection) render();
  else renderPanel();
  panel.scrollTop = 0;
  const btn = panel.querySelector('[data-empty-view="' + view + '"]');
  if (btn) btn.focus();
}

/** The two-option segmented control — null when the bundle has no index.md. */
function emptyViewToggle() {
  if (!INDEX) return null;
  const tabs = el("div", "seg");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Details panel view");
  for (const view of EMPTY_VIEWS) {
    const b = el("button", "seg-opt", EMPTY_VIEW_LABELS[view]);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.dataset.emptyView = view;
    // While a node is open neither view is showing, so neither is selected —
    // but the one you would return to stays in the tab order.
    const current = view === emptyView;
    b.setAttribute("aria-selected", String(current && !selected));
    // roving tabindex: only the current option is in the tab order
    b.tabIndex = current ? 0 : -1;
    b.addEventListener("click", () => {
      if (view !== emptyView || selected) setEmptyView(view);
    });
    tabs.append(b);
  }
  tabs.addEventListener("keydown", (e) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const i = EMPTY_VIEWS.indexOf(emptyView);
    setEmptyView(EMPTY_VIEWS[(i + dir + EMPTY_VIEWS.length) % EMPTY_VIEWS.length]);
  });
  return tabs;
}

// ---- Overview: an index.md is a front page, and front pages grow ----
// Once a corpus covers several practices the index is pages long, and a wall
// of prose is the one thing an overview must not be. So each top section
// folds: closed you see the shape of the corpus, open you read one part of
// it. Which sections are open is remembered per reader.
const OVERVIEW_OPEN_KEY = "okf-viewer-overview-open";

let overviewOpen = new Set();
try {
  const saved = JSON.parse(localStorage.getItem(OVERVIEW_OPEN_KEY));
  if (Array.isArray(saved)) overviewOpen = new Set(saved.filter((k) => typeof k === "string"));
} catch {
  /* storage unavailable or corrupt */
}
function persistOverviewOpen() {
  try {
    localStorage.setItem(OVERVIEW_OPEN_KEY, JSON.stringify([...overviewOpen]));
  } catch {
    /* storage unavailable */
  }
}

const headingLevel = (node) =>
  /^H[1-6]$/.test(node.tagName) ? Number(node.tagName[1]) : 0;

/**
 * Fold a rendered body into <details> at its shallowest sub-heading level —
 * h2 under an h1 title, h3 under h2, whatever the document actually uses.
 * Anything before the first such heading stays open as the lede. Returns
 * null when there is nothing worth folding (no sections, or only one).
 */
function foldSections(body) {
  const kids = [...body.children];
  const levels = kids.map(headingLevel).filter(Boolean);
  if (!levels.length) return null;
  const top = Math.min(...levels);
  const sub = levels.filter((l) => l > top);
  // A document whose only headings are all at one level sections on that
  // level; otherwise section on the shallowest level below the title.
  const level = sub.length ? Math.min(...sub) : top;
  const starts = kids.filter((k) => headingLevel(k) === level);
  if (starts.length < 2) return null;

  const folded = el("div", "body-md");
  let current = null;
  for (const kid of kids) {
    if (headingLevel(kid) === level) {
      const key = kid.textContent.trim();
      const details = foldableSection(key, key);
      folded.append(details);
      current = details;
      continue;
    }
    (current || folded).append(kid);
  }

  // A closed section should still say how much is in it.
  for (const details of folded.querySelectorAll("details.sect")) {
    const items = details.querySelectorAll("li").length;
    if (items) details.querySelector("summary").append(el("span", "sect-n", String(items)));
  }
  return folded;
}

function foldAllButton() {
  // a chip, like every other small action on the page
  const btn = el("button", "chip fold-all");
  btn.type = "button";
  btn.addEventListener("click", () => {
    const open = btn.dataset.foldAll === "expand";
    for (const d of panel.querySelectorAll("details.sect")) {
      if (d.open !== open) d.open = open; // fires toggle, which persists
    }
    syncFoldAll();
  });
  return btn;
}

/** Keep the expand/collapse-all button honest as individual sections toggle. */
function syncFoldAll() {
  const btn = panel.querySelector(".fold-all");
  if (!btn) return;
  const all = [...panel.querySelectorAll("details.sect")];
  const allOpen = all.length > 0 && all.every((d) => d.open);
  btn.textContent = allOpen ? "Collapse all" : "Expand all";
  btn.dataset.foldAll = allOpen ? "collapse" : "expand";
}

// ---- Overview groupings: sections built from frontmatter, not headings ----
// Configured, never hardcoded: this package does not know what an "owner" is.
const GROUPINGS = CONFIG.overviewGroupings || [];
const GROUP_KEY = "okf-viewer-overview-group";
const NO_VALUE = "(unspecified)";

const groupingLabel = (g) => g.label || g.fields.join(" + ");
const distinctCount = (field) => {
  const seen = new Set();
  for (const n of nodes) for (const v of facetValues(n, field)) seen.add(v);
  return seen.size;
};

// Adaptive: the first grouping whose innermost field actually varies. An
// outer level that is uniform today is still worth keeping — one owner is a
// stable parent that gains siblings later — but a leaf level with a single
// value groups nothing, so such a grouping is skipped as the default.
function defaultGrouping() {
  const leafVaries = (g) => distinctCount(g.fields[g.fields.length - 1]) > 1;
  const i = GROUPINGS.findIndex(leafVaries);
  return i >= 0 ? i : 0;
}

let grouping = defaultGrouping();
try {
  const saved = localStorage.getItem(GROUP_KEY);
  const i = GROUPINGS.findIndex((g) => groupingLabel(g) === saved);
  if (i >= 0) grouping = i; // a stored choice always beats the adaptive one
} catch {
  /* storage unavailable */
}

/** value -> members, largest group first, ties alphabetical. */
function groupBy(list, field) {
  const map = new Map();
  for (const n of list) {
    const values = facetValues(n, field);
    for (const v of values.length ? values : [NO_VALUE]) {
      if (!map.has(v)) map.set(v, []);
      map.get(v).push(n);
    }
  }
  return [...map.entries()].sort(
    (a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1),
  );
}

function foldableSection(key, title, count) {
  const details = el("details", "sect");
  details.open = overviewOpen.has(key);
  const summary = el("summary");
  summary.append(el("span", "sect-t", title));
  if (count !== undefined) summary.append(el("span", "sect-n", String(count)));
  details.append(summary);
  details.addEventListener("toggle", () => {
    if (details.open) overviewOpen.add(key);
    else overviewOpen.delete(key);
    persistOverviewOpen();
    syncFoldAll();
  });
  return details;
}

/** One grouping level per field, nested; the innermost holds the links. */
function renderGroups(parent, list, fields, path) {
  for (const [value, members] of groupBy(list, fields[0])) {
    const trail = path.concat(value);
    const details = foldableSection(
      trail.join(" \u203a "),
      groupTitle(fields[0], value),
      members.length,
    );
    if (fields.length > 1) renderGroups(details, members, fields.slice(1), trail);
    else {
      details.append(
        refList([...members].sort((a, b) => (a.id < b.id ? -1 : 1)).map((n) => n.id)),
      );
    }
    parent.append(details);
  }
}

/** The authored part of index.md: everything above its first section heading. */
function ledeOf(body) {
  const kids = [...body.children];
  const levels = kids.map(headingLevel).filter(Boolean);
  if (!levels.length) return body;
  const top = Math.min(...levels);
  const sub = levels.filter((l) => l > top);
  const level = sub.length ? Math.min(...sub) : top;
  const lede = el("div", "body-md");
  for (const kid of kids) {
    if (headingLevel(kid) === level) break;
    lede.append(kid);
  }
  return lede;
}

/** `standard` reads better as `standard (must)` where the config says so. */
function groupTitle(field, value) {
  return field === CONFIG.typeField && CONFIG.typeLabels[value]
    ? value + " (" + CONFIG.typeLabels[value] + ")"
    : value;
}

function groupByControl() {
  const wrap = el("div", "groupby");
  const id = "groupby-select";
  const label = el("label", null, "Group by");
  label.htmlFor = id;
  const select = el("select");
  select.id = id;
  GROUPINGS.forEach((g, i) => {
    const opt = el("option", null, groupingLabel(g));
    opt.value = String(i);
    if (i === grouping) opt.selected = true;
    select.append(opt);
  });
  select.addEventListener("change", () => {
    grouping = Number(select.value);
    try {
      localStorage.setItem(GROUP_KEY, groupingLabel(GROUPINGS[grouping]));
    } catch {
      /* storage unavailable */
    }
    renderPanel();
    panel.scrollTop = 0;
    const again = panel.querySelector("#" + id);
    if (again) again.focus();
  });
  wrap.append(label, select);
  return wrap;
}

function renderOverview() {
  panel.append(el("h2", null, "Overview"));
  const body = renderMarkdownBody("index.md", INDEX.body);

  // Configured groupings replace index.md's own sections with groups built
  // from frontmatter; its lede is authored prose, so it stays either way.
  if (GROUPINGS.length) {
    panel.append(ledeOf(body));
    const bar = el("div", "ovbar");
    bar.append(groupByControl(), foldAllButton());
    const groups = el("div", "body-md");
    renderGroups(groups, nodes, GROUPINGS[grouping].fields, []);
    panel.append(bar, groups);
    syncFoldAll();
    return;
  }

  const folded = foldSections(body);
  if (!folded) {
    panel.append(body);
    return;
  }

  const bar = el("div", "ovbar");
  bar.append(foldAllButton());
  panel.append(bar, folded);
  syncFoldAll();
}

// ---- the Index: what the graph is showing, as a sortable table ----
// One filter state for the whole page: the header search and the facet
// controls drive this table exactly as they drive the graph, so the Index is
// a live reading of what is on screen rather than a second, competing filter.
// `dir` is the direction a column sorts on first click: identifiers and
// titles read best ascending, a citation count most-cited-first.
// The Index's columns, in configured order — `id`, `title` and `citations`
// are built in, anything else is a frontmatter key. `dir` is the direction a
// column takes on first click: identifiers and words read best ascending, a
// count most-first.
const fieldText = (n, field) => facetValues(n, field).join(", ");
const BUILTIN_COLUMNS = {
  id: { label: "ID", dir: 1, value: (n) => n.id.toLowerCase() },
  title: { label: "Title", dir: 1, value: (n) => titleOf(n).toLowerCase() },
  citations: { label: "Citations", dir: -1, num: true, value: (n) => n.in },
};

const INDEX_SORTS = {};
{
  const configured = (CONFIG.indexColumns || []).map((c) =>
    typeof c === "string" ? { field: c } : c,
  );
  const columns = configured.length
    ? configured
    : [{ field: "id" }, { field: "title" }, { field: "citations" }];
  // A row has to be navigable, so there is always something to click.
  if (!columns.some((c) => c.field === "id" || c.field === "title")) {
    columns.unshift({ field: "id" });
  }
  for (const col of columns) {
    const builtin = BUILTIN_COLUMNS[col.field];
    if (builtin) {
      INDEX_SORTS[col.field] = { ...builtin, kind: col.field };
      if (col.label) INDEX_SORTS[col.field].label = col.label;
      continue;
    }
    INDEX_SORTS["f:" + col.field] = {
      label: col.label || col.field,
      dir: 1,
      kind: "field",
      field: col.field,
      // blanks sort last rather than clumping at the top of an ascending sort
      value: (n) => fieldText(n, col.field).toLowerCase() || "\uffff",
    };
  }
}

const INDEX_SORT_KEY = "okf-viewer-index-sort";

// Citations desc is the default — it is what this view showed when it was
// the "Most cited" ranking. A config without that column sorts on its first.
let indexSort = { key: INDEX_SORTS.citations ? "citations" : Object.keys(INDEX_SORTS)[0], dir: -1 };
try {
  const [key, dir] = String(localStorage.getItem(INDEX_SORT_KEY)).split(":");
  if (INDEX_SORTS[key] && (dir === "1" || dir === "-1")) {
    indexSort = { key, dir: Number(dir) };
  }
} catch {
  /* storage unavailable */
}

/** Visible rows in sort order. Ties break on id so the order is total. */
function indexRows() {
  const rows = nodes.filter(visible);
  const { value } = INDEX_SORTS[indexSort.key];
  return rows.sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    if (av < bv) return -indexSort.dir;
    if (av > bv) return indexSort.dir;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---- column widths ----
// Untouched, the table lays out automatically, so a column of short codes
// stays narrow and one of longer names grows on its own. Drag a
// header divider and the widths become yours instead, kept as fractions so
// they survive resizing the panel; double-click a divider to hand them back.
const INDEX_WIDTH_KEY = "okf-viewer-index-widths";
let indexWidths = null;
try {
  const saved = JSON.parse(localStorage.getItem(INDEX_WIDTH_KEY));
  if (saved && typeof saved === "object") {
    const keys = Object.keys(INDEX_SORTS);
    const ok = keys.every((k) => typeof saved[k] === "number" && saved[k] > 0);
    if (ok && Object.keys(saved).length === keys.length) indexWidths = saved;
  }
} catch {
  /* storage unavailable or corrupt */
}

function persistIndexWidths() {
  try {
    if (indexWidths) localStorage.setItem(INDEX_WIDTH_KEY, JSON.stringify(indexWidths));
    else localStorage.removeItem(INDEX_WIDTH_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Current fractions: whatever is stored, else what is on screen, else even. */
function currentWidths(table) {
  if (indexWidths) return { ...indexWidths };
  const keys = Object.keys(INDEX_SORTS);
  const heads = [...table.querySelectorAll("th")];
  const measured = heads.map((th) => th.getBoundingClientRect().width);
  const total = measured.reduce((a, b) => a + b, 0);
  const widths = {};
  keys.forEach((k, i) => {
    widths[k] = total > 0 ? measured[i] / total : 1 / keys.length;
  });
  return widths;
}

const MIN_COL = 0.06;

function resizeColumn(table, key, deltaFraction) {
  if (!Number.isFinite(deltaFraction)) return;
  const keys = Object.keys(INDEX_SORTS);
  const i = keys.indexOf(key);
  const next = keys[i + 1];
  if (!next) return;
  const widths = currentWidths(table);
  // Take from the neighbour so the table keeps its width — the panel is
  // narrow enough that growing the whole table would just cause overflow.
  const room = widths[key] + widths[next];
  const wanted = Math.min(Math.max(widths[key] + deltaFraction, MIN_COL), room - MIN_COL);
  widths[key] = wanted;
  widths[next] = room - wanted;
  indexWidths = widths;
  persistIndexWidths();
  applyIndexWidths(table);
}

function applyIndexWidths(table) {
  const cols = [...table.querySelectorAll("col")];
  if (!indexWidths) {
    table.style.tableLayout = "";
    for (const c of cols) c.style.width = "";
    return;
  }
  table.style.tableLayout = "fixed";
  Object.keys(INDEX_SORTS).forEach((k, i) => {
    if (cols[i]) cols[i].style.width = (indexWidths[k] * 100).toFixed(3) + "%";
  });
}

function columnGrip(table, key) {
  const grip = el("span", "col-grip");
  grip.setAttribute("aria-hidden", "true");
  let startX = null;
  grip.addEventListener("pointerdown", (e) => {
    if (!Number.isFinite(e.clientX)) return;
    startX = e.clientX;
    if (grip.setPointerCapture) grip.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation(); // never a sort click
  });
  grip.addEventListener("pointermove", (e) => {
    if (startX === null || !Number.isFinite(e.clientX)) return;
    const width = table.getBoundingClientRect().width || 1;
    resizeColumn(table, key, (e.clientX - startX) / width);
    startX = e.clientX;
  });
  const end = () => {
    startX = null;
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
  grip.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    indexWidths = null;
    persistIndexWidths();
    applyIndexWidths(table);
  });
  return grip;
}

function sortIndexBy(key) {
  indexSort =
    key === indexSort.key
      ? { key, dir: -indexSort.dir }
      : { key, dir: INDEX_SORTS[key].dir };
  try {
    localStorage.setItem(INDEX_SORT_KEY, indexSort.key + ":" + indexSort.dir);
  } catch {
    /* storage unavailable */
  }
  renderPanel();
  const btn = panel.querySelector('[data-sort="' + key + '"]');
  if (btn) btn.focus();
}

/** True when nothing is filtered and nothing is selected — the whole corpus. */
function isDefaultView() {
  if (selected || query || !showDrafts) return false;
  for (const sel of filterState.values()) if (sel && sel.size) return false;
  return true;
}

/**
 * Back to the whole corpus: drop the selection, the search, the facets and
 * the drafts toggle. Deliberately leaves preferences alone — layout, theme,
 * Index sort, which Overview sections are open — those are how you like to
 * read, not the state you got lost in.
 */
function resetView() {
  selected = null;
  query = "";
  const box = document.getElementById("search");
  if (box) box.value = "";
  filterState.clear();
  showDrafts = true;
  renderControls();
  render();
  panel.scrollTop = 0;
}

function renderIndex() {
  panel.append(el("h2", null, "Index"));

  const table = el("table", "rank");
  const colgroup = el("colgroup");
  for (const _ of Object.keys(INDEX_SORTS)) colgroup.append(el("col"));
  table.append(colgroup);
  const head = el("tr");
  const keys = Object.keys(INDEX_SORTS);
  for (const key of keys) {
    const th = el("th", INDEX_SORTS[key].num ? "num" : null);
    th.scope = "col";
    const active = key === indexSort.key;
    th.setAttribute(
      "aria-sort",
      active ? (indexSort.dir === 1 ? "ascending" : "descending") : "none",
    );
    const b = el("button", "sort", INDEX_SORTS[key].label);
    b.type = "button";
    b.dataset.sort = key;
    if (active) b.append(el("span", "arrow", indexSort.dir === 1 ? "\u25b2" : "\u25bc"));
    b.addEventListener("click", () => sortIndexBy(key));
    th.append(b);
    // no divider after the last column: there is nothing to trade width with
    if (key !== keys[keys.length - 1]) th.append(columnGrip(table, key));
    head.append(th);
  }
  const thead = el("thead");
  thead.append(head);
  const tbody = el("tbody");
  table.append(thead, tbody);
  applyIndexWidths(table);

  const rows = indexRows();
  // The id navigates; where no id column is configured, the title does.
  const linkOn = INDEX_SORTS.id ? "id" : "title";
  for (const n of rows) {
    const tr = el("tr");
    for (const col of Object.values(INDEX_SORTS)) {
      const td = el("td", col.kind === "citations" ? "num" : col.kind === "field" ? "dim" : null);
      const text =
        col.kind === "id"
          ? n.id
          : col.kind === "title"
            ? titleOf(n)
            : col.kind === "citations"
              ? String(n.in)
              : fieldText(n, col.field) || "—";
      if (col.kind === linkOn) {
        const a = el("a");
        a.href = "#";
        a.dataset.go = n.id;
        a.append(el("span", col.kind === "id" ? "mono" : null, text));
        td.append(a);
      } else {
        td.textContent = text;
      }
      tr.append(td);
    }
    tbody.append(tr);
  }
  panel.append(table);

  // The filter lives in the header, far from the rows it acts on. Say here
  // what it is doing, and let it be undone from here.
  const filtered = rows.length !== nodes.length;
  const status = el("p", "idx-status");
  status.append(
    el(
      "span",
      null,
      filtered
        ? rows.length + " of " + nodes.length + " publications"
        : nodes.length + " publications",
    ),
  );
  if (filtered) {
    const clear = el("button", "idx-clear", "Clear filters");
    clear.type = "button";
    clear.addEventListener("click", resetView);
    status.append(clear);
  }
  panel.append(status);

  if (!rows.length) {
    panel.append(
      el("p", "empty", "Nothing matches the current search and filters."),
    );
  }

  const hint = el(
    "p",
    "empty",
    "Click a node for impact analysis — what it cites, and what would be affected if it changed.",
  );
  hint.style.marginTop = "14px";
  panel.append(hint);
}

function renderPanel() {
  panel.textContent = "";
  // The toggle sits at the top whatever the panel is showing: a publication's
  // document and citation lists can run long, and a way back that is only at
  // the far bottom is not a way back you can see.
  const tabs = emptyViewToggle();
  if (tabs) panel.append(tabs);
  if (!selected) {
    if (emptyView === "overview" && INDEX) renderOverview();
    else renderIndex();
    return;
  }
  if (!tabs) {
    // No index.md, so no toggle — one plain way back to the Index.
    const up = el("button", "chip back-top", "← " + EMPTY_VIEW_LABELS.index);
    up.dataset.go = "";
    panel.append(up);
  }

  const n = byId.get(selected);
  panel.append(el("p", "pid mono", n.id), el("p", "ptitle", titleOf(n)));
  if (CONFIG.sourceBaseUrl) {
    const link = sourceLink(n);
    if (link) panel.append(link);
  }

  const meta = el("div", "meta");
  const type = typeOf(n);
  const badgeWrap = el("span", "v");
  const badge = el("span", "badge", type + (CONFIG.typeLabels[type] ? ` (${CONFIG.typeLabels[type]})` : ""));
  badge.style.background = colorOf(type);
  badgeWrap.append(badge);
  meta.append(el("span", "k", CONFIG.typeField), badgeWrap);
  for (const [k, v] of Object.entries(n.frontmatter)) {
    if (k === CONFIG.idField || k === CONFIG.titleField || k === CONFIG.typeField)
      continue;
    meta.append(el("span", "k", k), metaValue(v));
  }
  panel.append(meta);

  if (n.body.trim()) {
    panel.append(el("h2", null, "Document"), renderMarkdownBody(n.file, n.body));
  }

  const cites = [...new Set(edges.filter(([s]) => s === selected).map(([, t]) => t))];
  const citedBy = [...new Set(edges.filter(([, t]) => t === selected).map(([s]) => s))];
  panel.append(el("h2", null, `Cites (${cites.length})`), refList(cites));
  panel.append(
    el("h2", null, `Cited by (${citedBy.length}) — impact if this changes`),
    refList(citedBy),
  );

  const back = el("button", "chip", "← back to " + EMPTY_VIEW_LABELS[emptyView].toLowerCase());
  back.dataset.go = "";
  panel.append(back);
}

panel.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]");
  if (!go) return;
  e.preventDefault();
  selected = go.dataset.go || null;
  render();
  panel.scrollTop = 0;
});

// ---- stats ----
// Counts describe what is on screen. Unfiltered they are the corpus totals;
// filtered they read "12 of 200", because a number that silently means
// something other than what you are looking at is worse than no number.
function renderStats() {
  const reset = document.getElementById("reset");
  if (reset) reset.hidden = isDefaultView();
  const stats = document.getElementById("stats");
  stats.textContent = "";
  const shown = nodes.filter(visible);
  const shownIds = new Set(shown.map((n) => n.id));
  const shownEdges = edges.filter(([s, t]) => shownIds.has(s) && shownIds.has(t));
  const linked = new Set(shownEdges.flat());
  const filtered = shown.length !== nodes.length;

  const stat = (value, total, label) => {
    const s = el("span");
    s.append(el("b", null, String(value)));
    if (filtered) s.append(" of " + total);
    s.append(" " + label);
    stats.append(s);
  };
  stat(shown.length, nodes.length, "publications");
  stat(shownEdges.length, edges.length, "citations");
  stat(
    shown.filter((n) => !linked.has(n.id)).length,
    nodes.filter((n) => n.in === 0 && n.out === 0).length,
    "islands",
  );
  if (CONFIG.draft) {
    stat(shown.filter(isDraft).length, nodes.filter(isDraft).length, "drafts");
  }
}

// ---- filters: legend + facet widgets share state ----
function selection(field) {
  let sel = filterState.get(field);
  if (!sel) {
    sel = new Set();
    filterState.set(field, sel);
  }
  return sel;
}

function toggleFilter(field, value) {
  const sel = selection(field);
  if (sel.has(value)) sel.delete(value);
  else sel.add(value);
  syncFilterUI();
  render();
}

function clearFilter(field) {
  selection(field).clear();
  syncFilterUI();
  render();
}

const dropdowns = []; // {field, label, btn, pop, boxes}

function syncFilterUI() {
  for (const b of document.querySelectorAll("[data-facet]")) {
    const sel = filterState.get(b.dataset.facet);
    const active = b.dataset.value
      ? !!sel && sel.has(b.dataset.value)
      : !sel || sel.size === 0; // the "all" chip
    b.setAttribute("aria-pressed", String(active));
  }
  for (const b of document.querySelectorAll("[data-legend-type]")) {
    const sel = filterState.get(CONFIG.typeField);
    b.setAttribute(
      "aria-pressed",
      String(!!sel && sel.has(b.dataset.legendType)),
    );
  }
  for (const dd of dropdowns) {
    const sel = filterState.get(dd.field);
    const count = sel ? sel.size : 0;
    dd.btn.textContent =
      dd.label + ": " + (count === 0 ? "all" : count + " selected");
    for (const box of dd.boxes) box.checked = !!sel && sel.has(box.value);
  }
}

function closeDropdown(dd, refocus) {
  if (dd.pop.hidden) return;
  dd.pop.hidden = true;
  dd.btn.setAttribute("aria-expanded", "false");
  if (refocus) dd.btn.focus();
}

document.addEventListener(
  "pointerdown",
  (e) => {
    for (const dd of dropdowns) {
      if (!dd.root.contains(e.target)) closeDropdown(dd, false);
    }
  },
  true,
);

function renderLegend() {
  const legend = document.getElementById("legend");
  legend.textContent = "";
  for (const t of types) {
    const b = el("button");
    b.dataset.legendType = t;
    b.setAttribute("aria-pressed", "false");
    const dot = el("span", "dot");
    dot.style.background = colorOf(t);
    b.append(dot, t);
    if (CONFIG.typeLabels[t]) {
      const lab = el("span", null, ` (${CONFIG.typeLabels[t]})`);
      lab.style.opacity = ".65";
      b.append(lab);
    }
    b.addEventListener("click", () => toggleFilter(CONFIG.typeField, t));
    legend.append(b);
  }
  if (CONFIG.draft) {
    const d = el("span");
    d.append(el("span", "dot hollow"), " draft");
    d.style.display = "inline-flex";
    d.style.alignItems = "center";
    d.style.gap = "6px";
    legend.append(d);
  }
  legend.append(
    el("span", "note", "node size = citations received · arrow points at the cited publication"),
  );
}

function renderChipFacet(ctl, facet) {
  ctl.append(el("span", "facet-name", facet.label));
  const all = el("button", "chip", "all");
  all.dataset.facet = facet.field;
  all.dataset.value = "";
  all.setAttribute("aria-pressed", "true");
  all.addEventListener("click", () => clearFilter(facet.field));
  ctl.append(all);
  for (const v of facet.values) {
    const b = el("button", "chip", v);
    b.dataset.facet = facet.field;
    b.dataset.value = v;
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => toggleFilter(facet.field, v));
    ctl.append(b);
  }
}

function renderDropdownFacet(ctl, facet) {
  const root = el("span", "dd");
  const btn = el("button", "chip dd-btn", facet.label + ": all");
  btn.setAttribute("aria-haspopup", "true");
  btn.setAttribute("aria-expanded", "false");
  const pop = el("div", "dd-pop");
  pop.hidden = true;
  pop.setAttribute("role", "group");
  pop.setAttribute("aria-label", facet.label + " filter");

  const boxes = [];
  for (const v of facet.values) {
    const lab = el("label", "dd-opt");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = v;
    box.addEventListener("change", () => toggleFilter(facet.field, v));
    lab.append(box, el("span", "dd-val", v), el("span", "dd-cnt", String(facet.counts.get(v))));
    pop.append(lab);
    boxes.push(box);
  }
  const clear = el("button", "dd-clear", "clear");
  clear.addEventListener("click", () => clearFilter(facet.field));
  pop.append(clear);

  const dd = { field: facet.field, label: facet.label, root, btn, pop, boxes };
  btn.addEventListener("click", () => {
    const open = pop.hidden;
    for (const other of dropdowns) closeDropdown(other, false);
    pop.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open && boxes.length) boxes[0].focus();
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeDropdown(dd, true);
    }
  });
  dropdowns.push(dd);
  root.append(btn, pop);
  ctl.append(root);
}

function renderControls() {
  const ctl = document.getElementById("controls");
  ctl.textContent = "";
  facets.forEach((facet, i) => {
    if (i > 0) ctl.append(el("span", "sep"));
    if (facet.widget === "dropdown") renderDropdownFacet(ctl, facet);
    else renderChipFacet(ctl, facet);
  });
  if (CONFIG.draft) {
    if (facets.length) ctl.append(el("span", "sep"));
    const lab = el("label", "tog");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.addEventListener("change", () => {
      showDrafts = cb.checked;
      render();
    });
    lab.append(cb, ` show drafts (${CONFIG.draft.field}: ${CONFIG.draft.value})`);
    ctl.append(lab);
  }
}

// ---- header, search, layout, theme ----
document.getElementById("title").textContent = CONFIG.name;
document.title = CONFIG.name;
if (CONFIG.backLink) {
  const back = document.getElementById("backlink");
  back.href = CONFIG.backLink;
  back.hidden = false;
}
document.getElementById("search").addEventListener("input", (e) => {
  query = e.target.value.trim().toLowerCase();
  render();
});
document.getElementById("reset").addEventListener("click", resetView);
document.getElementById("layout").addEventListener("change", (e) => {
  layoutName = e.target.value;
  render();
});

const THEMES = ["system", "light", "dark"];
// details-panel resizing: drag the divider, or focus it and use arrow keys
const resizer = document.getElementById("resizer");
const panelEl = document.getElementById("panel");
const PANEL_MIN = 280;
function panelMax() { return Math.min(Math.floor(window.innerWidth * 0.8), 1100); }
function setPanelWidth(px, persist) {
  const w = Math.max(PANEL_MIN, Math.min(panelMax(), Math.round(px)));
  document.documentElement.style.setProperty("--panel-w", w + "px");
  if (persist) {
    try {
      localStorage.setItem("okf-viewer-panel-w", String(w));
    } catch {
      /* storage unavailable */
    }
  }
  return w;
}
try {
  const savedW = parseInt(localStorage.getItem("okf-viewer-panel-w"), 10);
  if (Number.isFinite(savedW)) setPanelWidth(savedW, false);
} catch {
  /* storage unavailable */
}
resizer.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  resizer.classList.add("dragging");
  document.body.classList.add("resizing");
  const startX = e.clientX;
  const startW = panelEl.getBoundingClientRect().width;
  const onMove = (ev) => setPanelWidth(startW + (startX - ev.clientX), false);
  const onUp = (ev) => {
    setPanelWidth(startW + (startX - ev.clientX), true);
    resizer.classList.remove("dragging");
    document.body.classList.remove("resizing");
    resizer.removeEventListener("pointermove", onMove);
    resizer.removeEventListener("pointerup", onUp);
    resizer.removeEventListener("pointercancel", onUp);
  };
  resizer.addEventListener("pointermove", onMove);
  resizer.addEventListener("pointerup", onUp);
  resizer.addEventListener("pointercancel", onUp);
});
resizer.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  const cur = panelEl.getBoundingClientRect().width;
  setPanelWidth(cur + (e.key === "ArrowLeft" ? 24 : -24), true);
});
resizer.addEventListener("dblclick", () => {
  document.documentElement.style.removeProperty("--panel-w");
  try {
    localStorage.removeItem("okf-viewer-panel-w");
  } catch {
    /* storage unavailable */
  }
});

const themeBtn = document.getElementById("theme");
function applyTheme(theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  themeBtn.textContent = "theme: " + theme;
  try {
    localStorage.setItem("okf-viewer-theme", theme);
  } catch {
    /* storage unavailable */
  }
}
let theme = "system";
try {
  const saved = localStorage.getItem("okf-viewer-theme");
  if (THEMES.includes(saved)) theme = saved;
} catch {
  /* storage unavailable */
}
applyTheme(theme);
themeBtn.addEventListener("click", () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  applyTheme(theme);
});

// ---- boot ----
renderLegend();
renderControls();
render();

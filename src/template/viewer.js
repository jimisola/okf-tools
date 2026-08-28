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
  const parts = fromFile.split("/").slice(0, -1);
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

// ---- empty state: the index Overview, or the Most-cited ranking ----
const EMPTY_VIEWS = ["overview", "ranking"];
const EMPTY_VIEW_KEY = "okf-viewer-empty-view";
const EMPTY_VIEW_LABELS = { overview: "Overview", ranking: "Most cited" };

// Overview by default when there is an index to show. A stored "overview"
// choice falls back to the ranking in a bundle that has no index.
let emptyView = INDEX ? "overview" : "ranking";
try {
  const savedView = localStorage.getItem(EMPTY_VIEW_KEY);
  if (EMPTY_VIEWS.includes(savedView)) emptyView = savedView;
} catch {
  /* storage unavailable */
}
if (!INDEX) emptyView = "ranking";

function setEmptyView(view) {
  emptyView = view;
  try {
    localStorage.setItem(EMPTY_VIEW_KEY, view);
  } catch {
    /* storage unavailable */
  }
  renderPanel();
  panel.scrollTop = 0;
  const btn = panel.querySelector('[data-empty-view="' + view + '"]');
  if (btn) btn.focus();
}

/** The two-option segmented control — null when the bundle has no index. */
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
    const current = view === emptyView;
    b.setAttribute("aria-selected", String(current));
    // roving tabindex: only the selected option is in the tab order
    b.tabIndex = current ? 0 : -1;
    b.addEventListener("click", () => {
      if (view !== emptyView) setEmptyView(view);
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

function renderOverview() {
  panel.append(el("h2", null, "Overview"));
  panel.append(renderMarkdownBody("index.md", INDEX.body));
}

function renderRanking() {
  panel.append(el("h2", null, "Most cited"));
  const ranked = nodes
    .filter((n) => n.in > 0)
    .sort((a, b) => b.in - a.in || (a.id < b.id ? -1 : 1));
  const table = el("table", "rank");
  for (const n of ranked) {
    const tr = el("tr");
    const td1 = el("td");
    const a = el("a");
    a.href = "#";
    a.dataset.go = n.id;
    a.append(el("span", "mono", n.id));
    td1.append(a);
    tr.append(td1, el("td", null, titleOf(n)), el("td", null, String(n.in)));
    table.append(tr);
  }
  panel.append(table);
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
  if (!selected) {
    const tabs = emptyViewToggle();
    if (tabs) panel.append(tabs);
    if (emptyView === "overview" && INDEX) renderOverview();
    else renderRanking();
    return;
  }

  const n = byId.get(selected);
  panel.append(el("p", "pid mono", n.id), el("p", "ptitle", titleOf(n)));

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
function renderStats() {
  const stats = document.getElementById("stats");
  stats.textContent = "";
  const stat = (v, label) => {
    const s = el("span");
    s.append(el("b", null, String(v)), " " + label);
    stats.append(s);
  };
  stat(nodes.length, "publications");
  stat(edges.length, "citations");
  stat(nodes.filter((n) => n.in === 0 && n.out === 0).length, "islands");
  if (CONFIG.draft) stat(nodes.filter(isDraft).length, "drafts");
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

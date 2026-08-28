# okf-tools

A validator and a viewer for [OKF](https://github.com/GoogleCloudPlatform/open-knowledge-format)
bundles — directories of markdown files with YAML frontmatter.

| Tool | What it does | Entry point |
| --- | --- | --- |
| **Validator** | Checks a bundle against the OKF v0.2 §11 conformance rules and reports everything else as advice. Text or JSON. | `src/validate-cli.ts` (library: `src/validate.ts`) |
| **Viewer** | Extracts the citation graph and generates **one self-contained HTML file** — force layout, filter chips, search, impact analysis, in-pane reader. | `src/cli.ts` (library: `src/generate.ts`) |

Point either at any directory of frontmatter-bearing markdown — a documentation
set, an architecture-decision log, a research bibliography, a policy
collection.

## Install

```sh
git clone https://github.com/jimisola/okf-tools.git
cd okf-tools
npm install
```

Node 24 or newer is required.

## Validator

```sh
npx tsx src/validate-cli.ts <bundleDir> [--json] [--strict]
```

```
bundle: ./my-bundle
12 concepts, 3 index files, 1 log files

errors (1):
  DOC/beta.md [§11.1 frontmatter.missing] no YAML frontmatter block

warnings (2):
  DOC/alpha.md [§6 concept.stale] stale: `stale_after` (2020-01-01T00:00:00.000Z) is in the past
  DOC/alpha.md [§11 link.broken] link target does not resolve inside the bundle: gone.md

NOT CONFORMANT with OKF v0.2 (1 error, 2 warnings)
```

Exit code is `0` when the bundle is conformant, `1` when it is not, `2` on a
bad invocation. `--strict` makes warnings fail too. `--json` prints the
machine-readable report instead:

```jsonc
{
  "bundle": "./my-bundle",
  "conformant": false,
  "counts": {"concepts": 12, "indexes": 3, "logs": 1},
  "errors":   [{"file": "DOC/beta.md", "section": "§11.1",
                "code": "frontmatter.missing", "message": "…"}],
  "warnings": [{"file": "DOC/alpha.md", "section": "§6",
                "code": "concept.stale", "message": "…", "line": 4}]
}
```

### Errors versus warnings

The separation is the whole point, and it comes straight from the spec.
**Errors are only the three numbered §11 conformance rules:**

1. every non-reserved `.md` file has a parseable YAML frontmatter block;
2. every frontmatter block has a non-empty `type`;
3. the reserved filenames follow their structure when present — an `index.md`
   carries no frontmatter (the bundle-root one may carry `okf_version`, and
   nothing else), and a `log.md` uses ISO 8601 `YYYY-MM-DD` date headings.

**Everything else is a warning**, because §11 says consumers MUST NOT reject a
bundle for missing optional fields, unknown `type` values, unknown extra
frontmatter keys, broken cross-links or missing `index.md` files. A bundle with
warnings and no errors is `"conformant": true`. Warnings cover absent
recommended fields, unknown `status` values, unparseable or elapsed
`stale_after`, malformed `generated` / `verified` / `sources` entries,
out-of-order log entries, index entries that are not
`* [Title](url) - description`, broken links, and a missing root `index.md`.

A bare `verified:` mapping is treated as a one-element list (§5.2), and an
attestation that predates `generated.at` is surfaced rather than dropped
(§10.5).

Using it as a library:

```ts
import { validateBundle, formatReport } from "./src/validate.js";

const report = validateBundle("./my-bundle");
if (!report.conformant) console.error(formatReport(report));
```

## Viewer

```sh
npx tsx src/cli.ts <bundleDir> <outFile> [--config viewer.config.json]
```

Example:

```sh
npx tsx src/cli.ts ./my-bundle out/graph.html --config viewer.config.json
```

It walks the bundle, extracts the citation graph from the relative `.md` links
between document bodies, and writes a single portable file you can open
locally, attach to an email, or drop on any static host. The page loads nothing
from any CDN or network. Open `out/graph.html` in a browser; there is no server
and no build step beyond that one command.

### Viewer configuration

Every key is optional — `{}` (or no `--config` at all) works on any bundle.

```jsonc
{
  "name": "My Corpus",                // header title (default "OKF Bundle")
  "idField": "id",                    // node id; falls back to the filename stem
  "titleField": "title",
  "typeField": "type",                // drives node color + the legend
  "facets": [                         // facet filter groups; values are discovered
    "type",                           // from the bundle. A string is shorthand for
    {                                 // {"key": "..."} — both forms mix freely.
      "key": "domain",
      "widget": "dropdown",           // "chips" | "dropdown"; forces the rendering.
                                      // Absent = adaptive: chips up to 8 discovered
                                      // values, a checkbox dropdown above that.
      "label": "Domain"               // displayed group name (default: the key)
    }
  ],
  "typeLabels": {"policy": "must", "guideline": "should"}, // legend: "policy (must)"
  "palette": {"policy": "#3b82f6"}, // per-type colors; unknown types get a
                                      // stable hash-derived HSL color
  "draft": {"field": "lifecycle", "value": "draft"},
                                      // what counts as a draft: hollow node,
                                      // drafts stat, show/hide toggle
  "searchFields": [],                 // frontmatter keys the search box matches;
                                      // empty/absent = id, title, plus every string
                                      // or string-array frontmatter value
  "backLink": "../"                   // optional header back-link
}
```

Frontmatter is rendered **generically**: whatever keys a document has appear
in the detail pane — strings as text, string arrays as chips, objects as
compact `key: value` lines. Nothing about the schema is hardcoded.

### What the generated page does

- Stats bar: documents, citations, islands (no edges either way), drafts.
- Legend: one entry per discovered type; clicking filters by that type.
- Faceted filtering: within a facet, selected values OR together; across
  facets, AND (standard faceted search). Small facets render as toggleable
  chip rows (the "all" chip clears the group); facets with many values render
  as a compact dropdown ("domain: all" / "domain: 3 selected") with
  checkboxes, per-value document counts, and a clear action — keyboard
  accessible, Escape closes, outside clicks close. The type facet stays
  linked to the legend: legend clicks toggle the same selection.
- Live search (case-insensitive substring) — one box in the header, driving
  the graph and the Index together.
- Three deterministic layouts: force (seeded simulation, no randomness between
  builds or reloads), concentric (rings by citations received), grid.
- Node size = citations received; drafts render as hollow rings.
- Detail pane: full frontmatter, the rendered markdown body, and
  "Cites" / "Cited by — impact if this changes" lists. Relative `.md` links
  inside a body navigate in-pane. Frontmatter values that are absolute
  `http(s)` URLs — at any nesting depth — render as clickable links; every
  other scheme (`javascript:`, `data:`, `mailto:`) stays inert text.
- Empty detail pane (nothing selected): a two-option toggle between
  **Index** — a table of every publication currently visible — and
  **Overview**, the bundle-root `index.md` rendered as markdown, with its
  relative `.md` links navigating in-pane like any body link. The Index is
  the default; the choice is persisted in `localStorage`, and bundles with no
  root `index.md` show the Index and no toggle.
- The Index is driven by the page's one filter state: the header search box
  and the facet controls filter it exactly as they filter the graph, so it
  always lists what is on screen and never becomes a second, competing
  filter. It reports `12 of 200 publications` when filtered and offers
  **Clear filters**, which resets the search box, the facets and the drafts
  toggle from where you are reading. Sort on any column — ID, Title, or
  citations received: click a header to sort, click again to reverse.
  Citations descending is the default, and the chosen sort is persisted.
- **`indexColumns`** is the Index's column list, in order:
  `["id", "owner", { "field": "domain", "label": "Domain" }, "title", "citations"]`.
  `id`, `title` and `citations` are built in and can be placed anywhere;
  anything else is a frontmatter key, whose array values render joined with
  `", "`, showing `—` where a node has none. Every column sorts, and blanks
  sort last rather than clumping at the top of an ascending sort. Empty (the
  default) is `id`, `title`, `citations`; a list naming neither `id` nor
  `title` gets `id` prepended so a row always has something to navigate by.
- Index columns size themselves to their content — a column holding short
  codes stays narrow, one holding longer names grows — until you drag a
  header divider, which trades width with the next column and is remembered
  as a fraction so it survives resizing the panel. Double-click a divider to
  hand the widths back to the browser.
- The Overview folds. An `index.md` grows with the corpus, and a wall of
  prose is the one thing an overview must not be, so each top section — the
  shallowest heading level below the title — becomes a collapsible
  `<details>`, closed by default, with the number of items it holds shown on
  the summary. Whatever sits above the first section stays open as the lede,
  and there is an expand/collapse-all control. Which sections are open is
  remembered in `localStorage`. A front page with fewer than two such
  sections is left exactly as it was.
- **`overviewGroupings`** replaces those authored sections with groups built
  from frontmatter, and adds a **Group by** control to switch between them.
  Each entry is `{ "fields": ["owner", "type"], "label": "Owner + Type" }` —
  one field groups flat, two nest the second inside the first; array values
  put a node in every group they name. The authored lede is kept either way,
  and the empty default leaves the Overview folding `index.md` as above.
  The default choice is **adaptive**: the first grouping whose *innermost*
  field has more than one distinct value. An outer level that is uniform
  today is still worth keeping — one owner is a stable parent that gains
  siblings later — but a leaf level with a single value groups nothing. A
  stored choice always beats the adaptive one. Groups are ordered largest
  first, ties alphabetical; `typeLabels` annotate the type level.
- The view toggle sits at the top of the details pane whatever it is showing,
  so a selected publication — whose document and citation lists can run long
  — always has a visible way back; picking a view clears the selection.
- **Clear filters** sits beside the search box, where you are looking when
  you want out of a filter, and is hidden entirely while there is nothing to
  clear. It drops the selection, the search, the facets and the drafts
  toggle — the same action the Index offers next to its count — and
  deliberately leaves preferences alone: layout, theme, Index sort and which
  Overview sections are open.
- Header counts describe what is on screen: unfiltered they are corpus
  totals, filtered they read `12 of 200 publications` — including citations
  between visible nodes and islands within the filtered set.
- Layout and theme sit in the foot bar with the legend: they are view
  settings, not filters, so they stay out of the header, which holds the one
  search box.
- The bundle-root `index.md` is never a node, so it never distorts the
  citation metrics.
- Theme: follows `prefers-color-scheme`, with a manual system/light/dark
  toggle persisted in `localStorage`.

### Screenshots

_Coming soon._

### Security note — trusted input

The markdown **bodies** in the bundle are rendered as HTML (via
[marked](https://github.com/markedjs/marked), inlined into the page at build
time). This tool is for rendering **your own corpus**: bundle markdown is
trusted input, and no sanitizer is applied to it. Frontmatter, by contrast,
is always rendered inertly (`textContent`/`createElement`), never as HTML.
Do not point the generator at markdown you would not serve as HTML yourself.

## Development

```sh
npm test              # vitest
npm run typecheck     # tsc --noEmit
npm run validate -- ./my-bundle
npm run viewer -- ./my-bundle out/graph.html
```

Both tools share `src/parse.ts` — the bundle walk and the frontmatter split.
The test suite runs against the fixture bundle in `test/fixtures/bundle`. To
additionally smoke-test the parser against a bundle of your own, set
`OKF_BUNDLE_DIR` to its path before running the tests.

Determinism is a feature: two builds over the same bundle are byte-identical,
and the force layout is a seeded LCG — the graph looks the same on every load.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute.

## License

[Apache-2.0](LICENSE) © 2026 jimisola

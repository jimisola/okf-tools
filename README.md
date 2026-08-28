# okf-viewer

A generic static-site graph viewer for [OKF](https://github.com/GoogleCloudPlatform/open-knowledge-format)
bundles — directories of markdown files with YAML frontmatter. It walks a
bundle, extracts the citation graph from the relative `.md` links between
document bodies, and generates **one self-contained HTML file**: deterministic
force layout, filter chips, search, per-document impact analysis, and an
in-pane document reader. The page loads nothing from any CDN or network.

Point it at any directory of frontmatter-bearing markdown — a documentation
set, an architecture-decision log, a research bibliography, a policy
collection — and you get a single portable file you can open locally, attach
to an email, or drop on any static host.

## Install

```sh
git clone https://github.com/jimisola/okf-viewer.git
cd okf-viewer
npm install
```

Node 24 or newer is required.

## Usage

```sh
npx tsx src/cli.ts <bundleDir> <outFile> [--config viewer.config.json]
```

Example:

```sh
npx tsx src/cli.ts ./my-bundle out/graph.html --config viewer.config.json
```

Open `out/graph.html` in a browser. There is no server and no build step
beyond that one command.

## Configuration

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

## What the generated page does

- Stats bar: documents, citations, islands (no edges either way), drafts.
- Legend: one entry per discovered type; clicking filters by that type.
- Faceted filtering: within a facet, selected values OR together; across
  facets, AND (standard faceted search). Small facets render as toggleable
  chip rows (the "all" chip clears the group); facets with many values render
  as a compact dropdown ("domain: all" / "domain: 3 selected") with
  checkboxes, per-value document counts, and a clear action — keyboard
  accessible, Escape closes, outside clicks close. The type facet stays
  linked to the legend: legend clicks toggle the same selection.
- Live search (case-insensitive substring).
- Three deterministic layouts: force (seeded simulation, no randomness between
  builds or reloads), concentric (rings by citations received), grid.
- Node size = citations received; drafts render as hollow rings.
- Detail pane: full frontmatter, the rendered markdown body, and
  "Cites" / "Cited by — impact if this changes" lists. Relative `.md` links
  inside a body navigate in-pane.
- Theme: follows `prefers-color-scheme`, with a manual system/light/dark
  toggle persisted in `localStorage`.

## Screenshots

_Coming soon._

## Security note — trusted input

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
```

The test suite runs against the fixture bundle in `test/fixtures/bundle`. To
additionally smoke-test the parser against a bundle of your own, set
`OKF_BUNDLE_DIR` to its path before running the tests.

Determinism is a feature: two builds over the same bundle are byte-identical,
and the force layout is a seeded LCG — the graph looks the same on every load.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute.

## License

[Apache-2.0](LICENSE) © 2026 jimisola

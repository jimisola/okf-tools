import { readFileSync } from "node:fs";
import type { BundleNode } from "./parse.js";

export interface DraftRule {
  /** Frontmatter key that marks drafts. */
  field: string;
  /** Value of that key that counts as a draft. */
  value: string;
}

/** How a facet's filter renders. */
export type FacetWidget = "chips" | "dropdown";

export interface FacetConfig {
  /** Frontmatter key the facet filters on (values discovered from the bundle). */
  key: string;
  /**
   * Force the widget regardless of value count. Absent = adaptive:
   * chips while the facet has few discovered values, dropdown above that.
   */
  widget?: FacetWidget;
  /** Displayed group name; defaults to the key. */
  label?: string;
}

/** One choice in the Overview's "Group by" control. */
export interface GroupingConfig {
  /**
   * Frontmatter keys to group on, outermost first. One key groups flat; two
   * nest the second inside the first. Array values put a node in every group
   * it names.
   */
  fields: string[];
  /** Displayed choice name; defaults to the fields joined with " + ". */
  label?: string;
}

/**
 * One column of the Index table, sortable like every other.
 *
 * `field` is either a built-in — `id`, `title`, `citations` — or any
 * frontmatter key, whose array values render joined with ", ". The order of
 * the list is the order of the columns, so the built-ins can be placed
 * anywhere rather than pinned to the ends.
 */
export interface IndexColumnConfig {
  field: string;
  /** Column header; defaults to the built-in name or the field name. */
  label?: string;
}

/** Built-in Index columns, usable by name in `indexColumns`. */
export const BUILTIN_INDEX_COLUMNS = ["id", "title", "citations"] as const;

export interface ViewerConfig {
  /** Header title of the generated page. */
  name: string;
  /** Frontmatter key used as node id; falls back to the filename stem. */
  idField: string;
  /**
   * Frontmatter keys whose values (an id, or a list of ids) are edges too,
   * next to body links, such as a field naming the documents one replaces. Empty (the
   * default) draws body links only.
   */
  relationFields: string[];
  /** Frontmatter key used as node title. */
  titleField: string;
  /** Frontmatter key that drives node color and the legend. */
  typeField: string;
  /**
   * Facet filter groups. Config entries may be plain frontmatter keys
   * (strings) or {key, widget?, label?} objects; both normalize to
   * FacetConfig. Selected values OR within a facet, AND across facets.
   */
  facets: FacetConfig[];
  /** Optional legend annotations, rendered as `policy (must)`. */
  typeLabels: Record<string, string>;
  /** Optional per-type color overrides; unknown types get a stable hash-derived HSL color. */
  palette: Record<string, string>;
  /** What counts as a draft: hollow node, drafts stat, show/hide toggle. Absent = no draft UI. */
  draft?: DraftRule;
  /**
   * Frontmatter keys searched by the search box. Empty/absent = default:
   * id, title, plus every string or string-array frontmatter value.
   */
  searchFields: string[];
  /**
   * Overview groupings offered by the "Group by" control. Empty (the default)
   * leaves the Overview as the bundle's own `index.md`, folded at its
   * headings. Non-empty replaces those sections with groups built from
   * frontmatter; the lede above the first heading is kept either way.
   *
   * The default choice is adaptive: the first grouping whose every field has
   * more than one distinct value in the bundle, so a key that is uniform
   * today (one owner) starts being useful the day it is not, with no config
   * change. A stored choice always wins over it.
   */
  overviewGroupings: GroupingConfig[];
  /**
   * The Index table's columns, in order. Empty (the default) is
   * `id`, `title`, `citations`. A list with neither `id` nor `title` gets
   * `id` prepended, so a row always has something to navigate by.
   */
  indexColumns: IndexColumnConfig[];
  /** Optional header back-link href. */
  backLink?: string;
  /**
   * Optional base URL for a node's source file. When set, the detail pane
   * links to `sourceBaseUrl + node.file` (POSIX-relative, e.g. `DOC/DOC.001.md`),
   * so a viewer generated from a repo can link each publication back to its
   * markdown source (e.g. a GitHub `blob/main/` URL for the bundle root).
   */
  sourceBaseUrl?: string;
}

export const DEFAULT_CONFIG: ViewerConfig = {
  name: "OKF Bundle",
  idField: "id",
  relationFields: [],
  titleField: "title",
  typeField: "type",
  facets: [{ key: "type" }],
  typeLabels: {},
  palette: {},
  searchFields: [],
  overviewGroupings: [],
  indexColumns: [],
};

/** Normalize one facet entry: a string key or a {key, widget?, label?} object. */
function normalizeFacet(entry: unknown): FacetConfig | null {
  if (typeof entry === "string") return { key: entry };
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const e = entry as Record<string, unknown>;
    if (typeof e.key !== "string") return null;
    const facet: FacetConfig = { key: e.key };
    if (e.widget === "chips" || e.widget === "dropdown") facet.widget = e.widget;
    if (typeof e.label === "string") facet.label = e.label;
    return facet;
  }
  return null;
}

/** Normalize one grouping entry: "owner", ["owner","domain"], or {fields,label?}. */
function normalizeGrouping(entry: unknown): GroupingConfig | null {
  const fromFields = (fields: unknown, label?: unknown): GroupingConfig | null => {
    const keys = Array.isArray(fields)
      ? fields.filter((f): f is string => typeof f === "string" && f !== "")
      : typeof fields === "string" && fields !== ""
        ? [fields]
        : [];
    if (!keys.length) return null;
    const grouping: GroupingConfig = { fields: keys };
    if (typeof label === "string") grouping.label = label;
    return grouping;
  };
  if (typeof entry === "string" || Array.isArray(entry)) return fromFields(entry);
  if (entry && typeof entry === "object") {
    const e = entry as Record<string, unknown>;
    return fromFields(e.fields, e.label);
  }
  return null;
}

/** Normalize one Index column entry: "owner" or {field, label?}. */
function normalizeIndexColumn(entry: unknown): IndexColumnConfig | null {
  if (typeof entry === "string" && entry !== "") return { field: entry };
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const e = entry as Record<string, unknown>;
    if (typeof e.field !== "string" || e.field === "") return null;
    const column: IndexColumnConfig = { field: e.field };
    if (typeof e.label === "string") column.label = e.label;
    return column;
  }
  return null;
}

/** Merge a partial config (e.g. parsed from JSON) over the defaults. */
export function resolveConfig(partial: unknown): ViewerConfig {
  const p = (partial ?? {}) as Record<string, unknown> & Partial<ViewerConfig>;
  const config: ViewerConfig = {
    name: typeof p.name === "string" ? p.name : DEFAULT_CONFIG.name,
    idField: typeof p.idField === "string" ? p.idField : DEFAULT_CONFIG.idField,
    relationFields: Array.isArray(p.relationFields)
      ? p.relationFields.filter((f): f is string => typeof f === "string" && f !== "")
      : [],
    titleField:
      typeof p.titleField === "string" ? p.titleField : DEFAULT_CONFIG.titleField,
    typeField:
      typeof p.typeField === "string" ? p.typeField : DEFAULT_CONFIG.typeField,
    facets: Array.isArray(p.facets)
      ? p.facets
          .map(normalizeFacet)
          .filter((f): f is FacetConfig => f !== null)
      : DEFAULT_CONFIG.facets.map((f) => ({ ...f })),
    typeLabels:
      p.typeLabels && typeof p.typeLabels === "object" ? { ...p.typeLabels } : {},
    palette: p.palette && typeof p.palette === "object" ? { ...p.palette } : {},
    searchFields: Array.isArray(p.searchFields)
      ? p.searchFields.filter((f): f is string => typeof f === "string")
      : [],
    overviewGroupings: Array.isArray(p.overviewGroupings)
      ? p.overviewGroupings
          .map(normalizeGrouping)
          .filter((g): g is GroupingConfig => g !== null)
      : [],
    indexColumns: Array.isArray(p.indexColumns)
      ? p.indexColumns
          .map(normalizeIndexColumn)
          .filter((c): c is IndexColumnConfig => c !== null)
      : [],
  };
  if (
    p.draft &&
    typeof p.draft === "object" &&
    typeof p.draft.field === "string" &&
    typeof p.draft.value === "string"
  ) {
    config.draft = { field: p.draft.field, value: p.draft.value };
  }
  if (typeof p.backLink === "string") config.backLink = p.backLink;
  if (typeof p.sourceBaseUrl === "string") config.sourceBaseUrl = p.sourceBaseUrl;
  return config;
}

export function loadConfig(filePath: string): ViewerConfig {
  return resolveConfig(JSON.parse(readFileSync(filePath, "utf8")));
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}

/**
 * The lowercased text the search box matches a node against.
 * With explicit searchFields: those frontmatter keys plus the node id.
 * Default (empty searchFields): id, title, plus every string or
 * string-array frontmatter value.
 */
export function searchText(node: BundleNode, config: ViewerConfig): string {
  const parts: string[] = [node.id];
  if (config.searchFields.length > 0) {
    for (const field of config.searchFields) {
      parts.push(...stringValues(node.frontmatter[field]));
    }
  } else {
    for (const value of Object.values(node.frontmatter)) {
      parts.push(...stringValues(value));
    }
  }
  return parts.join("\n").toLowerCase();
}

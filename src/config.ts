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

export interface ViewerConfig {
  /** Header title of the generated page. */
  name: string;
  /** Frontmatter key used as node id; falls back to the filename stem. */
  idField: string;
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
  /** Optional header back-link href. */
  backLink?: string;
}

export const DEFAULT_CONFIG: ViewerConfig = {
  name: "OKF Bundle",
  idField: "id",
  titleField: "title",
  typeField: "type",
  facets: [{ key: "type" }],
  typeLabels: {},
  palette: {},
  searchFields: [],
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

/** Merge a partial config (e.g. parsed from JSON) over the defaults. */
export function resolveConfig(partial: unknown): ViewerConfig {
  const p = (partial ?? {}) as Record<string, unknown> & Partial<ViewerConfig>;
  const config: ViewerConfig = {
    name: typeof p.name === "string" ? p.name : DEFAULT_CONFIG.name,
    idField: typeof p.idField === "string" ? p.idField : DEFAULT_CONFIG.idField,
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

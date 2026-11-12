#!/usr/bin/env tsx
import { statSync } from "node:fs";
import { loadConfig, type ViewerConfig } from "./config.js";
import { blockingWarnings, formatReport, validateBundle } from "./validate.js";

const USAGE = `usage: validate-cli.ts <bundleDir> [--json] [--strict] [--allow <code>]...
                       [--orphans [--id-field <name>] [--relation-field <name>]...]
                       [--config <viewer.config.json>]

Check a bundle for conformance with OKF v0.2 §11.

  --json    emit the machine-readable report instead of text
  --strict  exit non-zero on warnings too
  --allow   a warning code --strict does not fail on (still reported);
            repeatable, e.g. --allow concept.stale
  --orphans         also warn about concepts no other concept links to
                    (concept.orphan); links from index.md and log.md don't count
  --config          the viewer config; its idField and relationFields feed --orphans
  --id-field        the frontmatter field holding a concept's id (default: id);
                    overrides the config's idField; needs a relation field
  --relation-field  a frontmatter field naming related ids, counted as a link;
                    repeatable, e.g. --relation-field supersedes; replaces the
                    config's relationFields

Exit codes: 0 conformant, 1 not conformant, 2 bad invocation.`;

function main(argv: string[]): number {
  const positional: string[] = [];
  let json = false;
  let strict = false;
  let orphans = false;
  let idField: string | undefined;
  let configPath: string | undefined;
  const relationFields: string[] = [];
  const allowed = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = (what: string): string | undefined => {
      const v = argv[++i];
      if (v && !v.startsWith("-")) return v;
      console.error(`error: ${arg} needs ${what}\n${USAGE}`);
      return undefined;
    };
    if (arg === "--json") json = true;
    else if (arg === "--strict") strict = true;
    else if (arg === "--orphans") orphans = true;
    else if (arg === "--allow") {
      const code = value("a warning code");
      if (code === undefined) return 2;
      allowed.add(code);
    } else if (arg === "--id-field") {
      const field = value("a field name");
      if (field === undefined) return 2;
      idField = field;
    } else if (arg === "--relation-field") {
      const field = value("a field name");
      if (field === undefined) return 2;
      relationFields.push(field);
    } else if (arg === "--config") {
      const file = value("a config file");
      if (file === undefined) return 2;
      configPath = file;
    }
    else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      return 0;
    } else if (arg.startsWith("-")) {
      console.error(`error: unknown option ${arg}\n${USAGE}`);
      return 2;
    } else positional.push(arg);
  }
  const [bundleDir] = positional;
  if (!bundleDir || positional.length !== 1) {
    console.error(USAGE);
    return 2;
  }
  if (!statSync(bundleDir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`error: bundle directory not found: ${bundleDir}`);
    return 2;
  }

  if (!orphans && (idField !== undefined || relationFields.length > 0)) {
    console.error(`error: --id-field and --relation-field only apply with --orphans\n${USAGE}`);
    return 2;
  }

  let config: ViewerConfig | undefined;
  if (configPath !== undefined) {
    try {
      config = loadConfig(configPath);
    } catch (e) {
      console.error(`error: cannot load config ${configPath}: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
  }
  // Flags win over the config; a --relation-field list replaces the config's.
  const effectiveIdField = idField ?? config?.idField;
  const effectiveRelations = relationFields.length > 0 ? relationFields : (config?.relationFields ?? []);
  if (orphans && idField !== undefined && effectiveRelations.length === 0) {
    console.error(`error: --id-field only applies with --relation-field (or relationFields in --config)\n${USAGE}`);
    return 2;
  }

  const report = validateBundle(
    bundleDir,
    orphans ? { orphans: { idField: effectiveIdField, relationFields: effectiveRelations } } : {},
  );
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
  if (!report.conformant) return 1;
  return strict && blockingWarnings(report, allowed).length > 0 ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));

#!/usr/bin/env tsx
import { statSync } from "node:fs";
import { blockingWarnings, formatReport, validateBundle } from "./validate.js";

const USAGE = `usage: validate-cli.ts <bundleDir> [--json] [--strict] [--allow <code>]...

Check a bundle for conformance with OKF v0.2 §11.

  --json    emit the machine-readable report instead of text
  --strict  exit non-zero on warnings too
  --allow   a warning code --strict does not fail on (still reported);
            repeatable, e.g. --allow concept.stale

Exit codes: 0 conformant, 1 not conformant, 2 bad invocation.`;

function main(argv: string[]): number {
  const positional: string[] = [];
  let json = false;
  let strict = false;
  const allowed = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--json") json = true;
    else if (arg === "--strict") strict = true;
    else if (arg === "--allow") {
      const code = argv[++i];
      if (!code || code.startsWith("-")) {
        console.error(`error: --allow needs a warning code\n${USAGE}`);
        return 2;
      }
      allowed.add(code);
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

  const report = validateBundle(bundleDir);
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
  if (!report.conformant) return 1;
  return strict && blockingWarnings(report, allowed).length > 0 ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));

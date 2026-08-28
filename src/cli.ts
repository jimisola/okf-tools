#!/usr/bin/env tsx
// The viewer CLI: bundle in, one self-contained HTML file out. The other tool
// in this package is the conformance validator, `src/validate-cli.ts`.
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import { generate } from "./generate.js";

const USAGE =
  "usage: cli.ts <bundleDir> <outFile> [--config viewer.config.json]\n" +
  "       (to check a bundle for OKF v0.2 conformance, see validate-cli.ts)";

function main(argv: string[]): number {
  const positional: string[] = [];
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--config") {
      configPath = argv[++i];
      if (!configPath) {
        console.error(USAGE);
        return 2;
      }
    } else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      return 0;
    } else {
      positional.push(arg);
    }
  }
  const [bundleDir, outFile] = positional;
  if (!bundleDir || !outFile || positional.length !== 2) {
    console.error(USAGE);
    return 2;
  }
  if (!statSync(bundleDir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`error: bundle directory not found: ${bundleDir}`);
    return 1;
  }

  const config = configPath ? loadConfig(configPath) : DEFAULT_CONFIG;
  const { html, bundle } = generate(bundleDir, config);

  mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  writeFileSync(outFile, html);
  console.error(
    `wrote ${outFile}: ${bundle.nodes.length} nodes, ${bundle.edges.length} edges, ` +
      `${bundle.islands.length} islands (${(html.length / 1024).toFixed(0)} KiB)`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));

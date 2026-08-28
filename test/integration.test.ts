import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseBundle, type Bundle } from "../src/parse.js";

// Optional smoke test against a real bundle on disk. Point OKF_BUNDLE_DIR at
// one to exercise the parser over a corpus larger than the fixtures; these
// tests are skipped when the variable is unset or the path does not exist.
const BUNDLE = process.env["OKF_BUNDLE_DIR"];
const AVAILABLE = Boolean(BUNDLE && existsSync(BUNDLE));

describe.skipIf(!AVAILABLE)("real bundle (OKF_BUNDLE_DIR)", () => {
  let bundle: Bundle;

  beforeAll(() => {
    bundle = parseBundle(BUNDLE as string);
  });

  it("finds documents and citations", () => {
    expect(bundle.nodes.length).toBeGreaterThan(0);
    expect(bundle.edges.length).toBeGreaterThan(0);
  });

  it("resolves cross-directory ../<dir>/… links", () => {
    const crossDir = bundle.edges.filter(
      ([s, t]) => s.split(".")[0] !== t.split(".")[0],
    );
    expect(crossDir.length).toBeGreaterThan(0);
  });

  it("computes indegrees over the bundle", () => {
    const byId = new Map(bundle.nodes.map((n) => [n.id, n]));
    const top = [...byId.values()].sort((a, b) => b.in - a.in)[0];
    expect(top?.in).toBeGreaterThanOrEqual(1);
  });
});

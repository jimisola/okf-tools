# Contributing

Thanks for your interest in improving okf-tools.

## Getting started

```sh
npm install
npm test              # vitest — the full suite
npm run typecheck     # tsc --noEmit, must be clean
```

Both must pass before a pull request is ready. To smoke-test a real bundle:

```sh
npx tsx src/validate-cli.ts ./my-bundle          # validator
npx tsx src/cli.ts ./my-bundle out/graph.html    # viewer
```

## Code style

Plain TypeScript, no formatter or linter in the toolchain — match the style
of the surrounding code: two-space indentation, double quotes, semicolons,
ES modules with explicit `.js` extensions in relative imports (required by
`nodenext` resolution). `strict` and `noUncheckedIndexedAccess` are on; keep
them satisfied rather than reaching for `any` or non-null assertions.

Comments explain *why*, not *what*. Reasoning that belongs in history goes in
the commit message or the pull request, not in the source.

Dependency versions are pinned exactly on purpose. Do not widen them to
ranges.

## Conformance rules are load-bearing

The validator may only report an **error** for one of the three numbered OKF
v0.2 §11 conformance rules. Every other finding is a **warning**: §11 forbids
consumers from rejecting a bundle over optional fields, unknown `type` values,
unknown keys, broken cross-links or missing `index.md` files. A change that
promotes soft guidance to an error will be rejected — add a warning instead,
with the spec section it cites.

## Determinism

Two builds over the same bundle must be byte-identical, and the force layout
is a seeded LCG so the rendered graph is stable across reloads. Any change
that introduces `Math.random()`, wall-clock time, or filesystem-order
dependence into generated output will be rejected — there are tests guarding
this.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
`<type>(<scope>): <description>`, where type is one of `feat`, `fix`,
`build`, `chore`, `ci`, `docs`, `perf`, `refactor`, `revert`, `style`,
`test`. Breaking changes use a `!` suffix or a `BREAKING CHANGE:` footer.

## Developer Certificate of Origin

All contributions must be signed off under the
[Developer Certificate of Origin](https://developercertificate.org/). Add a
sign-off line to every commit:

```
Signed-off-by: Your Name <your.email@example.com>
```

`git commit -s` adds it for you. Pull requests containing commits without a
sign-off cannot be merged.

## License

By contributing you agree that your contributions are licensed under the
Apache License 2.0, the same license that covers this project.

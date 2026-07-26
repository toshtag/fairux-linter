# package-boundary fixture

A two-package miniature of the workspace layout, used by
`tests/unit/package-boundary-compiler.test.ts` to prove that the `rootDir` contract is enforced by
the repository-pinned TypeScript compiler and not merely configured.

`package-a` mirrors a workspace typecheck project: `rootDir: "."`, `noEmit: true`, `include: ["src"]`.
`package-b` stands in for a sibling workspace whose `src` must stay private.

The test copies this tree to a temporary directory, writes one case into `package-a/src/index.ts`,
runs `tsc --noEmit`, and asserts on the diagnostic **code** — `TS6059` — rather than on the exit
code, so an unrelated compile error cannot be mistaken for boundary enforcement.

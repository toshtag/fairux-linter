/**
 * The two size ceilings for the SDK's browser bundle, and the argument for each.
 *
 * ## Two ceilings, because they answer different questions
 *
 * The unminified bundle is what esbuild emits here; no consumer ships it, so its ceiling is a coarse
 * guard against the SDK gaining a dependency-sized amount of code at once. The minified one is what
 * a browser product actually serves, and it is the number worth being strict about.
 *
 * The coarse ceiling was raised from 180 KiB when the journey contract, the Risk Index contract, and
 * remediation validation landed — real features whose code the scanner reaches, so no amount of
 * tree-shaking removes them. A budget that is raised whenever it is hit measures nothing; the strict
 * ceiling exists so this one does not have to carry the whole argument alone.
 *
 * It was raised again, to 196 KiB, and **only this one**. Two features landed and the bundle grew
 * 3,150 bytes unminified: open shadow roots got their own selector scope in the DOM adapter
 * (+1,153), and `consent/checked-checkbox` gained the first built-in remediation (+1,997, including
 * the reviewed limitations that ship with it). Measured by bundling the same fixture at each commit.
 * Both are code the scanner reaches, and 3 KiB is not a dependency.
 *
 * The strict ceiling is deliberately untouched, and is where the argument still lives. The next
 * feature that grows the bundle meets it first, which is the one that should be hard to move.
 *
 * ## Why this file exists
 *
 * Both numbers, and the whole of the reasoning above, were written out twice — in
 * `pack-smoke-test.mjs` and in `consumer-smoke.mjs` — and only the first runs in `pnpm verify:full`.
 * `verify-full-contract.test.ts` grew a check that the two copies agreed, with the comment "two
 * numbers that are supposed to be one number will eventually differ".
 *
 * That check was the right diagnosis and the wrong remedy: a drift test is a way of *tolerating* a
 * second copy. One declaration removes the drift instead of watching for it, and the check it
 * replaces is gone.
 *
 * Each copy also carried the bundle's measured size and the headroom left against the strict
 * ceiling. That is a fact about one commit, written into a file nothing updates when the bundle
 * grows — so it is not written down here. The smokes print the real size on every run.
 */

/** The coarse ceiling, on the unminified bundle no consumer ships. */
export const MAX_BROWSER_BUNDLE_BYTES = 196 * 1024;

/** The strict ceiling, on what a browser product actually serves. */
export const MAX_MINIFIED_BROWSER_BUNDLE_BYTES = 112 * 1024;

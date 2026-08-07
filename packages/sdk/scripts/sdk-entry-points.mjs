/**
 * The SDK's published entry points, derived from the one place that decides them.
 *
 * `packages/sdk/package.json#exports` is what npm resolves. Everything else that needed to know the
 * set had its own copy: `tsdown.config.ts` listed the source files, `check-build-output.mjs` listed
 * `["index", "html", "dom"]`, `generate-api-inventory.mjs` listed the three specifiers with their
 * declaration filenames, `release-notes.mjs` froze the three specifiers again, and two tests and a
 * contract document each spelled "three". Adding a subpath meant editing all of them, and the only
 * thing that made the copies agree was that nobody had added one.
 *
 * They are derived from the manifest now. The set is a *set*, not a count: nothing downstream says
 * how many there are.
 *
 * ## `./package.json` is not an entry point
 *
 * It is exported so tooling can read the manifest — `require.resolve("@fairux/sdk/package.json")` —
 * and it is not an API. Excluded here, which is the one judgement this module makes.
 *
 * ## What stops an accidental public API
 *
 * Not a second hardcoded list. `docs/generated/sdk-api-inventory.json` is committed, generated from
 * the built declarations of exactly these entry points, and `pnpm api:inventory:check` fails when
 * the tree and the artifact disagree. Adding a subpath export therefore changes a checked-in file,
 * and the diff is the review surface — which is stronger than an array agreeing with another array,
 * because it shows the names that became public rather than that a number moved.
 *
 * Node built-ins only: `check-build-output.mjs` and `generate-api-inventory.mjs` are repository
 * scripts, and this has to be importable from both.
 */

export class SdkEntryPointError extends Error {
  constructor(message) {
    super(message);
    this.name = "SdkEntryPointError";
  }
}

/** Exported for tooling to read the manifest with; not an API, so not an entry point. */
const MANIFEST_SUBPATH = "./package.json";

/**
 * Every published entry point a manifest declares, in manifest order.
 *
 * @param {unknown} manifest  the parsed `packages/sdk/package.json`
 * @returns {{subpath: string, specifier: string, base: string}[]}
 *   `subpath` as `exports` spells it, `specifier` as a consumer imports it, and `base` as the
 *   built artifacts are named — `index`, `html`, `dom` — which is what the build-output and
 *   inventory checks look for on disk.
 */
export function sdkEntryPoints(manifest) {
  const name = manifest?.name;
  if (typeof name !== "string" || name === "") {
    throw new SdkEntryPointError("manifest has no package name");
  }
  const exportMap = manifest?.exports;
  if (typeof exportMap !== "object" || exportMap === null || Array.isArray(exportMap)) {
    throw new SdkEntryPointError("manifest exports must be an object");
  }

  const entries = Object.keys(exportMap)
    .filter((subpath) => subpath !== MANIFEST_SUBPATH)
    .map((subpath) => {
      if (subpath !== "." && !subpath.startsWith("./")) {
        throw new SdkEntryPointError(`manifest export key is not a subpath: ${subpath}`);
      }
      const base = subpath === "." ? "index" : subpath.slice(2);
      // A nested subpath would break every consumer of `base` — the build check looks for
      // `dist/<base>.js`, and the inventory for `dist/<base>.d.ts`. Refused rather than mangled.
      if (!/^[a-z0-9-]+$/.test(base)) {
        throw new SdkEntryPointError(
          `manifest export ${subpath} does not map to a flat dist artifact name`,
        );
      }
      return {
        subpath,
        specifier: subpath === "." ? name : `${name}${subpath.slice(1)}`,
        base,
      };
    });

  if (entries.length === 0) {
    throw new SdkEntryPointError("manifest declares no published entry points");
  }
  return entries;
}

/** The specifiers a consumer imports, in manifest order. */
export function sdkEntryPointSpecifiers(manifest) {
  return sdkEntryPoints(manifest).map((entry) => entry.specifier);
}

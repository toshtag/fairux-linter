import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const COMPATIBILITY = readFileSync(join(ROOT, "docs/reference/compatibility.md"), "utf8");

/**
 * The compatibility page's status claim, against the manifests.
 *
 * It said "Everything here describes a **beta**. `@fairux/sdk` is on the `next` dist-tag and the
 * `fairux` CLI is unpublished", and went on saying it through two CLI releases and the first stable
 * release of both packages — a page whose whole subject is what a consumer may rely on, telling
 * them the thing they had just installed did not exist. It is the surface the release criteria cite
 * for `C2`.
 *
 * What is checked is the pair of facts that can go stale, read from the manifests. The wording is
 * the author's: three sentences used to be pinned here, so tightening the paragraph failed a test
 * about publication state.
 *
 * Line breaks are collapsed and blockquote markers stripped before matching, because a claim that
 * spans a wrapped line inside the status quote is the same claim.
 */
describe("the compatibility page's status claim", () => {
  const versions = ["packages/sdk/package.json", "apps/cli/package.json"].map(
    (manifest) =>
      (JSON.parse(readFileSync(join(ROOT, manifest), "utf8")) as { version: string }).version,
  );
  const allStable = versions.every((version) => !version.includes("-"));

  const text = COMPATIBILITY.split("\n")
    .map((line) => line.replace(/^>\s?/, ""))
    .join("\n")
    .replace(/\s+/g, " ");

  it("does not call a published package unpublished", () => {
    expect(text).not.toMatch(/is unpublished/);
    expect(text).not.toMatch(/not (?:yet )?(?:been )?published/);
  });

  it("names the channel the packages are actually on", () => {
    if (allStable) {
      expect(text).toMatch(/published on `latest`|on npm's `latest`|`latest` dist-tag/);
      expect(text).not.toMatch(/ships on `next` rather than `latest`/);
    } else {
      expect(text).toMatch(/`next`/);
    }
  });

  it("does not present a 0.x as an API stability guarantee", () => {
    // `C2` cites this page for the claim a consumer acts on, and a page that announced `latest`
    // without this would read as a promise the project has not made. Matched as the idea rather
    // than as the sentence: "a `0.x` minor may break" and "breaking changes are possible before
    // 1.0" say the same thing, and only one of them used to pass.
    expect(text).toMatch(/`0\.x`/);
    expect(text, "the page must say a 0.x may still break").toMatch(
      /may break|may still break|breaking change|can break/i,
    );
    // Only claims that are wrong however they are phrased. "the surface is frozen" is deliberately
    // absent: the page says "it does **not** mean the surface is frozen", and a pattern matching
    // those words would fail on the correct sentence — which it did, until this was measured.
    expect(text, "and must not claim the surface is fixed before 1.0").not.toMatch(
      /\bAPI is stable\b|\bwill not break\b|\bAPI stability guarantee\b/i,
    );
  });
});

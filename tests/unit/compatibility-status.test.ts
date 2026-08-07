import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const COMPATIBILITY = readFileSync(join(ROOT, "docs/reference/compatibility.md"), "utf8");

/**
 * The status paragraph of the compatibility page, which is the claim a consumer acts on.
 *
 * It said "Everything here describes a **beta**. `@fairux/sdk` is on the `next` dist-tag and the
 * `fairux` CLI is unpublished." That survived two CLI releases and then the first stable release of
 * both packages — a page whose whole subject is what a consumer may rely on, telling them the thing
 * they had just installed does not exist.
 *
 * Nothing checked it, which is the actual defect: every other status surface in this repository has
 * a test, and this one is the surface the criteria list cites for `C2`.
 *
 * What is pinned is the pair of facts that can go stale, read from the manifests rather than
 * written out — not the prose around them.
 */
describe("the compatibility page's status claim", () => {
  const versions = ["packages/sdk/package.json", "apps/cli/package.json"].map(
    (manifest) =>
      (JSON.parse(readFileSync(join(ROOT, manifest), "utf8")) as { version: string }).version,
  );
  const allStable = versions.every((version) => !version.includes("-"));

  /**
   * The live claim, with the quotation of what the page used to say removed.
   *
   * The correction keeps the refuted sentence so a reader can see what changed, and a check that
   * forbade those words would forbid the explanation. Everything below reads the *live* paragraph,
   * with Markdown's 100-column wrapping collapsed — a line break is not a difference in what a
   * document says, and both assertions here span one.
   *
   * The blockquote marker is stripped before the collapse. Without that, `the\n> surface` becomes
   * `the > surface` and every assertion crossing a wrapped line inside the quote fails for a reason
   * that has nothing to do with what the page says.
   */
  const live = (() => {
    const at = COMPATIBILITY.indexOf("That paragraph used to say:");
    const withoutHistory = at === -1 ? COMPATIBILITY : COMPATIBILITY.slice(0, at);
    return withoutHistory
      .split("\n")
      .map((line) => line.replace(/^>\s?/, ""))
      .join("\n")
      .replace(/\s+/g, " ");
  })();

  it("does not call a published package unpublished", () => {
    expect(live).not.toMatch(/is unpublished/);
    // And the quotation is still there, so the correction keeps its evidence.
    expect(COMPATIBILITY).toContain("That paragraph used to say:");
  });

  it("names the channel the packages are actually on", () => {
    if (allStable) {
      expect(live).toContain("published on `latest`");
      // And does not still say the SDK is kept off it.
      expect(live).not.toContain("ships on `next` rather than `latest`");
    } else {
      expect(live).toContain("`next`");
    }
  });

  it("keeps saying what a 0.x does not promise, which is why the page exists", () => {
    // `C2` of the release criteria cites this document for exactly this sentence. A page that
    // announced `latest` and dropped it would read as an API guarantee.
    expect(live).toContain("a `0.x` minor may break");
    expect(live).toContain("does **not** mean the surface is frozen");
    expect(live).toContain("not a contract anybody has signed");
  });
});

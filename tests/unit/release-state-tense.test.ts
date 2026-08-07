import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNBOOKS = ["docs/maintainers/release-sdk.md", "docs/maintainers/release-cli.md"] as const;
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

/**
 * The release runbooks may explain the placeholder; they may not claim it is where `latest` points.
 *
 * `latest` held `0.0.0-bootstrap.0` on both packages from the moment each name was reserved until
 * `0.1.0` moved it. Three passages described that as the present:
 *
 *     latest` currently names `0.0.0-bootstrap.0` on both packages
 *     So `fairux` and `@fairux/sdk` sit in the same place, and it is the correct place: …
 *     `@fairux/sdk` shows the same shape on the registry today
 *
 * All three survived the stable release. None was wrong when written, which is the whole difficulty:
 * a sentence in the present tense about an external system is true until the system moves, and
 * nothing in a document notices when it does.
 *
 * **The history is not the problem.** Those passages exist to answer "why did `latest` hold a
 * placeholder at all?" — npm sets it on a package's first publish whatever `--tag` says, and refuses
 * to remove it — and the bootstrap procedure below them is still the procedure. What this file
 * refuses is the *tense*, not the content: the pre-stable layout has to be marked as the state it
 * was, and a reader who checks `npm view` has to end up agreeing with the page.
 */
describe("the runbooks do not describe the pre-stable registry as current", () => {
  it("carries the refuted claims nowhere outside a quotation", () => {
    // Each was a real sentence in one of these files. Block quotes are stripped first, because a
    // correction that shows what it replaced is the form this repository uses and a check that
    // forbade the words would forbid the explanation.
    const refuted = [
      "currently names `0.0.0-bootstrap.0`",
      "sit in the same place, and it is the correct place",
      "shows the same shape on the registry today",
    ];
    for (const file of RUNBOOKS) {
      const live = read(file)
        .split("\n")
        .filter((line) => !line.trimStart().startsWith(">"))
        .join("\n");
      for (const claim of refuted) {
        expect(live, `${file} still asserts: ${claim}`).not.toContain(claim);
      }
    }
  });

  it("marks the placeholder layout as the state it was", () => {
    // The block itself stays — it is the answer the bootstrap procedure rests on. What has to be
    // beside it is when it was true.
    const cli = read("docs/maintainers/release-cli.md");
    expect(cli).toContain("latest:    0.0.0-bootstrap.0");
    expect(cli).toContain("at bootstrap time");

    const sdk = read("docs/maintainers/release-sdk.md");
    expect(sdk).toContain("Before the first stable release");
  });

  it("says what moved it, rather than leaving the reader to infer", () => {
    // A page that only stopped making the claim would leave a reader wondering whether the
    // placeholder is still there. Both runbooks name the release that moved `latest` and point at
    // the measured reading.
    expect(read("docs/maintainers/release-sdk.md")).toContain("#closeout-evidence--010");
    expect(read("docs/maintainers/release-cli.md")).toContain(
      "[After the release](#after-the-release)",
    );
  });

  it("keeps the bootstrap tag described as surviving a stable release", () => {
    // The placeholder is not retired when `latest` moves, and both files have to keep saying so —
    // the channel contract requires `bootstrap` to be present and exact on every later release.
    for (const file of RUNBOOKS) {
      expect(read(file), file).toContain("`bootstrap`");
    }
    expect(read("docs/maintainers/release-sdk.md")).toContain("name-reservation history");
    expect(read("docs/maintainers/release-cli.md")).toContain("not\nretired by a stable release");
  });

  it("does not describe `latest` as the placeholder in a contract table", () => {
    // Found by re-reading `main...HEAD` rather than by the audit's own grep, which looked for
    // `currently` / `today` / "sit in the same place". This row said what `latest` *is*, with the
    // qualifier "until the first stable release moves it" doing the work of a tense — and the first
    // stable release had moved it.
    const cli = read("docs/maintainers/release-cli.md");
    expect(cli).not.toContain(
      "| `latest` | the `0.0.0-bootstrap.0` placeholder, until the first stable release moves it |",
    );
    expect(cli).toMatch(/\| `latest` \| a stable release, once one exists\./);
  });

  it("does not say the latest canary cells are still refusing a placeholder", () => {
    // Same shape, in the criteria list: `S5`'s evidence was written while `R6` was open and said
    // the `latest` cells "report the placeholder rather than installing it, and go green when `R6`
    // does". `R6` is met, so they are green and they are not reporting a placeholder.
    const criteria = read("docs/maintainers/release-criteria.md");
    expect(criteria).not.toContain("and go green when `R6` does");
    expect(criteria).toContain("This row is coverage; the green result is `R6`");
  });

  it("does not claim either package is absent from npm", () => {
    // Four passages outlived the first publication and were still on `main` after the stable
    // release: the CLI runbook said "`fairux` is absent from npm" and "It has never run green, and
    // cannot until `fairux` is published"; `release-dry-run.mjs` said "does not exist on npm yet …
    // the current, correct external state"; `platforms.md` recorded two beta versions as what the
    // canaries were green on.
    //
    // None uses `currently`, `today`, or any word the earlier audit grepped for, which is why they
    // survived it. The claim itself is what is forbidden here, in any tense.
    const files = [
      ...RUNBOOKS,
      "apps/cli/scripts/release-dry-run.mjs",
      "docs/reference/platforms.md",
    ];
    for (const file of files) {
      const live = read(file)
        .split("\n")
        .filter((line) => !line.trimStart().startsWith(">"))
        .join("\n")
        .replace(/\s+/g, " ");
      for (const claim of [
        /`?fairux`? is absent from npm/,
        /does not exist on npm/,
        /has never run green/,
        /every read of it is an E404/,
      ]) {
        expect(live, `${file} asserts: ${claim}`).not.toMatch(claim);
      }
    }
  });

  it("keeps the reason the rehearsal reads no registry, which is not a state", () => {
    // The passages above were deleted, not replaced with nothing: why the dry run avoids the
    // registry is a design decision worth stating, and it is the half that stays true.
    const dryRun = read("apps/cli/scripts/release-dry-run.mjs");
    expect(dryRun).toContain("deliberately does not rehearse is the registry");
    expect(dryRun).toContain("would answer differently before and after a publication");
  });

  it("records no canary result on the platforms page", () => {
    // A page about supported platforms would have to be edited after every release to keep such a
    // note true, and it was not: it named `0.1.0-beta.1` and `0.1.0-beta.3` as what was green.
    const platforms = read("docs/reference/platforms.md");
    expect(platforms).not.toMatch(/\d+\.\d+\.\d+-(?:beta|rc|alpha)\.\d+/);
    expect(platforms).not.toContain("Both are green");
    expect(platforms).toContain("What they last measured is not recorded here");
  });

  it("leaves no bare `currently` or `today` asserting a registry state", () => {
    // Narrow on purpose. `currently prepared in packages/sdk/package.json` is about the manifest in
    // this checkout and stays true by construction; what is forbidden is the same word next to a
    // dist-tag or a placeholder version.
    for (const file of RUNBOOKS) {
      const live = read(file)
        .split("\n")
        .filter((line) => !line.trimStart().startsWith(">"))
        .join("\n")
        .replace(/\s+/g, " ");
      for (const match of live.matchAll(/\b(currently|today)\b/g)) {
        const window = live.slice(Math.max(0, match.index - 120), match.index + 120);
        expect(
          /0\.0\.0-bootstrap\.0|dist-tag|`latest`|`next`/.test(window),
          `${file}: "${match[1]}" sits beside a registry-state claim — ${window.trim()}`,
        ).toBe(false);
      }
    }
  });
});

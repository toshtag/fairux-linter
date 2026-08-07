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

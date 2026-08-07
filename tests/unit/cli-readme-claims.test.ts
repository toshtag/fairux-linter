import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI_README = readFileSync(join(ROOT, "apps/cli/README.md"), "utf8");

/**
 * Two sentences in the CLI README outlived the code they described, and both said a shipped feature
 * does not exist — the failure mode a reader cannot detect, because the honest-sounding answer and
 * the wrong one are the same sentence.
 *
 * These are negative assertions on purpose. What the README says about the HTML report and about
 * suppressions is prose, and pinning prose is how a document stops being editable; what it may not
 * do is go back to denying a capability the build ships. Rewording is free, re-asserting is not.
 *
 * The behaviour itself is pinned where it belongs: `packages/report/test/html.test.ts` for the
 * panels, and the CLI's suppression and baseline suites for the rest.
 */
describe("what the CLI README says the build cannot do", () => {
  it("does not deny the HTML report's coverage or Risk Index panels", () => {
    // `toHtml` has rendered a coverage panel since coverage existed and a Risk Index panel since
    // `--risk-index` did. The README said "No charts, scores, or coverage. Those do not exist yet."
    expect(CLI_README).not.toContain("No charts, scores, or coverage");
    expect(CLI_README).not.toMatch(/coverage[^.]*do(es)? not exist/i);
    // The claim worth keeping, which is about a grade rather than about a panel.
    expect(CLI_README).toMatch(/no grade/i);
  });

  it("does not deny inline suppression directives", () => {
    // The README documents `fairux-disable-next-line` with examples, and then said it is not
    // supported — 72 lines apart, in one file, while `scan()` had been applying them for months.
    expect(CLI_README).toContain("fairux-disable-next-line");
    expect(CLI_README).not.toMatch(/fairux-disable[^)]*\)? are \*\*not\*\* supported/);
    expect(CLI_README).not.toMatch(/[Ii]nline source comments.*not.*supported/);
  });

  it("still says an inline directive leaves nothing for a baseline to match", () => {
    // The limitation that replaced the false claim, and the one thing a reader combining the two
    // mechanisms needs. It is not fixed, so it must not quietly stop being written down.
    //
    // Checked as four ideas inside the section that owns them, rather than as a sentence: "leaves no
    // fingerprint" and "the report does not preserve the fingerprint" are the same claim, and a test
    // that accepted only the first would be the prose lock this file argues against two tests above.
    const suppressions = section(CLI_README, "### Suppressions", "### Baselines");
    for (const idea of [/inline/i, /baseline/i, /fingerprint/i, /drop|stale|no longer/i]) {
      expect(suppressions, `the Suppressions section must still say ${idea}`).toMatch(idea);
    }
  });
});

/** The text between two headings, so a claim is checked where a reader would look for it. */
function section(doc: string, from: string, to: string): string {
  const start = doc.indexOf(from);
  if (start < 0) throw new Error(`no "${from}" heading`);
  const end = doc.indexOf(to, start + from.length);
  if (end < 0) throw new Error(`no "${to}" heading after "${from}"`);
  return doc.slice(start, end);
}

/**
 * The status sentence in each published README.
 *
 * These files ship inside the tarballs, so a stale claim here is a stale claim on npm — read by
 * everybody who installs the package and corrected by nobody. The CLI's said `fairux@0.1.0-beta.1`
 * was "package-ready but this repository has not completed the public npm beta release", for two
 * releases after both halves stopped being true.
 *
 * Two rules, and neither snapshots the prose. No version literal, because a README is not where a
 * version is maintained; and no claim that the package is unpublished, because the runbooks are
 * where publication state lives and they are machine-checked against the registry.
 */
describe("the published READMEs do not carry a version or deny a release", () => {
  const readmes = {
    "apps/cli/README.md": readFileSync(join(ROOT, "apps/cli/README.md"), "utf8"),
    "packages/sdk/README.md": readFileSync(join(ROOT, "packages/sdk/README.md"), "utf8"),
  } as const;

  it("names a channel rather than a version", () => {
    for (const [path, text] of Object.entries(readmes)) {
      // Install commands and prose alike. The historical mention in the CLI's own correction is
      // quoted with the package name attached (`fairux@0.1.0-beta.1`), which this deliberately
      // still catches — so it is written without one.
      expect(text, path).not.toMatch(/\d+\.\d+\.\d+-(?:beta|rc|alpha)\.\d+/);
    }
  });

  it("gives an install command the default channel actually resolves", () => {
    // While `latest` named the `0.0.0-bootstrap.0` placeholder, a bare `npx fairux` installed a
    // deprecated name reservation, so the quick start had to say `@next`. The stable release moved
    // `latest`, so the bare form is the correct one again — and a README still sending readers to
    // `@next` for the *primary* install would point them at a prerelease.
    for (const [path, text] of Object.entries(readmes)) {
      const fences = [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
      const installs = fences
        .flatMap((fence) => fence.split("\n"))
        .filter(
          (line) => /^(?:npm|pnpm|npx)\b/.test(line.trim()) && !line.includes("--save-dev fairux@"),
        );
      expect(installs.length, `${path} has no install command`).toBeGreaterThan(0);
      for (const line of installs) {
        expect(line, `${path}: ${line}`).not.toMatch(/@next\b/);
      }
    }
    // The prerelease channel is still documented, in prose rather than as the command to run.
    for (const [path, text] of Object.entries(readmes)) {
      expect(text, path).toContain("@next");
    }
  });

  it("does not claim the package is unpublished", () => {
    for (const [path, text] of Object.entries(readmes)) {
      expect(text, path).not.toMatch(/has not completed the public npm|is not on npm/i);
      expect(text, path).toMatch(/[Pp]ublished on npm/);
    }
  });

  it("sends a reader somewhere that knows the published version, rather than stating one", () => {
    // Not necessarily the runbook. The SDK README pointed at a Markdown table there, which was the
    // repository keeping a publication record by hand; that table is gone and `npm view` is the
    // answer. What must not come back is a version literal — the rule above — or a reader left with
    // no way to find out.
    for (const [path, text] of Object.entries(readmes)) {
      expect(text, path).toMatch(/npm view|docs\/maintainers\/release-(cli|sdk)\.md/);
    }
  });
});

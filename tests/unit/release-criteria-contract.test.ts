import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CRITERIA_PATH = "docs/maintainers/release-criteria.md";
const CRITERIA = readFileSync(join(ROOT, CRITERIA_PATH), "utf8");
const SECURITY = readFileSync(join(ROOT, "docs/reference/security-boundary.md"), "utf8");

interface Criterion {
  readonly id: string;
  readonly text: string;
  readonly status: string;
  readonly evidence: string;
}

/**
 * Rows of the criteria tables: `| P1 | … | met | … |`.
 *
 * The status alternation is deliberately *not* the list of valid statuses — it is `[^|]+`, so a row
 * with a status nobody recognises is still a row and is caught by the assertion below rather than
 * skipped. A parser that only matches the statuses it approves of reports a clean list by ignoring
 * everything wrong with it, which is the failure this file exists to prevent.
 */
function criteria(): Criterion[] {
  return [...CRITERIA.matchAll(/^\|\s*([PCSR]\d+)\s*\|([^|]+)\|\s*([^|]+?)\s*\|([^|]+)\|$/gm)].map(
    (match) => ({
      id: match[1] as string,
      text: (match[2] as string).trim(),
      status: match[3] as string,
      evidence: (match[4] as string).trim(),
    }),
  );
}

/**
 * A criteria list that scores itself passing is worthless.
 *
 * The shape is what is enforced here, not the verdicts: every row says met or open, every row
 * carries something a reader can follow, and a `met` row's evidence points at something that exists.
 * Whether an item *should* be met is a maintainer's call and not a test's.
 */
describe("the 1.0 criteria", () => {
  const rows = criteria();

  it("has rows at all, across every section", () => {
    // A regex that matched nothing would make every assertion below vacuous — and one that matched
    // most of them would be worse, since it would look like it was working. The count is asserted
    // against the tables themselves.
    const tableRows = [...CRITERIA.matchAll(/^\|\s*[PCSR]\d+\s*\|/gm)].length;
    expect(rows.length).toBe(tableRows);
    expect(rows.length).toBeGreaterThanOrEqual(17);
    for (const prefix of ["P", "C", "S", "R"]) {
      expect(rows.some((row) => row.id.startsWith(prefix))).toBe(true);
    }
  });

  it("gives every criterion a status and evidence", () => {
    for (const row of rows) {
      expect(["met", "open", "n/a"], `${row.id} has an unrecognised status`).toContain(row.status);
      expect(row.evidence.length, `${row.id} has no evidence or requirement`).toBeGreaterThan(20);
      expect(row.text.length, `${row.id} has no criterion text`).toBeGreaterThan(10);
    }
  });

  it("points every met criterion at something that exists", () => {
    // A link to a document nobody wrote is the shape a criteria list rots into.
    for (const row of rows.filter((entry) => entry.status === "met")) {
      for (const match of row.evidence.matchAll(/\]\(([^)]+)\)/g)) {
        const target = (match[1] as string).split("#")[0] as string;
        if (target.startsWith("http")) continue;
        // Resolved against the criteria document's own directory, the way a reader's link does.
        expect(
          existsSync(join(ROOT, dirname(CRITERIA_PATH), target)),
          `${row.id} cites ${target}, which does not exist`,
        ).toBe(true);
      }
    }
  });

  it("says what each open criterion needs, rather than only that it is open", () => {
    const open = rows.filter((entry) => entry.status === "open");
    expect(open.length).toBeGreaterThan(0);
    for (const row of open) {
      expect(
        /needs|blocked|cannot|until|never had|never done/i.test(row.evidence),
        `${row.id} is open without saying what it needs`,
      ).toBe(true);
    }
  });

  it("names a trigger on every n/a criterion", () => {
    const notApplicable = rows.filter((entry) => entry.status === "n/a");
    // `n/a` is the status that could be abused to make a gap disappear, so it carries the extra
    // requirement: say what would make it apply.
    expect(notApplicable.length).toBeGreaterThan(0);
    for (const row of notApplicable) {
      expect(
        /nothing has (broken|triggered)|until|fails this row|becomes required/i.test(row.evidence),
        `${row.id} is n/a without naming what would trigger it`,
      ).toBe(true);
    }
  });

  it("fails the migration-guide row the moment something actually breaks", () => {
    // The whole reason `n/a` is allowed rather than a promise in prose. `C5` says a migration guide
    // exists for anything that broke, and it reads `n/a` because nothing has. This is the check
    // that turns that from an assertion into a measurement — the two things that would break it are
    // read from the code, not from the document.
    const migration = rows.find((row) => row.id === "C5");
    expect(migration).toBeDefined();
    if (migration?.status !== "n/a") return;

    // The report schema version, as the type declares it.
    const types = readFileSync(join(ROOT, "packages/core/src/types.ts"), "utf8");
    const declared = /schemaVersion: "([^"]+)"/.exec(types)?.[1];
    expect(declared, "the report schemaVersion could not be read").toBeDefined();
    expect(declared, "schemaVersion moved while C5 still reads n/a").toBe("0.1");

    // And the version of every package this repository publishes.
    for (const manifest of ["packages/sdk/package.json", "apps/cli/package.json"]) {
      const version = JSON.parse(readFileSync(join(ROOT, manifest), "utf8")).version as string;
      expect(
        version.startsWith("0."),
        `${manifest} is ${version} — a major moved while C5 still reads n/a`,
      ).toBe(true);
    }
  });

  it("keeps the corpus claim separate from the claim nobody has evidence for", () => {
    // One row used to carry both, and only one of them was true. The corpus measurement is real;
    // "detection quality is measured" full stop is not, because 51 of 57 pages were written by
    // whoever wrote the rules and the other six were used to fix one.
    const onCorpus = rows.find((row) => row.id === "P3");
    expect(onCorpus?.status).toBe("met");
    expect(onCorpus?.text).toContain("corpus this project assembled");

    const holdout = rows.find((row) => row.id === "P7");
    expect(holdout?.status).toBe("open");
    expect(holdout?.text).toContain("has not tuned against");
    // Named as never done, not as pending — and the reason the existing third-party pages do not
    // count is in the row rather than in someone's memory.
    expect(holdout?.evidence).toMatch(/never done/i);
    expect(holdout?.evidence).toContain("training data");
  });

  it("says what the holdout criterion requires, so a smaller thing cannot close it", () => {
    // "Measured on external pages" is a sentence several weaker things satisfy. The conditions are
    // written before there is a number to argue about, which is the only time they can be.
    const section = CRITERIA.slice(CRITERIA.indexOf("### What `P7` requires"));
    expect(section.length, "the P7 conditions section is missing").toBeGreaterThan(200);
    for (const requirement of [
      "Per-rule minimums, positive and negative",
      "Stratified by locale and by runtime",
      "Immutable once evaluated",
      "Uncertainty reported with the number",
    ]) {
      expect(section, `P7 should require: ${requirement}`).toContain(requirement);
    }
    // And the reason a negative minimum is per rule rather than per corpus, which is the condition
    // most easily dropped as an implementation detail.
    expect(section).toContain("false-positive rate");
  });

  it("gathers the open items, and the gathering matches the table", () => {
    const gathered = CRITERIA.slice(CRITERIA.indexOf("## Open items, gathered"));
    for (const row of rows.filter((entry) => entry.status === "open")) {
      expect(gathered, `${row.id} is open but not gathered`).toContain(`\`${row.id}\``);
    }
    for (const row of rows.filter((entry) => entry.status !== "open")) {
      // `n/a` as well as `met`. The status exists to keep a row that cannot be closed out of the
      // open list; naming it there anyway would put it back.
      expect(gathered, `${row.id} is ${row.status} but listed as open`).not.toContain(
        `\`${row.id}\``,
      );
    }
  });

  it("says what 1.0 would not mean", () => {
    // The half a version number is most likely to be read as promising.
    expect(CRITERIA).toContain("It would **not** mean");
    expect(CRITERIA).toContain("clean scan is a safe product");
  });

  it("records the CLI publication against what was measured, not against the attempt", () => {
    // This asserted the blocker while there was one. What replaced it is the standard the blocker's
    // own text set: a criterion marked met has to name the evidence, and "we ran a release" is not
    // evidence — the SDK's closeout once recorded a successful publish as a failure.
    const publication = rows.find((row) => row.id === "R2");
    expect(publication?.status).toBe("met");
    expect(publication?.evidence).toContain("0.1.0-beta.1");
    expect(publication?.evidence).toContain("Trusted Publishing");
    expect(publication?.evidence).toContain("provenance");

    const smoke = rows.find((row) => row.id === "R3");
    expect(smoke?.status).toBe("met");
    expect(smoke?.evidence).toContain("registry-cli-smoke.yml");
    // Four cells, named: two platforms on both Node floors, which is what the workflow runs.
    expect(smoke?.evidence).toContain("Linux and Windows on both Node floors");
  });
});

describe("the security boundary", () => {
  it("states what is trusted, not only what is not", () => {
    expect(SECURITY).toContain(
      "A third-party RulePack is executable JavaScript that FairUX does not sandbox",
    );
    expect(SECURITY).toContain("What is untrusted");
  });

  it("lists what FairUX will not do, including the AI boundaries", () => {
    for (const refusal of [
      "Return a verdict",
      "Auto-apply an AI-suggested edit",
      "Let an AI signal fail a build",
      "Send anything that was not on an allowlist",
      "Call the network from the engine",
      // Not "under an old approval", and not "let a pull request approve itself": both named a
      // protected approval environment that was removed, and this test was holding the boundary to
      // a promise no workflow could keep. A pinned phrase keeps a claim present, never true.
      //
      // "Nobody reviewed" was the third, and "silently" the fourth. What the digest holds is
      // narrower than either: `rules:reviews:check` fails on the pull request until the regenerated
      // baseline is in the diff. It does not show anyone read that diff — `main` carries no branch
      // protection and the repository has no CODEOWNERS — and a direct push does not pass through
      // a pull request at all, so "ship" was still wider than the check.
      "Let a rule change pass pull-request CI without a matching review baseline",
    ]) {
      expect(SECURITY, `the boundary should state: ${refusal}`).toContain(refusal);
    }
  });

  it("decides the network capability rather than leaving it unbuilt", () => {
    // Four questions had to be answered before any code, and an answer that lives only in an issue
    // is an answer the next person re-litigates. Each one is a sentence here or it is not decided.
    expect(SECURITY).toContain("Watch the requests a page makes");
    // The permission, which is the decision the other three rest on — and the reason for it, which
    // is a product boundary rather than a technical impossibility. A page claiming it cannot be done
    // would be making a false argument for a decision that does not need one.
    expect(SECURITY).toContain("The extension permission is refused");
    expect(SECURITY).toContain("It is **not** true that this is technically impossible today");
    expect(SECURITY).toContain("do not fit this product");
    // And the API that is not an observation API, so it stops being listed as one.
    expect(SECURITY).toContain("`declarativeNetRequest` is not one of the options");
    // No door left open in this extension.
    expect(SECURITY).toContain("No optional permission is left as a door");
    // Privacy, the report shape, and the Purchase Guard line.
    expect(SECURITY).toContain("registrable domain");
    expect(SECURITY).toContain("never sit inside a finding's evidence");
    expect(SECURITY).toContain("never a claim about the **destination**");
    // And why the accurate answer today is "unavailable" rather than a partial implementation.
    expect(SECURITY).toContain("worse than one reported as missing");
  });

  it("admits what it has not had", () => {
    // A security page that only lists its defences reads like a claim to have been tested.
    expect(SECURITY).toContain("has not had a third-party security review");
    expect(SECURITY).toContain("weaker thing than having been attacked by someone competent");
  });
});

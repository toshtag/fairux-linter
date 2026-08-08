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
  readonly gate: string;
  readonly status: string;
  readonly evidence: string;
}

/**
 * Rows of the criteria tables: `| P1 | … | 0.x | met | … |`.
 *
 * The gate and status alternations are deliberately *not* the lists of valid values — they are
 * `[^|]+`, so a row with a gate or a status nobody recognises is still a row and is caught by the
 * assertions below rather than skipped. A parser that only matches the values it approves of
 * reports a clean list by ignoring everything wrong with it, which is the failure this file exists
 * to prevent.
 */
function criteria(): Criterion[] {
  return [
    ...CRITERIA.matchAll(
      /^\|\s*([PCSR]\d+)\s*\|([^|]+)\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|([^|]+)\|$/gm,
    ),
  ].map((match) => ({
    id: match[1] as string,
    text: (match[2] as string).trim(),
    gate: match[3] as string,
    status: match[4] as string,
    evidence: (match[5] as string).trim(),
  }));
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

  it("gives every criterion a gate, a status, and evidence", () => {
    for (const row of rows) {
      expect(["met", "open", "n/a"], `${row.id} has an unrecognised status`).toContain(row.status);
      expect(["0.x", "1.0"], `${row.id} has an unrecognised gate`).toContain(row.gate);
      expect(row.evidence.length, `${row.id} has no evidence or requirement`).toBeGreaterThan(20);
      expect(row.text.length, `${row.id} has no criterion text`).toBeGreaterThan(10);
    }
  });

  it("keeps the two 1.0 gates that need somebody outside this repository", () => {
    // The split exists so a stable `0.x` is not blocked on evidence nobody here can produce. It
    // would be worthless if the split were also used to quietly downgrade what `1.0` requires, so
    // both rows are pinned as `1.0` and as `open`, with the issue that tracks them.
    const holdout = rows.find((row) => row.id === "P7");
    expect(holdout?.gate).toBe("1.0");
    expect(holdout?.status).toBe("open");
    expect(holdout?.evidence).toContain("280");

    const review = rows.find((row) => row.id === "S6");
    expect(review?.gate).toBe("1.0");
    expect(review?.status).toBe("open");
    expect(review?.evidence).toContain("281");

    // And the document has to say, in prose, that the split did not weaken them — the sentence a
    // reader needs when they find a `1.0` row on a page that also describes a stable release.
    expect(CRITERIA).toContain("The 1.0 criteria are not weakened by this split.");
  });

  it("keeps every 0.x criterion closable from inside this repository", () => {
    // This is the whole claim the split rests on. A `0.x` row that needed an outside party would
    // put the stable release back behind the same wall the beta was behind, and it would do it
    // quietly — the row would simply sit open.
    for (const row of rows.filter((entry) => entry.gate === "0.x" && entry.status === "open")) {
      expect(
        /Needs the .* release|Needs one green dispatch|Cannot run until/i.test(row.evidence),
        `${row.id} is an open 0.x criterion whose requirement is not an action this repository takes`,
      ).toBe(true);
    }
    // And the document says, in a heading, whether that gate is met or what it is waiting on. The
    // heading moves when the last row closes, so both spellings are accepted and the *state* is
    // checked against the rows rather than against the prose.
    const openZeroX = rows.filter((row) => row.gate === "0.x" && row.status === "open");
    if (openZeroX.length === 0) {
      expect(CRITERIA).toContain("## The 0.x stable gate is met");
      // A met gate is the sentence most likely to be over-read, so the document has to keep saying
      // what it does not cover.
      expect(CRITERIA).toContain("It says nothing about API stability");
    } else {
      expect(CRITERIA).toContain("## What the 0.x stable gate is waiting on");
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
    // "detection quality is measured" full stop is not, because most pages were written by whoever
    // wrote the rules and the third-party ones were used to fix a rule.
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

  it("records the stable publication as a criterion, not as an assumption", () => {
    // The 0.x gate is a *publication* gate as well as a product one. Without these two rows the
    // document would describe a stable release as complete while both packages still sat on the
    // bootstrap placeholder — the state npm leaves `latest` in when a name is reserved.
    const published = rows.find((row) => row.id === "R5");
    expect(published?.gate).toBe("0.x");
    expect(published?.text).toContain("latest");

    const smoked = rows.find((row) => row.id === "R6");
    expect(smoked?.gate).toBe("0.x");
    expect(smoked?.text).toContain("latest");

    // `met` is the direction that can lie. A row claiming both packages are stable on `latest`
    // while a manifest still carries a prerelease is a criterion recording a release that did not
    // happen — and the version it would have been recorded for is readable from the repository.
    //
    // The other direction is deliberately not asserted: `open` beside a stable manifest is the
    // normal state of the preparation pull request, where the version is bumped and nothing has
    // been published yet.
    for (const manifest of ["packages/sdk/package.json", "apps/cli/package.json"]) {
      const version = JSON.parse(readFileSync(join(ROOT, manifest), "utf8")).version as string;
      if (published?.status === "met") {
        expect(
          version.includes("-"),
          `R5 reads met while ${manifest} is the prerelease ${version}`,
        ).toBe(false);
      }
    }
  });

  it("does not say the whole 1.0 list is external when one of it is not", () => {
    // The page had it right in one paragraph — "Two of the three need somebody outside this
    // repository" — and contradicted it four paragraphs later with "Nothing on the 1.0 list can be
    // closed from inside this repository". `C6` is on that list and is this project's own decision:
    // the compatibility document stating the major-version guarantee, and the inventory holding
    // across a release cycle. Neither needs an outside party, and `C6` carries no
    // `external-evidence` label because of it.
    expect(CRITERIA).not.toContain("Nothing on the 1.0 list can be closed from inside");
    expect(CRITERIA).toContain(
      "Two of the three 1.0 criteria cannot be closed from inside this repository",
    );

    // And the split is stated per row rather than as a count a reader has to map onto rows.
    const gathered = CRITERIA.slice(CRITERIA.indexOf("## Open items, gathered"));
    for (const external of ["P7", "S6"]) {
      expect(gathered, `${external} should be marked external`).toMatch(
        new RegExp(`\\\`${external}\\\`[^\n]*somebody outside this repository`),
      );
    }
    expect(gathered, "C6 should be marked as work this repository does").toMatch(
      /`C6` \| work in this repository/,
    );
    // The label is the machine-readable half of the same claim, so it must not spread to `C6`.
    const c6Line = gathered.split("\n").find((line) => line.startsWith("| `C6` |")) ?? "";
    expect(c6Line).not.toContain("external-evidence");
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
    // Not the manifest's version. This asserted `evidence.includes(manifestVersion)`, which was
    // right while the manifest named the release the row records and is wrong as soon as a version
    // is prepared: the row is a record of a *past* publication and the manifest is the *next* one.
    // It would also have passed by coincidence the moment the manifest read `0.1.0`, because
    // `"0.1.0-beta.2".includes("0.1.0")` — a stale row hidden by a substring.
    //
    // What the row must carry is what was measured: a version, the channel it reached, and the two
    // mechanisms. `R5` is the criterion for the stable publication, and it is separately pinned.
    expect(publication?.evidence).toMatch(/`?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`? on `next`/);
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

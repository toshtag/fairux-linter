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

/** Rows of the criteria tables: `| P1 | … | met | … |`. */
function criteria(): Criterion[] {
  return [
    ...CRITERIA.matchAll(/^\|\s*([PCSR]\d+)\s*\|([^|]+)\|\s*(met|open)\s*\|([^|]+)\|$/gm),
  ].map((match) => ({
    id: match[1] as string,
    text: (match[2] as string).trim(),
    status: match[3] as string,
    evidence: (match[4] as string).trim(),
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
    // A regex that matched nothing would make every assertion below vacuous.
    expect(rows.length).toBeGreaterThanOrEqual(15);
    for (const prefix of ["P", "C", "S", "R"]) {
      expect(rows.some((row) => row.id.startsWith(prefix))).toBe(true);
    }
  });

  it("gives every criterion a status and evidence", () => {
    for (const row of rows) {
      expect(["met", "open"], `${row.id} has an unrecognised status`).toContain(row.status);
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
        /needs|blocked|cannot|until|nothing has broken|never had/i.test(row.evidence),
        `${row.id} is open without saying what it needs`,
      ).toBe(true);
    }
  });

  it("gathers the open items, and the gathering matches the table", () => {
    const gathered = CRITERIA.slice(CRITERIA.indexOf("## Open items, gathered"));
    for (const row of rows.filter((entry) => entry.status === "open")) {
      expect(gathered, `${row.id} is open but not gathered`).toContain(`\`${row.id}\``);
    }
    for (const row of rows.filter((entry) => entry.status === "met")) {
      expect(gathered, `${row.id} is met but listed as open`).not.toContain(`\`${row.id}\``);
    }
  });

  it("says what 1.0 would not mean", () => {
    // The half a version number is most likely to be read as promising.
    expect(CRITERIA).toContain("It would **not** mean");
    expect(CRITERIA).toContain("clean scan is a safe product");
  });

  it("keeps the CLI publication blocker where a reader will find it", () => {
    const publication = rows.find((row) => row.id === "R2");
    expect(publication?.status).toBe("open");
    expect(publication?.evidence).toContain("owner actions on npmjs.com");
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
      "Ship a rule change nobody reviewed",
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

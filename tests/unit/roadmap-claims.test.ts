import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_SPAWN_TIMEOUT_MS } from "../../apps/cli/test/cli-process-budget.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const roadmap = readFileSync(join(ROOT, "docs/roadmap.md"), "utf8");

/**
 * The built package, by relative path.
 *
 * Root tests cannot resolve `@fairux/*` — the workspace links live in each package, not here — so
 * they read the build, which is also what these claims are about: the roadmap describes what ships.
 */
// biome-ignore lint/suspicious/noExplicitAny: the dist entry points are untyped from here.
async function importDist(name: string): Promise<any> {
  return import(pathToFileURL(join(ROOT, `packages/${name}/dist/index.js`)).href);
}

/**
 * The roadmap says which milestones are finished. This checks that they are.
 *
 * Every claim below was verified by hand once, which is worth nothing the next time somebody asks:
 * a milestone marked complete is a claim about the code, and this repository's habit is that claims
 * about the code are checked rather than asserted. Eight paragraphs had already outlived what they
 * described before anyone read them (#198, #200) — all of them prose nothing tested.
 *
 * Deliberately about *capability*, not quality. That `fairux-risk/2` exists says nothing about
 * whether its constants are right; the corpus evaluation and the calibration are where that lives.
 */
describe("the roadmap's completion claims", () => {
  it("M2 — every daily-UX item it lists is a command or flag that exists", async () => {
    const { fairuxBuiltinRulePack } = await importDist("rules");
    expect(fairuxBuiltinRulePack.rules.length).toBeGreaterThan(0);

    const cli = join(ROOT, "apps/cli/dist/index.js");
    if (!existsSync(cli)) return; // `pnpm test` builds it; a bare vitest run may not have
    const help = execFileSync("node", [cli, "--help"], {
      encoding: "utf8",
      timeout: CLI_SPAWN_TIMEOUT_MS,
    });
    for (const command of ["rules", "explain", "scan-journey"]) {
      expect(help, command).toContain(command);
    }
    const scanHelp = execFileSync("node", [cli, "scan", "--help"], {
      encoding: "utf8",
      timeout: CLI_SPAWN_TIMEOUT_MS,
    });
    for (const flag of ["--rule-pack", "--baseline", "--suppress", "--format"]) {
      expect(scanHelp, flag).toContain(flag);
    }
  });

  it("M3 — every report carries coverage, and the four named capabilities are supplied", async () => {
    const core = await importDist("core");
    const html = await importDist("html");
    const parseHtml = html.parseHtml;
    const { fairuxBuiltinRulePack } = await importDist("rules");

    const supplied = new Set(
      core.BUILTIN_CAPABILITIES.map((capability: { id: string }) => capability.id),
    );
    // The roadmap names these four as supplied and unspent. Unspent is a rule decision; supplied is
    // a fact about the vocabulary, and it is the half a document can get wrong.
    for (const id of ["computed-style", "viewport", "form", "journey"]) {
      expect(supplied, id).toContain(id);
    }

    const report = core
      .createScanner({
        rulePacks: [fairuxBuiltinRulePack],
        toolVersion: "roadmap-claims",
        now: () => new Date(0),
      })
      .scan(parseHtml("<html><body><p>nothing here</p></body></html>", { file: "x" }));
    expect(report.coverage?.summary.total).toBeGreaterThan(0);
    expect(report.coverage?.capabilities.available.length).toBeGreaterThan(0);
  });

  it("M4 — both Risk Index models exist, and the default is the one it names", async () => {
    const rules = await importDist("rules");
    expect(
      rules.RISK_INDEX_MODELS.map((model: { version: string }) => model.version).sort(),
    ).toEqual(["fairux-risk/1", "fairux-risk/2"]);
    expect(rules.fairuxRiskIndexModel.version).toBe("fairux-risk/1");
  });

  it("M5 — a rule can locate an attribute, and both fix flags exist", async () => {
    const core = await importDist("core");
    expect(typeof core.removeAttributeEdit).toBe("function");
    expect(core.BUILTIN_CAPABILITIES.map((capability: { id: string }) => capability.id)).toContain(
      "source-range",
    );

    const cli = join(ROOT, "apps/cli/dist/index.js");
    if (!existsSync(cli)) return;
    const scanHelp = execFileSync("node", [cli, "scan", "--help"], {
      encoding: "utf8",
      timeout: CLI_SPAWN_TIMEOUT_MS,
    });
    expect(scanHelp).toContain("--fix-dry-run");
    expect(scanHelp).toContain("--fix-write");
  });

  it("M6 — the AI contract exists and nothing behind it does", async () => {
    const core = await importDist("core");
    expect(typeof core.buildAiPayload).toBe("function");
    expect(typeof core.runAiAugmentation).toBe("function");
    // The claim that matters: no provider ships. A default one would make "opt-in" a setting rather
    // than a fact, which is the whole reason the boundaries landed before the thing they bound.
    // Asserted from the exports, not from the sentence: nothing here is named like a provider, and
    // `runAiAugmentation` takes one as an argument.
    const exported = Object.keys(core).filter((name) => /provider/i.test(name));
    expect(exported, "a shipped provider would make opt-in a setting").toEqual([]);
  });

  it("every document it sends a reader to is there", () => {
    // The roadmap answers each contract question with a link rather than a restatement, which only
    // works while the link resolves. `check:doc-references` reads bare paths and `pnpm` commands;
    // these are markdown links, and this is where a broken one is a wrong claim rather than a 404.
    for (const doc of [
      "docs/generated/sdk-api-inventory.md",
      "docs/reference/compatibility.md",
      "docs/reference/platforms.md",
      "docs/reference/security-boundary.md",
      "docs/maintainers/release-criteria.md",
      "docs/reference/report-schema.md",
      "docs/reference/risk-index.md",
      "docs/generated/rule-catalog.md",
    ]) {
      expect(existsSync(join(ROOT, doc)), doc).toBe(true);
    }
    for (const workflow of [
      "registry-consumer-smoke.yml",
      "registry-cli-smoke.yml",
      "sarif-upload-canary.yml",
    ]) {
      expect(existsSync(join(ROOT, ".github/workflows", workflow)), workflow).toBe(true);
    }
  });

  it("names what shipped and what has not, and neither is blocked on writing code here", () => {
    // The honest half. A page that only listed what shipped would let the unfinished milestone
    // quietly become finished-sounding, and the AI one's remainder is a decision about sending page
    // content to a third party rather than anything to build.
    //
    // Two headings and two sentences used to be pinned here, so rewording either failed this test.
    // What they were standing in for is an install command a reader can run: it was
    // `-g fairux@next` while `latest` held the deprecated placeholder, and it has to be the one the
    // default channel resolves now that a stable release moved it.
    expect(roadmap).toMatch(/npm install -g fairux\b/);
    expect(roadmap, "a channel or a version pins a reader to something that moves").not.toMatch(
      /npm install -g fairux@/,
    );
    // No version in prose: the changelog and the runbook are the one place each fact is maintained.
    expect(roadmap).not.toMatch(/fairux@\d+\.\d+\.\d+/);
  });

  it("separates a stable 0.x from 1.0, and says what neither claims", () => {
    // One list, and it was 1.0's, so leaving beta was blocked on a third-party security review.
    // The roadmap is the page most readers reach first, so the distinction has to be on it — and
    // it has to keep saying what a stable `0.x` does *not* claim, which is the half a status page
    // drops when it is summarised.
    // The heading and two sentences were pinned word for word. What has to hold is that both gates
    // are on the page and that the rows are not copied onto it — the wording is the author's.
    expect(roadmap).toMatch(/\b0\.x\b/);
    expect(roadmap).toMatch(/\b1\.0\b/);
    // The criteria document owns the rows; the roadmap points at it.
    expect(roadmap).toContain("maintainers/release-criteria.md");
    // No row IDs restated: two copies of a status is how one of them goes stale.
    expect(roadmap).not.toMatch(/\|\s*[PCSR]\d+\s*\|/);
  });

  it("keeps what is not built as decisions rather than as a to-do list", () => {
    // Each row of that table names where the decision is written. The failure this guards is the
    // opposite of a stale claim: a gap quietly losing its reason and becoming a backlog item.
    // The heading was pinned word for word. What matters is that the page still refuses things
    // rather than listing them as pending, and `Refused` is the word that does it.
    expect(roadmap).toMatch(/\bRefused\b/);
  });
});

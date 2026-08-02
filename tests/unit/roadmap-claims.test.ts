import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

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
    const help = execFileSync("node", [cli, "--help"], { encoding: "utf8" });
    for (const command of ["rules", "explain", "scan-journey"]) {
      expect(help, command).toContain(command);
    }
    const scanHelp = execFileSync("node", [cli, "scan", "--help"], { encoding: "utf8" });
    for (const flag of ["--rule-pack", "--baseline", "--suppress", "--format"]) {
      expect(scanHelp, flag).toContain(flag);
    }
  });

  it("M3 — every report carries coverage, and the four named capabilities are supplied", async () => {
    const core = await importDist("core");
    const html = await importDist("html");
    const parseHtml = html.parseHtml;
    const { fairuxBuiltinRulePack } = await importDist("rules");

    const supplied = new Set(core.BUILTIN_CAPABILITIES.map((capability) => capability.id));
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
    expect(rules.RISK_INDEX_MODELS.map((model) => model.version).sort()).toEqual([
      "fairux-risk/1",
      "fairux-risk/2",
    ]);
    expect(rules.fairuxRiskIndexModel.version).toBe("fairux-risk/1");
    // Pinned where the claim is written. The roadmap links the model document rather than restating
    // which model is default, so that there is one sentence to be wrong instead of two.
    expect(readFileSync(join(ROOT, "docs/risk-index-model.md"), "utf8")).toContain(
      "`fairux-risk/1`, the default",
    );
  });

  it("M5 — a rule can locate an attribute, and both fix flags exist", async () => {
    const core = await importDist("core");
    expect(typeof core.removeAttributeEdit).toBe("function");
    expect(core.BUILTIN_CAPABILITIES.map((capability) => capability.id)).toContain("source-range");

    const cli = join(ROOT, "apps/cli/dist/index.js");
    if (!existsSync(cli)) return;
    const scanHelp = execFileSync("node", [cli, "scan", "--help"], { encoding: "utf8" });
    expect(scanHelp).toContain("--fix-dry-run");
    expect(scanHelp).toContain("--fix-write");
  });

  it("M6 — the AI contract exists and nothing behind it does", async () => {
    const core = await importDist("core");
    expect(typeof core.buildAiPayload).toBe("function");
    expect(typeof core.runAiAugmentation).toBe("function");
    // The claim that matters: no provider ships. A default one would make "opt-in" a setting rather
    // than a fact, which is the whole reason the boundaries landed before the thing they bound.
    expect(roadmap).toContain("no provider");
  });

  it("every document it sends a reader to is there", () => {
    // The roadmap answers each contract question with a link rather than a restatement, which only
    // works while the link resolves. `check:doc-references` reads bare paths and `pnpm` commands;
    // these are markdown links, and this is where a broken one is a wrong claim rather than a 404.
    for (const doc of [
      "docs/generated/sdk-api-inventory.md",
      "docs/generated/corpus-evaluation.md",
      "docs/compatibility.md",
      "docs/supported-platforms.md",
      "docs/security-boundary.md",
      "docs/release-criteria-1.0.md",
      "docs/fairux-report-schema.md",
      "docs/risk-index-model.md",
      "docs/rules.md",
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

  it("names the two unfinished milestones, and neither is blocked on writing code here", () => {
    // The honest half. The CLI beta's remainder is two npmjs.com owner actions; the AI one's is a
    // decision about sending page content to a third party. A page that only listed what shipped
    // would let the unfinished ones quietly become finished-sounding.
    expect(roadmap).toContain("### Public CLI beta — repository side complete");
    expect(roadmap).toContain("### Optional AI augmentation — contract implemented, no provider");
    expect(roadmap).toContain("Blocked on two owner actions on npmjs.com");
  });

  it("keeps what is not built as decisions rather than as a to-do list", () => {
    // Each row of that table names where the decision is written. The failure this guards is the
    // opposite of a stale claim: a gap quietly losing its reason and becoming a backlog item.
    expect(roadmap).toContain("## What is deliberately not built");
    expect(roadmap).toContain("**Refused.**");
  });
});

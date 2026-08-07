import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { explainRule } from "../src/explain-rule.js";
import { listRules } from "../src/list-rules.js";
import { composeCliRulePacks, loadRulePack, RulePackLoadError } from "../src/load-rule-pack.js";
import { CLI_SPAWN_TIMEOUT_MS } from "./cli-process-budget.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");
const repoRoot = resolve(here, "../../..");
/** The authoring kit's own example, so this is checked against the pack the docs tell people to copy. */
const examplePack = resolve(repoRoot, "examples/rule-pack-author/src/index.ts");

const run = (args: string[]) =>
  spawnSync("node", [cliBin, ...args], { encoding: "utf8", timeout: CLI_SPAWN_TIMEOUT_MS });

/**
 * Async-aware on purpose. A synchronous `try/finally` around an async body removes the directory
 * before the module inside it is imported, and the loader then reports the file as missing — which
 * looks exactly like the refusal these tests are checking for elsewhere.
 */
async function withTempDir<T>(prefix: string, body: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loading an external rule pack", () => {
  it("loads the authoring kit's example, which exports neither default nor rulePack", async () => {
    const pack = await loadRulePack(examplePack);
    expect(pack.meta.id).toBe("@purchase-guard/jp-commerce");
  });

  it("warns by path, immediately before the module runs", async () => {
    // A RulePack is executable JavaScript and is not sandboxed. The warning has to name a path that
    // is actually about to run, so it is emitted after the path checks and before the import.
    const warned: string[] = [];
    await loadRulePack(examplePack, { onBeforeExecute: (p) => warned.push(p) });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("rule-pack-author");
  });

  it("does not run a module it is going to refuse for its path", async () => {
    const warned: string[] = [];
    await expect(
      loadRulePack("./definitely-not-here.mjs", { onBeforeExecute: (p) => warned.push(p) }),
    ).rejects.toBeInstanceOf(RulePackLoadError);
    expect(warned).toEqual([]);
  });

  it("refuses a directory, which the loader would resolve as a package", async () => {
    await expect(loadRulePack(repoRoot)).rejects.toThrow(/not a regular file/);
  });

  it("refuses a module that exports no pack", async () => {
    await withTempDir("fairux-pack-empty-", async (dir) => {
      const file = join(dir, "empty.mjs");
      writeFileSync(file, "export const answer = 42;\n", "utf8");
      await expect(loadRulePack(file)).rejects.toThrow(/exports no rule pack/);
    });
  });

  it("refuses a module exporting two packs rather than picking one", async () => {
    // Picking by order is how a user ends up running a pack they did not mean to.
    await withTempDir("fairux-pack-two-", async (dir) => {
      const file = join(dir, "two.mjs");
      const pack = (id: string) =>
        `{ meta: { id: "${id}", version: "0.1.0", engineApiVersion: "1", title: "t", ` +
        `status: "stable" }, rules: [] }`;
      writeFileSync(file, `export const a = ${pack("@a/x")};\nexport const b = ${pack("@b/y")};\n`);
      await expect(loadRulePack(file)).rejects.toThrow(/exports 2 rule packs \(a, b\)/);
    });
  });
});

describe("composing external packs", () => {
  it("puts the built-in pack first and keeps the external ones after it", async () => {
    const { packs, external } = await composeCliRulePacks([examplePack], {
      includeExperimental: true,
    });
    expect(packs[0]?.meta.id).toBe("@fairux/builtin");
    expect(external.map((pack) => pack.meta.id)).toEqual(["@purchase-guard/jp-commerce"]);
  });

  it("refuses a rule id that collides with a built-in one, before anything is scanned", async () => {
    // Built from an actual built-in rule, so the collision is real rather than a fixture that
    // happens to reuse a string.
    const { fairuxBuiltinRulePack } = await import("@fairux/rules");
    const collidingRule = fairuxBuiltinRulePack.rules[0];
    if (!collidingRule) throw new Error("expected the built-in pack to have a rule");

    await withTempDir("fairux-pack-collide-", async (dir) => {
      const file = join(dir, "collide.mjs");
      writeFileSync(
        file,
        `import { fairuxBuiltinRulePack } from ${JSON.stringify(
          resolve(repoRoot, "packages/rules/dist/index.js"),
        )};\n` +
          `export default { meta: { id: "@x/collide", version: "0.1.0", engineApiVersion: "1", ` +
          `title: "Collide", status: "stable" }, rules: [fairuxBuiltinRulePack.rules[0]] };\n`,
        "utf8",
      );
      await expect(composeCliRulePacks([file])).rejects.toThrow(
        new RegExp(`Duplicate rule id: ${collidingRule.meta.id}`),
      );
    });
  });
});

/**
 * The failure this could not have. `composeRulePacks` drops a pack whose own `status` is
 * `experimental` unless the flag is set — so a listing that flattened the packs would name a rule as
 * enabled that a scan with the same options never runs. The built-in pack is `stable`, so the two
 * agreed by accident until an external pack made the difference visible.
 */
describe("the listing describes the composed set, not the packs it was handed", () => {
  it("omits an experimental pack's rules without the flag, and includes them with it", async () => {
    const { packs } = await composeCliRulePacks([examplePack], { includeExperimental: true });

    const withoutFlag = listRules({ rulePacks: packs });
    expect(withoutFlag.rules.some((rule) => rule.id.startsWith("purchase-guard/"))).toBe(false);
    expect(withoutFlag.rulePacks.map((pack) => pack.id)).toEqual(["@fairux/builtin"]);

    const withFlag = listRules({ rulePacks: packs, includeExperimental: true });
    expect(withFlag.rules.some((rule) => rule.id.startsWith("purchase-guard/"))).toBe(true);
    expect(withFlag.rulePacks.map((pack) => pack.id)).toContain("@purchase-guard/jp-commerce");
  });

  it("explains an external rule only when it is in the composed set", async () => {
    const { packs } = await composeCliRulePacks([examplePack], { includeExperimental: true });
    expect(() => explainRule("purchase-guard/missing-return-policy", { rulePacks: packs })).toThrow(
      /unknown rule id/,
    );
    const explanation = explainRule("purchase-guard/missing-return-policy", {
      rulePacks: packs,
      includeExperimental: true,
    });
    expect(explanation.rulePack.id).toBe("@purchase-guard/jp-commerce");
  });

  it("names each rule's pack once there is more than one", () => {
    expect(listRules({}).rules.every((rule) => rule.rulePack === "@fairux/builtin")).toBe(true);
  });
});

describe("fairux --rule-pack (end-to-end)", () => {
  it("records every composed pack in the report envelope", async () => {
    await withTempDir("fairux-pack-scan-", (dir) => {
      const page = join(dir, "page.html");
      writeFileSync(page, "<html><body><button>Buy now</button></body></html>", "utf8");
      const report = JSON.parse(
        execFileSync(
          "node",
          [
            cliBin,
            "scan",
            page,
            "--format",
            "json",
            "--ignore-config",
            "--include-experimental",
            "--rule-pack",
            examplePack,
          ],
          { encoding: "utf8", timeout: CLI_SPAWN_TIMEOUT_MS },
        ),
      );
      // A report produced with an external pack that did not say so would be unattributable.
      expect(report.rulePacks.map((pack: { id: string }) => pack.id)).toEqual([
        "@fairux/builtin",
        "@purchase-guard/jp-commerce",
      ]);
    });
  });

  it("puts every composed pack's rules in the SARIF driver", async () => {
    await withTempDir("fairux-pack-sarif-", (dir) => {
      const page = join(dir, "page.html");
      writeFileSync(page, "<html><body><button>Buy now</button></body></html>", "utf8");
      const sarif = JSON.parse(
        execFileSync(
          "node",
          [
            cliBin,
            "scan",
            page,
            "--format",
            "sarif",
            "--ignore-config",
            "--include-experimental",
            "--rule-pack",
            examplePack,
          ],
          { encoding: "utf8", timeout: CLI_SPAWN_TIMEOUT_MS },
        ),
      );
      // Results whose rule id the consumer cannot resolve in the driver are results it cannot show.
      const ids = sarif.runs[0].tool.driver.rules.map((rule: { id: string }) => rule.id);
      expect(ids).toContain("purchase-guard/missing-return-policy");
    });
  });

  it("keeps the trusted-code warning on stderr so JSON stdout stays parseable", () => {
    const result = run([
      "rules",
      "--ignore-config",
      "--format",
      "json",
      "--rule-pack",
      examplePack,
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("not sandboxed");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it("refuses a bad pack before scanning anything", async () => {
    await withTempDir("fairux-pack-bad-", (dir) => {
      const page = join(dir, "page.html");
      writeFileSync(page, "<html><body><button>Buy now</button></body></html>", "utf8");
      const result = run(["scan", page, "--ignore-config", "--rule-pack", join(dir, "nope.mjs")]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("cannot load rule pack");
      // Nothing was scanned: no report reached stdout.
      expect(result.stdout.trim()).toBe("");
    });
  });
});

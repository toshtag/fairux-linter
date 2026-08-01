import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — the generator is plain JS, like every other one here.
import { diffInventories } from "../../scripts/generate-api-inventory.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

interface Inventory {
  readonly entryPoints: readonly {
    readonly specifier: string;
    readonly exportCount: number;
    readonly exports: readonly { readonly name: string; readonly kind: "type" | "value" }[];
  }[];
}

const committed = JSON.parse(
  readFileSync(join(ROOT, "docs/generated/sdk-api-inventory.json"), "utf8"),
) as Inventory;

const clone = (): Inventory => JSON.parse(JSON.stringify(committed)) as Inventory;

/**
 * The comparison is the whole feature, so it is mutation-tested rather than trusted.
 *
 * A check that passes on everything reads exactly like a check that works, right up until the day
 * somebody deletes an export.
 */
describe("what the inventory calls a break", () => {
  it("passes when nothing changed", () => {
    expect(diffInventories(committed, clone())).toEqual({ breaking: [], added: [] });
  });

  it("fails when an export is removed", () => {
    const after = clone();
    const entry = after.entryPoints[0] as { exports: { name: string }[] };
    const removed = entry.exports.shift()?.name;
    const result = diffInventories(committed, after);
    expect(result.breaking).toHaveLength(1);
    expect(result.breaking[0]).toContain(removed);
  });

  it("fails when an export is renamed, which is a removal with a new name beside it", () => {
    const after = clone();
    const entry = after.entryPoints[0] as { exports: { name: string }[] };
    const before = entry.exports[0]?.name as string;
    (entry.exports[0] as { name: string }).name = `${before}Renamed`;
    const result = diffInventories(committed, after);
    expect(result.breaking.some((message: string) => message.includes(before))).toBe(true);
    expect(result.added.some((message: string) => message.includes(`${before}Renamed`))).toBe(true);
  });

  it("fails when a value becomes a type, or the other way round", () => {
    // A consumer calling it stops compiling, which is a break however additive the diff looks.
    const after = clone();
    const entry = after.entryPoints[0] as { exports: { name: string; kind: string }[] };
    const target = entry.exports.find((item) => item.kind === "value");
    expect(target, "the inventory should contain at least one value export").toBeDefined();
    if (target) target.kind = "type";
    expect(diffInventories(committed, after).breaking[0]).toContain("changed from value to type");
  });

  it("fails when an entry point disappears", () => {
    const after = clone() as { entryPoints: unknown[] };
    after.entryPoints.pop();
    expect(diffInventories(committed, after).breaking[0]).toContain("is gone");
  });

  it("does not call an addition a break", () => {
    const after = clone();
    const entry = after.entryPoints[0] as { exports: { name: string; kind: string }[] };
    entry.exports.push({ name: "somethingNew", kind: "value" });
    const result = diffInventories(committed, after);
    expect(result.breaking).toEqual([]);
    expect(result.added[0]).toContain("somethingNew");
  });
});

describe("the committed inventory", () => {
  it("covers the three published entry points and nothing else", () => {
    // `check-build-output` pins the SDK at three published entry points; this is the same three,
    // read from the declarations rather than from the manifest.
    expect(committed.entryPoints.map((entry) => entry.specifier)).toEqual([
      "@fairux/sdk",
      "@fairux/sdk/html",
      "@fairux/sdk/dom",
    ]);
  });

  it("records the surface this session added, so a later removal is visible", () => {
    const root = committed.entryPoints[0];
    const names = new Set(root?.exports.map((item) => item.name));
    for (const name of [
      "computeRiskIndex",
      "fairuxRiskIndexModel",
      "RiskIndexError",
      "composeRulePacks",
      "createScanner",
      "fairuxBuiltinRulePack",
    ]) {
      expect(names, `${name} should be in the inventory`).toContain(name);
    }
  });

  it("is sorted, so a diff shows what changed rather than how it was ordered", () => {
    for (const entry of committed.entryPoints) {
      const names = entry.exports.map((item) => item.name);
      expect(names).toEqual([...names].sort());
      expect(entry.exportCount).toBe(entry.exports.length);
    }
  });
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — the generator is plain JS, like every other one here.
import { diffInventories } from "../../scripts/generate-api-inventory.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The committed inventory and the clone that exists to be broken.
 *
 * Two type families, deep on both sides. They were one `readonly` type, so every mutation in this
 * file needed a cast to strip it — and each cast restated the shape, which is how they drifted from
 * it. A shallow `Readonly<EntryPoint>` would not do either: it freezes the `exports` property and
 * leaves the array's contents and every field writable, so `committed` would still accept a `push`
 * and a rename. `readonlyInventoryIsDeep` below fails to compile if that regresses.
 */
interface InventoryExport {
  readonly name: string;
  readonly kind: "type" | "value";
  readonly deprecated?: boolean;
}
interface InventoryEntryPoint {
  readonly specifier: string;
  readonly exportCount: number;
  readonly exports: readonly InventoryExport[];
}
type Inventory = { readonly entryPoints: readonly InventoryEntryPoint[] };

interface MutableExport {
  name: string;
  kind: "type" | "value";
  deprecated?: boolean;
}
interface MutableEntryPoint {
  specifier: string;
  exportCount: number;
  exports: MutableExport[];
}
type MutableInventory = { entryPoints: MutableEntryPoint[] };

const committed = JSON.parse(
  readFileSync(join(ROOT, "docs/generated/sdk-api-inventory.json"), "utf8"),
) as Inventory;

const clone = (): MutableInventory => JSON.parse(JSON.stringify(committed)) as MutableInventory;

/** The first entry point of a clone, which every mutation case starts from. */
function firstEntry(inventory: MutableInventory): MutableEntryPoint {
  const entry = inventory.entryPoints[0];
  if (!entry) throw new Error("the committed inventory has no entry points");
  return entry;
}

/** Its first export, likewise. */
function firstExport(entry: MutableEntryPoint): MutableExport {
  const item = entry.exports[0];
  if (!item) throw new Error(`${entry.specifier} has no exports`);
  return item;
}

/**
 * That `Inventory` is deep, asserted by the compiler rather than by a comment.
 *
 * Never called — the body exists so `tsc` reads it. Each directive fails as an unused
 * `@ts-expect-error` the moment the type stops refusing the line under it, which is what a shallow
 * `Readonly<…>` would do to all four at once.
 */
function readonlyInventoryIsDeep(value: Inventory): void {
  // @ts-expect-error — the entry point array is frozen
  value.entryPoints.push({ specifier: "x", exportCount: 0, exports: [] });
  // @ts-expect-error — so is each entry point's own exports array
  value.entryPoints[0]?.exports.push({ name: "x", kind: "value" });
  const entry = value.entryPoints[0];
  if (entry) {
    // @ts-expect-error — and the fields of an entry point
    entry.specifier = "x";
    const item = entry.exports[0];
    // @ts-expect-error — and the fields of an export
    if (item) item.name = "x";
  }
}
void readonlyInventoryIsDeep;

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
    const entry = firstEntry(after);
    const removed = entry.exports.shift()?.name;
    const result = diffInventories(committed, after);
    expect(result.breaking).toHaveLength(1);
    expect(result.breaking[0]).toContain(removed);
  });

  it("fails when an export is renamed, which is a removal with a new name beside it", () => {
    const after = clone();
    const entry = firstEntry(after);
    const first = firstExport(entry);
    const before = first.name;
    first.name = `${before}Renamed`;
    const result = diffInventories(committed, after);
    expect(result.breaking.some((message: string) => message.includes(before))).toBe(true);
    expect(result.added.some((message: string) => message.includes(`${before}Renamed`))).toBe(true);
  });

  it("fails when a value becomes a type, or the other way round", () => {
    // A consumer calling it stops compiling, which is a break however additive the diff looks.
    const after = clone();
    const entry = firstEntry(after);
    const target = entry.exports.find((item) => item.kind === "value");
    expect(target, "the inventory should contain at least one value export").toBeDefined();
    if (target) target.kind = "type";
    expect(diffInventories(committed, after).breaking[0]).toContain("changed from value to type");
  });

  it("fails when an entry point disappears", () => {
    const after = clone();
    after.entryPoints.pop();
    expect(diffInventories(committed, after).breaking[0]).toContain("is gone");
  });

  it("does not call an addition a break", () => {
    const after = clone();
    const entry = firstEntry(after);
    entry.exports.push({ name: "somethingNew", kind: "value" });
    const result = diffInventories(committed, after);
    expect(result.breaking).toEqual([]);
    expect(result.added[0]).toContain("somethingNew");
  });
});

describe("deprecation, which is what makes a removal reviewable", () => {
  it("records nothing as deprecated today, and says so rather than being silent", () => {
    // Not a gap: nothing has been deprecated. The flag's absence everywhere is the current truth,
    // and a later `"deprecated": true` will arrive as a diff.
    const flagged = committed.entryPoints.flatMap((entry) =>
      entry.exports.filter((item) => item.deprecated),
    );
    expect(flagged).toEqual([]);
  });

  it("says whether a removed export was deprecated first", () => {
    const after = clone();
    const entry = firstEntry(after);
    const removed = entry.exports.shift()?.name;
    expect(diffInventories(committed, after).breaking[0]).toContain(
      "without ever being deprecated",
    );

    // The same removal, from an inventory that had deprecated it, reads differently — which is the
    // whole point of recording the flag rather than remembering the review.
    const before = clone();
    const target = firstEntry(before).exports.find((item) => item.name === removed);
    if (target) target.deprecated = true;
    expect(diffInventories(before, after).breaking[0]).toContain("it was deprecated first");
  });

  it("reports un-deprecating as a change rather than silence", () => {
    const before = clone();
    firstExport(firstEntry(before)).deprecated = true;
    const result = diffInventories(before, clone());
    expect(result.breaking).toEqual([]);
    expect(result.added.some((entry: string) => entry.includes("no longer deprecated"))).toBe(true);
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

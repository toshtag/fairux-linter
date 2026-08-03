import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What the documents claim a write does, against what the code does.
 *
 * Not a snapshot of prose — a check that each capability claim has a counterpart in the
 * implementation, and that no document still says the opposite. `--fix-write` was refused on Windows
 * in code while three pages went on describing it as available everywhere, which is the shape of
 * drift this exists to catch.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const IMPLEMENTATION = read("apps/cli/src/index.ts");
const REPLACE = read("apps/cli/src/file-replace.ts");

describe("--fix-write on Windows", () => {
  it("is refused by the implementation", () => {
    expect(IMPLEMENTATION).toMatch(/options\.fixWrite && process\.platform === "win32"/);
    expect(IMPLEMENTATION).toMatch(/not supported on Windows/);
  });

  for (const page of ["README.md", "docs/reference/platforms.md"]) {
    it(`is documented as unavailable in ${page}`, () => {
      const text = read(page);
      expect(text).toMatch(/`--fix-write`[^.]*Windows|Windows[^.]*`--fix-write`/);
      expect(text).toMatch(/security descriptor/);
    });
  }

  it("is not described anywhere as working on every platform", () => {
    for (const page of ["README.md", "docs/reference/platforms.md"]) {
      // The claim this replaced: "nothing in this repository is platform-specific".
      expect(read(page)).not.toMatch(/nothing in this repository is platform-specific\.$/m);
    }
  });
});

describe("which flags write files", () => {
  it("the security boundary names all three, not just the fix", () => {
    const boundary = read("docs/reference/security-boundary.md");
    expect(boundary).toContain("--write-baseline");
    expect(boundary).toContain("--risk-index");
    expect(boundary).toContain("--fix-write");
    // The claim this replaced. Two other flags write, and a boundary document that named one of
    // them was describing a smaller surface than the tool has.
    expect(boundary).not.toContain("`--fix-write` is the only thing that writes");
  });

  it("each one goes through the replacement that preserves what it replaces", () => {
    expect(read("apps/cli/src/baseline.ts")).toContain("replaceArtifact");
    expect(read("apps/cli/src/risk-index.ts")).toContain("replaceArtifact");
    expect(read("apps/cli/src/fix.ts")).toContain("stageReplacement");
  });
});

describe("what a replacement does not preserve", () => {
  const claims = ["ACL", "extended attribute"];

  it("is stated in the platform reference rather than only in a source comment", () => {
    const platforms = read("docs/reference/platforms.md");
    for (const claim of claims) {
      expect(platforms.toLowerCase()).toContain(claim.toLowerCase());
    }
  });

  it("matches what the module says about itself", () => {
    for (const claim of claims) {
      expect(REPLACE.toLowerCase()).toContain(claim.toLowerCase());
    }
  });

  it("names the three limits that apply on every platform", () => {
    const platforms = read("docs/reference/platforms.md");
    // Several files are not a transaction; a rename is not durability; the final check is not
    // atomic with the rename. Each was a claim this project had to narrow rather than a
    // limitation it discovered late.
    expect(platforms).toMatch(/several renames|some replaced and some not/i);
    expect(platforms).toMatch(/fsync|power loss/i);
    expect(platforms).toMatch(/window is small|not zero/i);
  });
});

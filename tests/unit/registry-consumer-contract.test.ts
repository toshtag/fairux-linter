import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumerSmokeFixtureNames,
  validateRegistryConsumerContract,
} from "../../packages/sdk/scripts/consumer-smoke.mjs";
import { classifyVersion } from "../../scripts/release-version-contract.mjs";

/**
 * Pins the lifecycle boundary between the two consumer smoke profiles.
 *
 * The release fixtures evolve with the default branch: ahead of the next SDK publication they may
 * use API, types, RulePack metadata, or validation the published SDK does not have yet. A registry
 * canary that executed them would go red on ordinary development with no consumer-compatibility
 * fact behind the failure. The canary therefore runs only `sdk-registry-consumer-v1`, a frozen
 * consumer contract written against the published beta — and this file holds the fence: which
 * fixtures each profile stages, that the v1 tree reaches into no evolving tree, and that the
 * generated catalog stays a release-only input. Proving new SDK surface belongs to a future v2
 * directory, never to an edit of v1.
 */

const root = resolve(import.meta.dirname, "../..");
const RELEASE_FIXTURES = [
  "sdk-custom-rule-pack",
  "sdk-node-consumer",
  "sdk-browser-consumer",
  "sdk-typescript-consumer",
];
const REGISTRY_FIXTURE = "sdk-registry-consumer-v1";
const CONTRACT_FILES = [
  "browser-entry.ts",
  "node-consumer.mjs",
  "purchase-guard-pack.mjs",
  "tsconfig.json",
  "typescript-consumer.ts",
];
const fixtureDir = resolve(root, "tests/fixtures", REGISTRY_FIXTURE);

describe("profile fixture selection", () => {
  it("stages the evolving release fixtures for the release profile only", () => {
    const release = consumerSmokeFixtureNames("release");
    expect(release).toEqual(RELEASE_FIXTURES);
    expect(release).not.toContain(REGISTRY_FIXTURE);
  });

  it("stages only the frozen v1 contract for the registry-consumer profile", () => {
    const registry = consumerSmokeFixtureNames("registry-consumer");
    expect(registry).toEqual([REGISTRY_FIXTURE]);
    for (const name of RELEASE_FIXTURES) {
      expect(registry).not.toContain(name);
    }
  });

  it("refuses an unknown profile instead of guessing", () => {
    expect(() => consumerSmokeFixtureNames("registry")).toThrow(/unknown consumer smoke profile/);
    expect(() => consumerSmokeFixtureNames("")).toThrow(/unknown consumer smoke profile/);
  });
});

describe("the v1 contract directory", () => {
  const files = readdirSync(fixtureDir).sort();
  const sources = files
    .filter((file) => [".mjs", ".ts"].includes(extname(file)))
    .map((file) => ({ file, text: readFileSync(resolve(fixtureDir, file), "utf8") }));

  it("carries exactly the frozen contract manifest", () => {
    const contract = JSON.parse(readFileSync(resolve(fixtureDir, "contract.json"), "utf8")) as {
      id?: string;
      minimumSdkVersion?: string;
      files?: string[];
      contentSha256?: string;
    };
    expect(contract.id).toBe(REGISTRY_FIXTURE);
    const minimum = contract.minimumSdkVersion;
    expect(minimum).toBe("0.1.0-beta.2");
    expect(classifyVersion(minimum ?? "").valid).toBe(true);
    expect(contract.files).toEqual(CONTRACT_FILES);
    expect(contract.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is exactly the manifest's file set — nothing missing, nothing extra", () => {
    expect(files).toEqual(["contract.json", ...CONTRACT_FILES].sort());
  });

  it("matches its content digest, recomputed independently", () => {
    // A second implementation of the digest, so the validator's own cannot drift silently: both
    // must agree on the algorithm — listed order, UTF-8 name, NUL, raw bytes, NUL — and on the
    // pinned value in the manifest.
    const contract = JSON.parse(readFileSync(resolve(fixtureDir, "contract.json"), "utf8")) as {
      files: string[];
      contentSha256: string;
    };
    const hash = createHash("sha256");
    for (const file of contract.files) {
      hash.update(file, "utf8");
      hash.update("\0");
      hash.update(readFileSync(resolve(fixtureDir, file)));
      hash.update("\0");
    }
    expect(hash.digest("hex")).toBe(contract.contentSha256);

    const validated = validateRegistryConsumerContract();
    expect(validated.id).toBe(REGISTRY_FIXTURE);
    expect(validated.contentSha256).toBe(contract.contentSha256);
  });

  it.each(sources)("$file reaches into no evolving tree", ({ file, text }) => {
    // Independence is the point of the directory: an import into a release fixture, the generated
    // catalog, or a workspace source would re-couple the canary to the default branch's pace.
    // Checked as raw text so a type-only or commented sneak path fails too — which is also why
    // the v1 sources must not name these trees even in prose.
    for (const forbidden of [
      ...RELEASE_FIXTURES.map((name) => `../${name}`),
      "docs/generated",
      "rule-catalog",
      "packages/",
      "workspace:",
      "link:",
      "portal:",
    ]) {
      expect(text, `${file} must not reference ${forbidden}`).not.toContain(forbidden);
    }
    // As a specifier — a quoted `file:` URL — not as the word: scan options legitimately carry a
    // `file: "first.html"` metadata field.
    expect(text, `${file} must not use a file: specifier`).not.toMatch(/["']file:/);
  });

  it("is governed by the external consumer boundary, not excluded from it", () => {
    // `external-consumer-boundary.test.ts` discovers fixture trees from the filesystem, so the v1
    // directory is governed the moment it exists — unless someone special-cases it. The boundary
    // test must not name this directory at all.
    const boundary = readFileSync(
      resolve(root, "tests/unit/external-consumer-boundary.test.ts"),
      "utf8",
    );
    expect(boundary).not.toContain(REGISTRY_FIXTURE);
  });
});

describe("the v1 contract, mutated", () => {
  // A contract that only ever sees the frozen directory proves nothing about what it would catch.
  // Each probe below is the realistic way v1 would drift — an edit that tracks next-main surface,
  // a stray file, a deletion, a loosened manifest — applied to a temp copy and refused by the
  // validator. Five probes, not a mutation framework: the digest makes every byte-level variant
  // equivalent to the first probe.
  const temps: string[] = [];
  const mutatedCopy = (mutate: (dir: string) => void): string => {
    const dir = mkdtempSync(join(tmpdir(), "fairux-registry-contract-probe-"));
    temps.push(dir);
    cpSync(fixtureDir, dir, { recursive: true });
    mutate(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("accepts an unmutated copy", () => {
    // Non-vacuity: the refusals below must be the mutations' doing, not the copy's.
    const dir = mutatedCopy(() => {});
    expect(validateRegistryConsumerContract(dir).id).toBe(REGISTRY_FIXTURE);
  });

  it("refuses an edited source, even by one comment line", () => {
    const dir = mutatedCopy((copy) => {
      const path = join(copy, "typescript-consumer.ts");
      writeFileSync(path, `${readFileSync(path, "utf8")}// drifted\n`);
    });
    expect(() => validateRegistryConsumerContract(dir)).toThrow(/digest mismatch/);
  });

  it("refuses an extra file", () => {
    const dir = mutatedCopy((copy) => {
      writeFileSync(join(copy, "extra.txt"), "stray\n");
    });
    expect(() => validateRegistryConsumerContract(dir)).toThrow(/unexpected file: extra\.txt/);
  });

  it("refuses a missing listed file", () => {
    const dir = mutatedCopy((copy) => {
      rmSync(join(copy, "purchase-guard-pack.mjs"));
    });
    expect(() => validateRegistryConsumerContract(dir)).toThrow(
      /missing file: purchase-guard-pack\.mjs/,
    );
  });

  it("refuses a changed minimum SDK version", () => {
    const dir = mutatedCopy((copy) => {
      const path = join(copy, "contract.json");
      const contract = JSON.parse(readFileSync(path, "utf8"));
      contract.minimumSdkVersion = "0.2.0-beta.1";
      writeFileSync(path, JSON.stringify(contract, null, 2));
    });
    expect(() => validateRegistryConsumerContract(dir)).toThrow(/minimumSdkVersion/);
  });

  it("refuses a malformed digest", () => {
    const dir = mutatedCopy((copy) => {
      const path = join(copy, "contract.json");
      const contract = JSON.parse(readFileSync(path, "utf8"));
      contract.contentSha256 = "not-a-digest";
      writeFileSync(path, JSON.stringify(contract, null, 2));
    });
    expect(() => validateRegistryConsumerContract(dir)).toThrow(/64 lowercase hex/);
  });
});

describe("main fixture drift", () => {
  const consumer = readFileSync(resolve(root, "packages/sdk/scripts/consumer-smoke.mjs"), "utf8");

  it("keeps the generated catalog a release-only input", () => {
    // One copy site, inside the release checks. The registry path never names the catalog, so
    // removing it from a checkout cannot fail the canary — measured in PR #75 with the catalog
    // and all four release fixture trees moved aside.
    const releaseChecks = consumer.slice(
      consumer.indexOf("function runReleaseChecks"),
      consumer.indexOf("function runRegistryConsumerChecks"),
    );
    const mentions = consumer.match(/rule-catalog\.json/g) ?? [];
    const releaseMentions = releaseChecks.match(/rule-catalog\.json/g) ?? [];
    expect(mentions.length).toBeGreaterThan(0);
    expect(releaseMentions).toEqual(mentions);
  });

  it("keeps the registry checks inside the v1 directory", () => {
    const registryChecks = consumer.slice(consumer.indexOf("function runRegistryConsumerChecks"));
    expect(registryChecks).toContain(`"${REGISTRY_FIXTURE}"`);
    for (const name of RELEASE_FIXTURES) {
      expect(registryChecks, `registry checks must not touch ${name}`).not.toContain(name);
    }
  });
});

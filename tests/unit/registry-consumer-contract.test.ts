import { readdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { consumerSmokeFixtureNames } from "../../packages/sdk/scripts/consumer-smoke.mjs";
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

  it("carries its identity and minimum SDK version", () => {
    const contract = JSON.parse(readFileSync(resolve(fixtureDir, "contract.json"), "utf8")) as {
      id?: string;
      minimumSdkVersion?: string;
    };
    expect(contract.id).toBe(REGISTRY_FIXTURE);
    expect(classifyVersion(contract.minimumSdkVersion).valid).toBe(true);
  });

  it("contains the whole consumer surface it claims", () => {
    for (const file of [
      "contract.json",
      "purchase-guard-pack.mjs",
      "node-consumer.mjs",
      "browser-entry.ts",
      "typescript-consumer.ts",
      "tsconfig.json",
    ]) {
      expect(files).toContain(file);
    }
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

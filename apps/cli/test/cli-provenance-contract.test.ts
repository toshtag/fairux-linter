import { describe, expect, it } from "vitest";
import {
  CLI_PROVENANCE_STATES,
  classifyCliProvenance,
  waitForCliProvenance,
} from "../scripts/cli-provenance-contract.mjs";

/**
 * The provenance claim, checked rather than assumed.
 *
 * The release notes said "the npm package carries provenance, so the registry can show which
 * workflow run and which commit produced it". The workflow verified `dist.shasum`,
 * `dist.integrity`, and the dist-tags, and never read `dist.attestations` — so the sentence was a
 * statement about what `npm publish --provenance` is supposed to do, not about what the registry
 * ended up holding. A publish that silently recorded no attestation would have been announced as
 * one that did.
 *
 * The shape asserted here is measured. `npm view @fairux/sdk@0.1.0-beta.2 dist.attestations --json`
 * against the public registry returns exactly the `PRESENT` fixture below.
 */

const PRESENT = {
  url: "https://registry.npmjs.org/-/npm/v1/attestations/@fairux%2fsdk@0.1.0-beta.2",
  provenance: { predicateType: "https://slsa.dev/provenance/v1" },
};

describe("classifyCliProvenance", () => {
  it("accepts the metadata the public registry actually returns", () => {
    expect(classifyCliProvenance({ attestations: PRESENT })).toEqual({
      state: "present",
      failures: [],
    });
  });

  it("accepts an npm response carrying fields this contract does not pin", () => {
    // npm may add fields. A contract that pinned the whole document would fail the day it does.
    expect(
      classifyCliProvenance({
        attestations: { ...PRESENT, somethingNew: { added: "later" } },
      }).state,
    ).toBe("present");
  });

  it("reports an absent field as absent, which is the only retryable state", () => {
    for (const attestations of [undefined, null]) {
      expect(classifyCliProvenance({ attestations })).toEqual({ state: "absent", failures: [] });
    }
  });

  it.each([
    ["a string", "provenance"],
    ["a number", 1],
    ["an array", [PRESENT]],
  ])("refuses %s outright rather than retrying it", (_label, attestations) => {
    const result = classifyCliProvenance({ attestations });
    expect(result.state).toBe("invalid");
    expect(result.failures).toEqual([expect.stringContaining("is not an object")]);
  });

  it("refuses a bundle with no provenance predicate", () => {
    // An attestation of some other kind is not the claim the release notes make.
    const result = classifyCliProvenance({ attestations: { url: PRESENT.url } });
    expect(result.state).toBe("invalid");
    expect(result.failures).toEqual([expect.stringContaining("records no provenance predicate")]);
  });

  it.each([
    ["an http URL", "http://registry.npmjs.org/-/npm/v1/attestations/x"],
    ["a relative path", "/-/npm/v1/attestations/x"],
    ["an empty string", ""],
    ["a number", 42],
  ])("refuses an attestation url that is %s", (_label, url) => {
    const result = classifyCliProvenance({ attestations: { ...PRESENT, url } });
    expect(result.state).toBe("invalid");
    expect(result.failures).toEqual([expect.stringContaining("dist.attestations.url")]);
  });

  it("refuses a predicate that is not SLSA provenance", () => {
    const result = classifyCliProvenance({
      attestations: {
        ...PRESENT,
        provenance: { predicateType: "https://in-toto.io/attestation/test-result/v0.1" },
      },
    });
    expect(result.state).toBe("invalid");
    expect(result.failures).toEqual([
      expect.stringContaining("is not a SLSA provenance predicate"),
    ]);
  });

  it("accepts a future SLSA predicate version", () => {
    // Named by prefix, not pinned: SLSA revises its predicate, and a release must not fail on the
    // day npm follows. What must not change is that it is a provenance predicate at all.
    expect(
      classifyCliProvenance({
        attestations: {
          ...PRESENT,
          provenance: { predicateType: "https://slsa.dev/provenance/v2" },
        },
      }).state,
    ).toBe("present");
  });

  it("knows exactly three states", () => {
    expect([...CLI_PROVENANCE_STATES]).toEqual(["present", "absent", "invalid"]);
  });
});

describe("waitForCliProvenance", () => {
  const clockOf = () => {
    let now = 0;
    return {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    };
  };

  it("returns as soon as the metadata is there", async () => {
    const { now, sleep } = clockOf();
    const result = await waitForCliProvenance({
      spec: "fairux@0.1.0-beta.1",
      read: async () => PRESENT,
      sleep,
      now,
      log: () => {},
    });
    expect(result).toMatchObject({ state: "present", attempts: 1 });
  });

  it("retries absence until it appears", async () => {
    // Attestation metadata can lag a write the registry has already accepted, the same way the
    // version itself can — which is what `--wait-for-present` exists for on the digest check.
    const answers: unknown[] = [undefined, undefined, PRESENT];
    const { now, sleep } = clockOf();
    const result = await waitForCliProvenance({
      spec: "fairux@0.1.0-beta.1",
      read: async () => answers.shift(),
      sleep,
      now,
      log: () => {},
    });
    expect(result).toMatchObject({ state: "present", attempts: 3 });
  });

  it("does not retry a bundle that is present and wrong", async () => {
    // The publish already happened. Retrying would spend the deadline before reporting the same
    // thing, and report it as "npm was slow".
    let reads = 0;
    const { now, sleep } = clockOf();
    const result = await waitForCliProvenance({
      spec: "fairux@0.1.0-beta.1",
      read: async () => {
        reads += 1;
        return { url: PRESENT.url };
      },
      sleep,
      now,
      log: () => {},
    });
    expect(result.state).toBe("invalid");
    expect(reads).toBe(1);
  });

  it("gives up inside the shared deadline rather than forever", async () => {
    const { now, sleep } = clockOf();
    const result = await waitForCliProvenance({
      spec: "fairux@0.1.0-beta.1",
      read: async () => undefined,
      sleep,
      now,
      log: () => {},
    });
    expect(result.state).toBe("absent");
    expect(result.failures).toEqual([expect.stringContaining("no provenance attestation")]);
    // The same 120s ceiling the registry digest wait uses, not a second one invented here.
    expect(now()).toBeLessThanOrEqual(120_000);
  });

  it("raises a failed read rather than reporting it as absent", async () => {
    // A registry or credential error must not be mistaken for "no attestation yet".
    await expect(
      waitForCliProvenance({
        spec: "fairux@0.1.0-beta.1",
        read: async () => {
          throw new Error("npm view failed: ENEEDAUTH");
        },
        sleep: async () => {},
        now: () => 0,
        log: () => {},
      }),
    ).rejects.toThrow(/ENEEDAUTH/);
  });
});

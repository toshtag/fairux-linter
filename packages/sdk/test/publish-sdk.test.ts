import { describe, expect, it } from "vitest";
// @ts-expect-error — the publish script is plain JS, like every other one here.
import { buildSdkPublishArgs, parsePublishNeeded, publishSdk } from "../scripts/publish-sdk.mjs";

/**
 * The arguments `npm publish` will actually receive.
 *
 * They used to be a multi-line shell block in `publish-sdk.yml`, guarded by `release-check.mjs`
 * slicing that file's text from the first `npm publish` and searching what followed. Measured
 * against the real workflow: deleting `--ignore-scripts` from the command and writing it in a
 * comment below the block passed. So did the same trick with every other flag.
 *
 * The array is asserted whole, not by membership. Membership was the old check's failure mode in a
 * second way too: it cannot tell `--tag next <tarball>` from `--tag <tarball> next`, and the second
 * publishes a file named `next` on a dist-tag named after the archive.
 *
 * Nothing here reaches a registry. The executor is injected.
 */

const TARBALL = "/tmp/bundle/fairux-sdk-0.1.0-beta.3.tgz";

const EXPECTED = [
  "publish",
  "--registry=https://registry.npmjs.org/",
  "--@fairux:registry=https://registry.npmjs.org/",
  "--ignore-scripts",
  "--provenance",
  "--access",
  "public",
  "--tag",
  "next",
  TARBALL,
];

/** A run that records rather than executes, plus a filesystem that says the tarball is there. */
function harness(overrides: Record<string, string | undefined> = {}) {
  const calls: { file: string; args: string[] }[] = [];
  const logs: string[] = [];
  const env = {
    PUBLISH_NEEDED: "true",
    DIST_TAG: "next",
    TARBALL,
    SPEC: "@fairux/sdk@0.1.0-beta.3",
    ...overrides,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete (env as Record<string, string | undefined>)[key];
  }
  const result = () =>
    publishSdk({
      env,
      run: (file: string, args: string[]) => calls.push({ file, args }),
      log: (message: string) => logs.push(message),
      exists: () => true,
    });
  return { calls, logs, result };
}

describe("the SDK publish arguments", () => {
  it("are exactly these, in this order", () => {
    expect(buildSdkPublishArgs({ distTag: "next", tarball: TARBALL })).toEqual(EXPECTED);
  });

  it("pin the scope key as well as the fallback registry", () => {
    // npm resolves a scoped package through `@fairux:registry` first and only falls back to
    // `registry`, so `--registry` alone leaves any `@fairux:registry=` line in the config chain in
    // charge of where this publish goes.
    const args = buildSdkPublishArgs({ distTag: "next", tarball: TARBALL });
    expect(args).toContain("--registry=https://registry.npmjs.org/");
    expect(args).toContain("--@fairux:registry=https://registry.npmjs.org/");
  });

  it("put the tarball last, so npm publishes the packed bytes and not the directory", () => {
    const args = buildSdkPublishArgs({ distTag: "next", tarball: TARBALL });
    expect(args[args.length - 1]).toBe(TARBALL);
  });

  it("keep the dist-tag adjacent to its flag", () => {
    const args = buildSdkPublishArgs({ distTag: "next", tarball: TARBALL });
    expect(args[args.indexOf("--tag") + 1]).toBe("next");
  });
});

describe("what the publish arguments refuse", () => {
  it.each([
    ["the latest dist-tag", { distTag: "latest" }, /refusing to publish on latest/],
    ["an empty dist-tag", { distTag: "" }, /dist-tag is required/],
    ["a relative tarball path", { tarball: "bundle/fairux-sdk-0.1.0-beta.3.tgz" }, /absolute/],
    ["a tarball that is not the SDK's", { tarball: "/tmp/fairux-0.1.0.tgz" }, /not a packed/],
    ["a tarball with no version", { tarball: "/tmp/fairux-sdk.tgz" }, /not a packed/],
    ["a newline in the dist-tag", { distTag: "next\nlatest" }, /newline or NUL/],
    ["a NUL in the tarball", { tarball: `${TARBALL}\0` }, /newline or NUL/],
  ])("refuses %s", (_name, over, expected) => {
    expect(() => buildSdkPublishArgs({ distTag: "next", tarball: TARBALL, ...over })).toThrow(
      expected,
    );
  });
});

describe("PUBLISH_NEEDED", () => {
  it.each([
    ["true", true],
    ["false", false],
  ])("reads %s", (input, expected) => {
    expect(parsePublishNeeded(input)).toBe(expected);
  });

  it.each(["", "TRUE", "1", "yes", undefined])("refuses %s", (input) => {
    expect(() => parsePublishNeeded(input)).toThrow(/must be "true" or "false"/);
  });
});

describe("running the publication", () => {
  it("calls npm once, with the exact arguments", () => {
    const { calls, result } = harness();
    expect(result()).toEqual({ published: true, args: EXPECTED });
    expect(calls).toEqual([{ file: "npm", args: EXPECTED }]);
  });

  it("does not touch npm at all when the version is already there", () => {
    // Not even to be told so: the plan step already read the registry and found this exact version
    // with a matching digest.
    const { calls, logs, result } = harness({ PUBLISH_NEEDED: "false" });
    expect(result()).toEqual({ published: false, args: null });
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toContain("skipping npm publish");
  });

  it("refuses a tarball that is not on disk", () => {
    expect(() =>
      publishSdk({
        env: { PUBLISH_NEEDED: "true", DIST_TAG: "next", TARBALL },
        run: () => {
          throw new Error("npm must not run");
        },
        log: () => {},
        exists: () => false,
      }),
    ).toThrow(/tarball does not exist/);
  });

  it("refuses an unknown PUBLISH_NEEDED before building anything", () => {
    const { result } = harness({ PUBLISH_NEEDED: "maybe" });
    expect(result).toThrow(/must be "true" or "false"/);
  });
});

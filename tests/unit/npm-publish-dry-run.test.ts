import { describe, expect, it } from "vitest";
import { isAlreadyPublished } from "../../scripts/npm-publish-dry-run.mjs";

/**
 * When a failed `npm publish --dry-run` still means the tarball is publishable.
 *
 * The dry run is the packed smokes' last check, and it is not offline: npm resolves the package on
 * the registry, so from the moment a version is published that command answers `EPUBLISHCONFLICT`
 * for every later run against it. `main` carries the released version between a release and the
 * next bump, so `@fairux/sdk@0.1.0` and `fairux@0.1.0` reaching npm turned the release-contract
 * lane red on the very next push.
 *
 * Half the matrix went red, which looks like a flake and is not: the conflict reproduces locally on
 * the same npm that passed in CI. Which invocations hit it depends on the working directory and on
 * npm's cache; why those particular cells differed was not established, and does not need to be.
 *
 * npm validates the tarball — name, version, file list, sizes, lifecycle scripts — *before* it asks
 * the registry to accept it, so a conflict is a fact about the registry's state and not about the
 * artifact. The whole risk of accepting it is accepting too much, which is what these cases are
 * about: one refusal is a pass, and every other outcome is still a failure.
 */

const conflict = (spec: string) =>
  [
    "npm error code EPUBLISHCONFLICT",
    `npm error You cannot publish over the previously published versions: ${spec.split("@").pop()}.`,
    `npm error A complete log of this run can be found in: /tmp/${spec}/_logs/debug.log`,
  ].join("\n");

describe("a dry run refused because the version is already published", () => {
  it("accepts the conflict for this exact package and version", () => {
    expect(
      isAlreadyPublished({
        output: `${conflict("@fairux/sdk@0.1.0")}\n@fairux/sdk`,
        name: "@fairux/sdk",
        version: "0.1.0",
      }),
    ).toBe(true);
  });

  it("refuses a conflict over a different version", () => {
    // The tarball in the working directory is not the one being reasoned about, so the smoke has
    // learned nothing about the bytes it packed.
    expect(
      isAlreadyPublished({
        output: `${conflict("@fairux/sdk@0.2.0")}\n@fairux/sdk`,
        name: "@fairux/sdk",
        version: "0.1.0",
      }),
    ).toBe(false);
  });

  it("refuses a conflict that does not name this package", () => {
    expect(
      isAlreadyPublished({
        output: conflict("some-other-package@0.1.0"),
        name: "@fairux/sdk",
        version: "0.1.0",
      }),
    ).toBe(false);
  });

  it("refuses every other npm failure", () => {
    // The check exists so a published version stops being a false red. Widening it to "npm said
    // no" would delete the smoke.
    for (const output of [
      "npm error code E403\nnpm error 403 Forbidden - PUT https://registry.npmjs.org/@fairux%2fsdk",
      "npm error code ENEEDAUTH\nnpm error need auth This command requires you to be logged in",
      "npm error code EJSONPARSE\nnpm error Invalid package.json",
      "npm error Tarball is not in network and can not be located in cache",
      "",
    ]) {
      expect(
        isAlreadyPublished({ output, name: "@fairux/sdk", version: "0.1.0" }),
        output.slice(0, 40),
      ).toBe(false);
    }
  });

  it("refuses a non-string, rather than coercing one", () => {
    for (const output of [undefined, null, 42, {}]) {
      expect(
        isAlreadyPublished({ output: output as never, name: "fairux", version: "0.1.0" }),
      ).toBe(false);
    }
  });

  it("does not let a version's dots match any character", () => {
    // `0.1.0` as a regexp matches `0x1y0`. A conflict over a version that merely looks like this
    // one is a conflict over a different release.
    expect(
      isAlreadyPublished({
        output:
          "npm error code EPUBLISHCONFLICT\nnpm error You cannot publish over the previously published versions: 0x1y0.\nfairux",
        name: "fairux",
        version: "0.1.0",
      }),
    ).toBe(false);
  });

  it("reads the message from either stream, since npm has moved it", () => {
    // The callers concatenate stdout and stderr for exactly this reason.
    expect(
      isAlreadyPublished({
        output: `\n\n${conflict("fairux@0.1.0")}\nfairux`,
        name: "fairux",
        version: "0.1.0",
      }),
    ).toBe(true);
  });
});

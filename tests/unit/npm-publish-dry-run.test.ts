import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isAlreadyPublished, runPublishDryRun } from "../../scripts/npm-publish-dry-run.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * When a failed `npm publish --dry-run` still means the tarball is publishable.
 *
 * The dry run is the packed smokes' last check, and it is not offline: npm resolves the package on
 * the registry, so from the moment a version is published that command answers a publish conflict
 * for every later run against it. `main` carries the released version between a release and the
 * next bump, so `@fairux/sdk@0.1.0` and `fairux@0.1.0` reaching npm turned the release-contract
 * lane red on the very next push.
 *
 * npm validates the tarball — name, version, file list, sizes, lifecycle scripts — *before* it asks
 * the registry to accept it, so a conflict is a fact about the registry's state and not about the
 * artifact.
 *
 * **`REAL_OUTPUT` below is the failing run's own bytes**, and it is the whole reason this file was
 * rewritten. The first version of this check also required the package name, on the assumption that
 * npm prints the spec it refused. It does not print the name, the tarball path, or even the
 * `EPUBLISHCONFLICT` code — so the check fell closed and the lane stayed red for a second push. The
 * fixture had been hand-written from what the message was expected to look like, while the real
 * string was sitting in a log that had already been read.
 *
 * What npm's output can identify is the **version**. The package is identified by the caller, and
 * more strongly than a substring could: it packed the archive itself and handed npm that exact path
 * as the only argument.
 */

/** Verbatim from `pack-smoke (24.11.0)`, run 31148140864, with the log's timestamps stripped. */
const REAL_OUTPUT = `npm exited with 1, expected 0:
{
  "error": {
    "summary": "You cannot publish over the previously published versions: 0.1.0.",
    "detail": ""
  }
}
npm warn Unknown env config "verify-deps-before-run". This will stop working in the next major version of npm.
npm warn This command requires you to be logged in to https://registry.npmjs.org/ (dry-run)
npm error You cannot publish over the previously published versions: 0.1.0.
`;

describe("a dry run refused because the version is already published", () => {
  it("accepts the output the failing run actually produced", () => {
    expect(isAlreadyPublished({ output: REAL_OUTPUT, version: "0.1.0" })).toBe(true);
  });

  it("does not depend on the package name, the tarball path, or the error code", () => {
    // None of the three is in npm's output. Requiring any of them is what kept the lane red.
    expect(REAL_OUTPUT).not.toContain("fairux");
    expect(REAL_OUTPUT).not.toContain(".tgz");
    expect(REAL_OUTPUT).not.toContain("EPUBLISHCONFLICT");
  });

  it("still accepts the form that does carry the code", () => {
    // Older npm prints `npm error code EPUBLISHCONFLICT` above the sentence. Both are accepted, so
    // the check does not depend on which npm the runner has.
    expect(
      isAlreadyPublished({
        output:
          "npm error code EPUBLISHCONFLICT\nnpm error You cannot publish over the previously published versions: 0.1.0.",
        version: "0.1.0",
      }),
    ).toBe(true);
  });

  it("refuses a conflict over a different version", () => {
    // The tarball in the working directory is not the one being reasoned about, so the smoke has
    // learned nothing about the bytes it packed.
    expect(isAlreadyPublished({ output: REAL_OUTPUT, version: "0.2.0" })).toBe(false);
    expect(isAlreadyPublished({ output: REAL_OUTPUT, version: "0.1.0-beta.4" })).toBe(false);
  });

  it("refuses a version that is a prefix of the one npm named", () => {
    // `0.1.0` must not be satisfied by a conflict over `0.1.05`, which the bare substring would be.
    expect(
      isAlreadyPublished({
        output: "npm error You cannot publish over the previously published versions: 0.1.05.",
        version: "0.1.0",
      }),
    ).toBe(false);
  });

  it("does not let a version's dots match any character", () => {
    // `0.1.0` as a regexp matches `0x1y0`. A conflict over a version that merely looks like this
    // one is a conflict over a different release.
    expect(
      isAlreadyPublished({
        output: "npm error You cannot publish over the previously published versions: 0x1y0.",
        version: "0.1.0",
      }),
    ).toBe(false);
  });

  it("refuses every other npm failure", () => {
    // The check exists so a published version stops being a false red. Widening it to "npm said no"
    // would delete the smoke.
    for (const output of [
      "npm error code E403\nnpm error 403 Forbidden - PUT https://registry.npmjs.org/@fairux%2fsdk",
      "npm error code ENEEDAUTH\nnpm error need auth This command requires you to be logged in",
      "npm error code EJSONPARSE\nnpm error Invalid package.json",
      "npm error Tarball is not in network and can not be located in cache",
      "",
    ]) {
      expect(isAlreadyPublished({ output, version: "0.1.0" }), output.slice(0, 40)).toBe(false);
    }
  });

  it("refuses a non-string output or version, rather than coercing one", () => {
    for (const output of [undefined, null, 42, {}]) {
      expect(isAlreadyPublished({ output: output as never, version: "0.1.0" })).toBe(false);
    }
    for (const version of [undefined, null, "", 42]) {
      expect(isAlreadyPublished({ output: REAL_OUTPUT, version: version as never })).toBe(false);
    }
  });
});

/**
 * The wiring, which is what stayed broken after the classifier was right.
 *
 * The check lives at four call sites — two packed smokes and two release rehearsals — and the first
 * two rounds of this fix gave the classifier to two of them. The lane went from five red jobs to
 * two, which is the shape of a fix applied where the failure was read rather than where the failure
 * is possible. `runPublishDryRun` is the one owner now, and `run` is injected so this is provable
 * without a registry: the local `npm publish --dry-run` does not hit the conflict from the working
 * directories the callers use, so a green local rehearsal proves nothing about this path.
 */
describe("running the dry run through the shared wrapper", () => {
  const CONFLICT = `npm error You cannot publish over the previously published versions: 0.1.0.
npm error A complete log of this run can be found in: /tmp/x/_logs/debug.log`;

  const throwing = (message: string) => () => {
    throw new Error(message);
  };

  it("returns npm's output when the dry run succeeds", () => {
    const result = runPublishDryRun({
      args: ["publish", "--dry-run"],
      version: "0.1.0",
      run: () => '{"id":"fairux@0.1.0"}',
    });
    expect(result).toEqual({ stdout: '{"id":"fairux@0.1.0"}', alreadyPublished: false });
  });

  it("reports the conflict instead of throwing", () => {
    expect(runPublishDryRun({ args: [], version: "0.1.0", run: throwing(CONFLICT) })).toEqual({
      stdout: null,
      alreadyPublished: true,
    });
  });

  it("rethrows every other failure, so the rehearsal still stops", () => {
    expect(() =>
      runPublishDryRun({ args: [], version: "0.1.0", run: throwing("npm error code E403") }),
    ).toThrow(/E403/);
    // And a conflict over a version this run did not pack.
    expect(() => runPublishDryRun({ args: [], version: "0.2.0", run: throwing(CONFLICT) })).toThrow(
      /cannot publish over/,
    );
  });

  it("reads the output from stdout or stderr as well as the message", () => {
    // `release-subprocess.mjs` puts it on `message`; `run-command.mjs` may carry the streams too.
    const error = Object.assign(new Error("npm exited with 1, expected 0:"), {
      stdout:
        '{"error":{"summary":"You cannot publish over the previously published versions: 0.1.0."}}',
      stderr: "",
    });
    expect(
      runPublishDryRun({
        args: [],
        version: "0.1.0",
        run: () => {
          throw error;
        },
      }),
    ).toEqual({ stdout: null, alreadyPublished: true });
  });
});

/**
 * Every place the dry run is run, so a fifth caller cannot quietly skip the wrapper.
 *
 * This is the assertion that would have caught the second round: the classifier was correct and two
 * of the four call sites had never been given it.
 */
describe("every dry run goes through the wrapper", () => {
  const CALLERS = [
    "apps/cli/scripts/pack-smoke-test.mjs",
    "packages/sdk/scripts/pack-smoke-test.mjs",
    "apps/cli/scripts/release-dry-run.mjs",
    "packages/sdk/scripts/release-dry-run.mjs",
  ] as const;

  it.each(CALLERS)("%s imports the shared handling", (file) => {
    const source = readFileSync(join(ROOT, file), "utf8");
    expect(source).toContain("npm-publish-dry-run.mjs");
    expect(source).toMatch(/isAlreadyPublished|runPublishDryRun/);
  });

  it("finds no dry run outside those four files", () => {
    // A `--dry-run` anywhere else would be a fifth caller with no handling, which is exactly how
    // the release rehearsals were missed.
    const tracked = execFileSync("git", ["ls-files", "*.mjs"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    // The argument literal, not the words. Prose about `npm publish --dry-run` appears in comments
    // — `scripts/verify-full-contract.mjs` explains that the smokes upload nothing — and a check
    // that counted those would be asserting how the repository writes comments.
    const withDryRun = tracked.filter((file) =>
      readFileSync(join(ROOT, file), "utf8").includes('"--dry-run"'),
    );
    expect(withDryRun.sort()).toEqual([...CALLERS].sort());
  });
});

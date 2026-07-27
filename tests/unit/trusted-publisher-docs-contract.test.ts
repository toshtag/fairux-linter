import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Pins the Trusted Publisher field values in `docs/sdk-beta-release.md` to the workflow they
 * describe.
 *
 * npm's record is external configuration: nothing in this repository can read it, and `npm trust
 * list` needs npm >= 11.15.0 plus a browser 2FA step, so the runbook is the only place the expected
 * values exist. That made it the single point of failure it turned out to be — it told owners to
 * enter `.github/workflows/publish-sdk.yml` as the workflow filename, npm accepted the path without
 * validating it, and `sdk-v0.1.0-beta.2` failed with `ENEEDAUTH` after the environment approval.
 *
 * These assertions cannot prove the record on npm is correct. They prove the runbook says something
 * npm could match, and that it still describes this workflow: the filename is the real file's
 * basename, and the environment is the one the publish job actually declares.
 */

const root = resolve(import.meta.dirname, "../..");
const WORKFLOW = ".github/workflows/publish-sdk.yml";

const doc = readFileSync(resolve(root, "docs/sdk-beta-release.md"), "utf8");

/** The `| Field | Value |` rows of the Trusted Publisher table, as a lookup. */
const fields = new Map(
  doc
    .split("\n")
    .map((line) => /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [match[1] as string, match[2] as string]),
);

const publishJob = (
  parse(readFileSync(resolve(root, WORKFLOW), "utf8")) as {
    jobs: Record<string, { environment?: { name?: string } }>;
  }
).jobs.publish;

describe("Trusted Publisher runbook", () => {
  it("names the workflow filename as a basename, never a path", () => {
    // npm's field is "the filename of your workflow". A path is accepted when the record is saved
    // and can never match at publish time — the failure mode that consumed `sdk-v0.1.0-beta.2`.
    const filename = fields.get("Workflow filename");
    expect(filename).toBe(`\`${basename(WORKFLOW)}\``);
    expect(filename).not.toContain("/");
  });

  it("names the environment the publish job actually declares", () => {
    // The record's environment claim is matched against the OIDC token. If the workflow's
    // environment is renamed and the runbook is not, the next release fails the same opaque way.
    expect(fields.get("Environment name")).toBe(`\`${publishJob?.environment?.name}\``);
  });

  it("names this repository and the publish action", () => {
    expect(fields.get("Provider")).toBe("GitHub Actions");
    expect(fields.get("Organization or user")).toBe("`toshtag`");
    expect(fields.get("Repository")).toBe("`fairux-linter`");
    expect(fields.get("Allowed actions")).toBe("`npm publish`");
  });

  it("keeps the basename rule stated, not just applied", () => {
    // The wrong value is the intuitive one, and npm's own error does not point at it.
    expect(doc).toContain("The workflow filename is a basename, not a path.");
  });
});

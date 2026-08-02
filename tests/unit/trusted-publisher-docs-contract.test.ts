import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Pins the Trusted Publisher field values in each release runbook to the workflow they describe,
 * and each documented read command to public npm.
 *
 * npm's record is external configuration: nothing in this repository can read it, and `npm trust
 * list` needs npm >= 11.15.0 plus a browser 2FA step the owner performs. The runbooks are therefore
 * the only place the expected values exist, and the SDK's previously documented
 * `.github/workflows/publish-sdk.yml` — a path, where npm's field is a filename. That instruction
 * was wrong on npm's own terms, independently of what the record holds.
 *
 * These assertions do not claim the external record caused any particular failure; the record has
 * not been read. They pin the values an owner checks against, and keep them tied to the workflow
 * each runbook is about: the filename is the real file's basename, and the environment is the one
 * that publish job actually declares.
 *
 * Both packages are covered by one file because the rule is one rule, and it is the same rule for
 * both: `npm trust list` takes `--registry` and nothing else, whatever the package is called.
 */

const root = resolve(import.meta.dirname, "../..");

interface Runbook {
  label: string;
  doc: string;
  workflow: string;
  packageName: string;
}

const RUNBOOKS: Runbook[] = [
  {
    label: "SDK",
    doc: "docs/maintainers/release-sdk.md",
    workflow: ".github/workflows/publish-sdk.yml",
    packageName: "@fairux/sdk",
  },
  {
    label: "CLI",
    doc: "docs/maintainers/release-cli.md",
    workflow: ".github/workflows/publish-cli.yml",
    packageName: "fairux",
  },
];

describe.each(RUNBOOKS)("$label Trusted Publisher runbook", (runbook) => {
  const doc = readFileSync(resolve(root, runbook.doc), "utf8");

  /** The body of a `###` section, up to the next heading of any level. */
  const section = (heading: string): string => {
    const start = doc.indexOf(`### ${heading}\n`);
    if (start === -1) throw new Error(`${runbook.doc} has no "### ${heading}" section`);
    const rest = doc.slice(start + heading.length + 5);
    const end = rest.search(/^#{2,3} /m);
    return end === -1 ? rest : rest.slice(0, end);
  };

  /**
   * The `| Field | Value |` rows of the Trusted Publisher table. Scoped to its own section: the
   * surrounding prose has to name the wrong value in order to warn about it.
   */
  const fields = new Map(
    section("Trusted Publisher record — exact field values")
      .split("\n")
      .map((line) => /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [match[1] as string, match[2] as string]),
  );

  /** The `npm trust list` invocation the runbook tells owners to run. */
  const trustCommand =
    (section("Reading the record").match(/```bash\n([\s\S]*?)```/) ?? [])[1] ?? "";

  const publishJob = (
    parse(readFileSync(resolve(root, runbook.workflow), "utf8")) as {
      jobs: Record<string, { environment?: { name?: string } }>;
    }
  ).jobs.publish;

  it("names the workflow filename as a basename, never a path", () => {
    // npm's field is "the filename of your workflow". npm accepts a path when the record is saved
    // without validating it, so the value can only be wrong at publish time.
    const filename = fields.get("Workflow filename");
    expect(filename).toBe(`\`${basename(runbook.workflow)}\``);
    expect(filename).not.toContain("/");
  });

  it("puts no workflow path in any Trusted Publisher field", () => {
    expect(fields.size).toBeGreaterThan(0);
    for (const [field, value] of fields) {
      expect(value, `${field} must not contain a workflow path`).not.toContain(
        ".github/workflows/",
      );
    }
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

  it("requires an npm new enough to have `npm trust`", () => {
    // `npm trust` landed in npm 11.15.0. Both Node.js floors here ship an older npm, so the command
    // has to name a version rather than assume the one on PATH.
    //
    // The requirement is the floor, not one spelling of it: an exact pin satisfies it as well as a
    // range does, and pinning the literal string here would have made a *stricter* runbook fail.
    const named = trustCommand.match(/npm@\^?(\d+)\.(\d+)\.(\d+)/);
    expect(named, trustCommand).not.toBeNull();
    const [major, minor] = [Number(named?.[1]), Number(named?.[2])];
    expect(major, trustCommand).toBeGreaterThanOrEqual(11);
    if (major === 11) expect(minor, trustCommand).toBeGreaterThanOrEqual(15);
    expect(trustCommand).toContain(`trust list ${runbook.packageName}`);
  });

  it("pins the one registry selector `npm trust list` accepts, and no other", () => {
    // This asserted both keys for `@fairux/sdk`, reasoning from how npm *resolves* a scoped
    // package: `@fairux:registry` is consulted first, so `--registry` alone leaves an npmrc line in
    // charge of which host is asked. That reasoning is correct for `install`, `view`, and
    // `publish` — and `scripts/test-scoped-registry-routing.mjs` still holds it for publishes — but
    // it was applied to a subcommand that rejects the flag. `npm trust list` takes `--json` and
    // `--registry`; the documented command failed with `EUSAGE Unknown flag` for whoever ran it
    // first. The package is named explicitly in the command, so one selector is the whole choice
    // of host.
    const pinned = trustCommand.match(/--[^\s\\]*registry=[^\s\\]+/g) ?? [];
    expect(pinned).toEqual(["--registry=https://registry.npmjs.org/"]);
    expect(trustCommand).not.toMatch(/--@[^\s\\]*:registry=/);
  });

  it("warns that the read may need 2FA, and that its secrets stay unrecorded", () => {
    const body = section("Reading the record");
    expect(body).toContain("2FA");
    expect(body).toContain("Do not record the authentication URL");
  });
});

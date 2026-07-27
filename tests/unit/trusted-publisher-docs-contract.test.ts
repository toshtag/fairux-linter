import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Pins the Trusted Publisher field values in `docs/sdk-beta-release.md` to the workflow they
 * describe, and the documented read command to public npm.
 *
 * npm's record is external configuration: nothing in this repository can read it, and `npm trust
 * list` needs npm >= 11.15.0 plus a browser 2FA step the owner performs. The runbook is therefore
 * the only place the expected values exist, and it previously documented
 * `.github/workflows/publish-sdk.yml` — a path, where npm's field is a filename. That instruction
 * was wrong on npm's own terms, independently of what the record holds.
 *
 * These assertions do not claim the external record caused any particular failure; the record has
 * not been read. They pin the values an owner checks against, and keep them tied to this workflow:
 * the filename is the real file's basename, and the environment is the one the publish job actually
 * declares.
 */

const root = resolve(import.meta.dirname, "../..");
const WORKFLOW = ".github/workflows/publish-sdk.yml";

const doc = readFileSync(resolve(root, "docs/sdk-beta-release.md"), "utf8");

/** The body of a `###` section, up to the next heading of any level. */
const section = (heading: string): string => {
  const start = doc.indexOf(`### ${heading}\n`);
  if (start === -1) throw new Error(`docs/sdk-beta-release.md has no "### ${heading}" section`);
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
const trustCommand = (section("Reading the record").match(/```bash\n([\s\S]*?)```/) ?? [])[1] ?? "";

const publishJob = (
  parse(readFileSync(resolve(root, WORKFLOW), "utf8")) as {
    jobs: Record<string, { environment?: { name?: string } }>;
  }
).jobs.publish;

describe("Trusted Publisher runbook", () => {
  it("names the workflow filename as a basename, never a path", () => {
    // npm's field is "the filename of your workflow". npm accepts a path when the record is saved
    // without validating it, so the value can only be wrong at publish time.
    const filename = fields.get("Workflow filename");
    expect(filename).toBe(`\`${basename(WORKFLOW)}\``);
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
    expect(trustCommand).toContain("npm@^11.15.0");
    expect(trustCommand).toContain("trust list @fairux/sdk");
  });

  it("pins both registry keys on the read command", () => {
    // npm resolves a scoped package through `@fairux:registry` first and only falls back to
    // `registry`, so `--registry` alone leaves an `@fairux:registry=` line in any npmrc in charge
    // of which host is asked. Reading the record off the wrong registry is the same class of
    // mistake `scripts/test-scoped-registry-routing.mjs` exists to prevent for publishes.
    expect(trustCommand).toContain("--registry=https://registry.npmjs.org/");
    expect(trustCommand).toContain("--@fairux:registry=https://registry.npmjs.org/");
  });

  it("warns that the read may need 2FA, and that its secrets stay unrecorded", () => {
    const body = section("Reading the record");
    expect(body).toContain("2FA");
    expect(body).toContain("Do not record the authentication URL");
  });
});

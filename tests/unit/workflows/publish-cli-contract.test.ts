import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cliReleaseNotesInvocation } from "../../../apps/cli/scripts/release-notes.mjs";

/**
 * The CLI publish workflow's live interface.
 *
 * `publish-oidc-contract.test.ts` owns the privilege boundary both publish workflows share.
 * What is asserted here is what M1-R2 added, and each assertion is a defect the M1-R1 audit
 * found rather than a restatement of the file:
 *
 * - the workflow ended at `npm publish`, so nothing checked that what npm stored was what it
 *   audited, a rerun of a successful release went red on `E409`, and a version present with
 *   different bytes was left to the registry to reject;
 * - it created no GitHub Release, which `docs/roadmap.md` requires for M1;
 * - it relied on npm's unscoped default for public access rather than stating it;
 * - `validate` never asserted the package name or that the package was publishable.
 *
 * The order of the publish sequence is the load-bearing part and is checked as an ordering, not
 * as the presence of steps: every one of these could be present and still be in the wrong place.
 */

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  on?: unknown;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const root = resolve(import.meta.dirname, "../../..");
const source = readFileSync(resolve(root, ".github/workflows/publish-cli.yml"), "utf8");

// Imported lazily so this file states its own dependency on `yaml` the same way its neighbours do.
const { parse } = await import("yaml");
const workflow = parse(source) as Workflow;

const publish = workflow.jobs.publish;
const steps = publish?.steps ?? [];
const runs = steps.map((step) => step.run ?? "").join("\n");
const indexOf = (needle: string) => steps.findIndex((step) => step.run?.includes(needle));

describe("publish-cli.yml publication plan", () => {
  it("plans the publication before it publishes", () => {
    // Absent → publish. Present with the same digest → skip, which is what makes a rerun of a
    // successful release green rather than an E409. Present with different bytes → hard fail.
    expect(indexOf("apps/cli/scripts/release-registry-plan.mjs")).toBeGreaterThanOrEqual(0);
    expect(indexOf("apps/cli/scripts/release-registry-plan.mjs")).toBeLessThan(
      indexOf("npm publish"),
    );
  });

  it("publishes only when the plan says it is needed", () => {
    const publishStep = steps.find((step) => step.run?.includes("npm publish"));
    expect(publishStep?.run).toContain('if [ "$PUBLISH_NEEDED" = "true" ]');
    expect(publishStep?.run).toContain("skipping npm publish");
  });

  it("uses the CLI's own plan, not the SDK's", () => {
    // Two packages, two Trusted Publisher records, two registry resolution paths. The SDK's
    // script binds `@fairux:registry`, which `fairux` has no use for.
    expect(runs).not.toContain("packages/sdk/scripts/release-registry-plan.mjs");
  });

  it("verifies the registry digest after the publish, and only waits there", () => {
    const verify = indexOf("--require-present");
    expect(verify).toBeGreaterThan(indexOf("npm publish"));
    expect(steps[verify]?.run).toContain("--wait-for-present");
    // Waiting on the pre-publish read would spend the deadline on a state the publish resolves.
    expect(steps[indexOf("--env-file")]?.run).not.toContain("--wait-for-present");
  });

  it("verifies the dist-tags as a separate claim, after the digest", () => {
    // The right bytes being on npm says nothing about whether they are reachable at the channel
    // this release announced, or about whether `latest` has appeared.
    expect(indexOf("verify-cli-dist-tags.mjs")).toBeGreaterThan(indexOf("--require-present"));
  });

  it("never removes a dist-tag", () => {
    // A `latest` this repository did not create is an owner decision. Deleting registry state to
    // make a check pass is not a fix.
    expect(runs).not.toContain("dist-tag rm");
    expect(runs).not.toContain("dist-tag add");
  });
});

describe("publish-cli.yml first publish", () => {
  it("states --access public rather than relying on npm's unscoped default", () => {
    // `fairux` is unscoped and npm defaults an unscoped package to public. The first publish of a
    // package that does not yet exist is not the place to depend on a default staying what it is.
    expect(steps.find((step) => step.run?.includes("npm publish"))?.run).toContain(
      "--access public",
    );
  });

  it("keeps provenance, the pinned registry, and no lifecycle scripts", () => {
    const command = steps.find((step) => step.run?.includes("npm publish"))?.run ?? "";
    expect(command).toContain("--provenance");
    expect(command).toContain("--registry=https://registry.npmjs.org/");
    expect(command).toContain("--ignore-scripts");
    expect(command).toContain('--tag "$DIST_TAG"');
    expect(command).toContain('"$TARBALL"');
  });

  it("publishes the verified tarball, never a path it built itself", () => {
    expect(runs).not.toMatch(/npm publish[^\n]*\.\//);
    expect(runs).not.toContain("pnpm pack");
  });
});

describe("publish-cli.yml GitHub Release", () => {
  it("creates or repairs the Release, so a rerun is not a duplicate", () => {
    const release = steps.find((step) => step.run?.includes("gh release"))?.run ?? "";
    expect(release).toContain("gh release view");
    expect(release).toContain("gh release create");
    expect(release).toContain("gh release edit");
    expect(release).toContain("--clobber");
  });

  it("creates it only after the registry agrees", () => {
    // A Release created earlier would announce a publication this run had not yet verified.
    expect(indexOf("gh release")).toBeGreaterThan(indexOf("verify-cli-dist-tags.mjs"));
  });

  it("attaches the tarball and its checksum from the verified bundle", () => {
    const release = steps.find((step) => step.run?.includes("gh release"))?.run ?? "";
    expect(release).toContain('"$TARBALL"');
    expect(release).toContain('"$RUNNER_TEMP/bundle/release-sha256.txt"');
  });

  it("does not double the v the version already carries", () => {
    // `@fairux/sdk v0.1.0-beta.2` shipped, and the version already carried its own prefix.
    const release = steps.find((step) => step.run?.includes("gh release"))?.run ?? "";
    expect(release).toContain('--title "fairux ${VERSION}"');
    expect(release).not.toContain('--title "fairux v${VERSION}"');
  });

  it("marks a prerelease as one, derived from the dist-tag the bundle verifier produced", () => {
    const step = steps.find((s) => s.run?.includes("gh release"));
    expect(step?.run).toContain("--prerelease");
    expect(step?.env?.IS_PRERELEASE).toBe("${{ env.DIST_TAG != 'latest' }}");
  });

  it("runs exactly this notes command, and nothing else in the step", () => {
    // Searching the step for each option name would prove only that the names appear somewhere:
    // an extra flag, a reordered pair, or a second command appended after the generator would all
    // pass. The whole step is compared instead.
    //
    // `joinContinuations` handles this step's backslash line continuations and nothing more. It is
    // not a shell parser, and it would be wrong for a step containing quoted newlines or `&&`.
    const joinContinuations = (run: string) =>
      run
        .split("\n")
        .map((line) => line.trim().replace(/\\$/, "").trim())
        .filter(Boolean)
        .join(" ");
    const step = steps.find((s) => s.run?.includes("release-notes.mjs"));

    expect(joinContinuations(step?.run ?? "")).toBe(
      [
        "node apps/cli/scripts/release-notes.mjs",
        "--package-json apps/cli/package.json",
        '--tag "$RELEASE_TAG"',
        '--source-commit "$TAG_COMMIT"',
        '--dist-tag "$DIST_TAG"',
        '--tarball "$TARBALL"',
        '--checksum "$RUNNER_TEMP/bundle/release-sha256.txt"',
        '--out "$RUNNER_TEMP/cli-release-notes.md"',
      ].join(" "),
    );
  });

  it("passes the same option sequence the generator derives, so the two cannot drift", () => {
    // The literal above is what the workflow runs; this is what `release:dry-run:cli` rehearses.
    // The SDK's dry run stopped covering its publish job precisely because the two were written
    // out separately and only one was updated.
    const derived = cliReleaseNotesInvocation({
      tag: "v0.1.0-beta.1",
      sourceCommit: "0".repeat(40),
      tarball: "/tmp/bundle/fairux-0.1.0-beta.1.tgz",
      out: "/tmp/notes.md",
    });
    const flagsFrom = (argv: readonly string[]) => argv.filter((token) => token.startsWith("--"));
    const step = steps.find((s) => s.run?.includes("release-notes.mjs"))?.run ?? "";
    expect(flagsFrom(step.split(/\s+/))).toEqual(flagsFrom(derived));
  });

  it("generates the notes in the privileged job, from its own checkout", () => {
    // The notes become the Release body. Generating them in `prepare` — where dependency and
    // `prepack` scripts run — would let that job choose the text this repository publishes.
    const prepareRuns = (workflow.jobs.prepare?.steps ?? [])
      .map((step) => step.run ?? "")
      .join("\n");
    expect(prepareRuns).not.toContain("release-notes.mjs");
    expect(runs).toContain("apps/cli/scripts/release-notes.mjs");
  });
});

describe("publish-cli.yml validate", () => {
  const validateRuns = (workflow.jobs.validate?.steps ?? [])
    .map((step) => step.run ?? "")
    .join("\n");

  it("asserts the release contract before anything is installed", () => {
    expect(validateRuns).toContain("apps/cli/scripts/check-cli-release-version.mjs");
    expect(validateRuns).toContain("merge-base --is-ancestor");
    // No install in this job at all: the point is that it runs before one.
    expect(validateRuns).not.toContain("pnpm install");
  });

  it("holds no write permission and no OIDC token", () => {
    expect(workflow.jobs.validate?.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.prepare?.permissions).toEqual({ contents: "read" });
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("checks the release contract again in prepare, before and after the pack", () => {
    const prepareRuns = (workflow.jobs.prepare?.steps ?? [])
      .map((step) => step.run ?? "")
      .join("\n");
    expect(prepareRuns.match(/release:check:cli/g) ?? []).toHaveLength(2);
    expect(prepareRuns).toContain("--tarball");
  });
});

describe("publish-cli.yml tag handling", () => {
  it("never interpolates the tag straight into a shell command", () => {
    // Git's ref rules reject a space and some glob characters but allow `"`, `$`, `;`, and a
    // backtick, so `v0.1.0";id;"` is a pushable tag. Every use reaches the shell through `env`.
    for (const step of steps.concat(
      workflow.jobs.validate?.steps ?? [],
      workflow.jobs.prepare?.steps ?? [],
    )) {
      expect(step.run ?? "").not.toContain("${{ github.ref_name }}");
      expect(step.run ?? "").not.toContain("${{ github.sha }}");
    }
  });

  it("triggers on a tag push only", () => {
    expect(workflow.on).toEqual({ push: { tags: ["v*"] } });
  });
});

/**
 * A contract that only ever sees the passing case proves nothing about what it would catch.
 *
 * `publishSequenceErrors` is the ordering and flag policy as one function, so each mutation below
 * is a realistic way the publish job could drift back to what M1-R1 found — and each must be
 * reported rather than tolerated. The checker takes steps rather than reading the file, which is
 * what makes a mutated copy testable without writing one to disk.
 */
function publishSequenceErrors(candidate: Step[]): string[] {
  const errors: string[] = [];
  const at = (needle: string) => candidate.findIndex((step) => step.run?.includes(needle));
  const command = candidate.find((step) => step.run?.includes("npm publish"))?.run ?? "";

  const plan = at("release-registry-plan.mjs");
  const publishAt = at("npm publish");
  const verify = at("--require-present");
  const distTags = at("verify-cli-dist-tags.mjs");
  const release = at("gh release");
  const preflights = candidate
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.run?.includes("check-trusted-publishing.mjs"))
    .map(({ index }) => index);

  if (plan < 0 || publishAt < 0) errors.push("the plan and the publish must both be present");
  if (plan >= 0 && publishAt >= 0 && plan > publishAt) {
    errors.push("the publication plan must run before the publish");
  }
  if (verify < 0 || (publishAt >= 0 && verify < publishAt)) {
    errors.push("the registry digest must be verified after the publish");
  }
  if (distTags < 0 || (verify >= 0 && distTags < verify)) {
    errors.push("the dist-tags must be verified after the digest");
  }
  if (release < 0 || (distTags >= 0 && release < distTags)) {
    errors.push("the GitHub Release must be created after the registry agrees");
  }
  if (!command.includes("--access public")) errors.push("npm publish must state --access public");
  if (!command.includes('--tag "$DIST_TAG"')) {
    errors.push("npm publish must name the verified dist-tag");
  }
  if (!command.includes('if [ "$PUBLISH_NEEDED" = "true" ]')) {
    errors.push("npm publish must be conditional on the plan");
  }
  if (preflights.length !== 2) {
    errors.push(
      "the Trusted Publishing preflight must run before the first npm read and again before the publish",
    );
  }
  if (candidate.some((step) => step.run?.includes("dist-tag rm"))) {
    errors.push("the workflow must not remove a dist-tag");
  }
  if (candidate.some((step) => step.run?.includes("pnpm install"))) {
    errors.push("the publish job must install nothing");
  }
  return errors;
}

describe("publish-cli.yml publish sequence, mutated", () => {
  const clone = () => JSON.parse(JSON.stringify(steps)) as Step[];
  const editPublish = (edit: (run: string) => string) => {
    const candidate = clone();
    const index = candidate.findIndex((step) => step.run?.includes("npm publish"));
    candidate[index].run = edit(candidate[index].run ?? "");
    return candidate;
  };
  const move = (needle: string, to: number) => {
    const candidate = clone();
    const from = candidate.findIndex((step) => step.run?.includes(needle));
    const [step] = candidate.splice(from, 1);
    candidate.splice(to, 0, step);
    return candidate;
  };
  const drop = (needle: string) => clone().filter((step) => !step.run?.includes(needle));

  it("accepts the checked-in sequence", () => {
    expect(publishSequenceErrors(steps as Step[])).toEqual([]);
  });

  it.each([
    ["dropping --tag from the publish", editPublish((run) => run.replace('--tag "$DIST_TAG"', ""))],
    ["dropping --access public", editPublish((run) => run.replace("--access public", ""))],
    [
      "publishing unconditionally",
      editPublish((run) => run.replace('if [ "$PUBLISH_NEEDED" = "true" ]', "if true")),
    ],
    ["moving the plan after the publish", move("release-registry-plan.mjs", steps.length - 1)],
    ["dropping the digest verification", drop("--require-present")],
    ["dropping the dist-tag verification", drop("verify-cli-dist-tags.mjs")],
    ["creating the Release before the registry is checked", move("gh release", 0)],
    ["dropping a Trusted Publishing preflight", drop("check-trusted-publishing.mjs")],
  ])("rejects %s", (_label, mutated) => {
    expect(publishSequenceErrors(mutated)).not.toEqual([]);
  });

  it("rejects a workflow that removes a dist-tag to make its own check pass", () => {
    const candidate = clone();
    candidate.push({ name: "Clear latest", run: "npm dist-tag rm fairux latest" });
    expect(publishSequenceErrors(candidate)).toContain("the workflow must not remove a dist-tag");
  });

  it("rejects a dependency install in the privileged job", () => {
    const candidate = clone();
    candidate.splice(2, 0, { name: "Install", run: "pnpm install --frozen-lockfile" });
    expect(publishSequenceErrors(candidate)).toContain("the publish job must install nothing");
  });
});

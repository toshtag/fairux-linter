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

  it("verifies the dist-tags before the publish, where refusing is still possible", () => {
    // An unexpected `latest` found afterwards is found once `0.1.0-beta.1` has been permanently
    // spent: npm never lets a name/version pair be reused. This was the whole gap — the first
    // version of this workflow checked channels only after `npm publish`.
    const before = indexOf("--phase before-publish");
    expect(before).toBeGreaterThan(indexOf("--env-file"));
    expect(before).toBeLessThan(indexOf("npm publish"));
    // The plan's answer decides what `next` is allowed to be, so it has to be passed through.
    expect(steps[before]?.run).toContain('--publish-needed "$PUBLISH_NEEDED"');
  });

  it("verifies the dist-tags again after the digest, as a separate claim", () => {
    // The right bytes being on npm says nothing about whether they are reachable at the channel
    // this release announced.
    expect(indexOf("--phase after-publish")).toBeGreaterThan(indexOf("--require-present"));
  });

  it("generates the release notes before anything is published", () => {
    // Every input is deterministic — the checked-out manifest and the values the bundle verifier
    // derived here — so nothing about the notes needs the registry. Generating them afterwards
    // meant a drifted manifest, a `repository.url` pointing elsewhere above all, failed only once
    // the version had been permanently spent.
    expect(indexOf("release-notes.mjs")).toBeLessThan(indexOf("npm publish"));
  });

  it("generates them exactly once and attaches that same file", () => {
    // Regenerating for the Release would mean the bytes announced are not the bytes validated.
    expect(steps.filter((step) => step.run?.includes("release-notes.mjs"))).toHaveLength(1);
    const notesFile = "$RUNNER_TEMP/cli-release-notes.md";
    expect(steps.find((s) => s.run?.includes("release-notes.mjs"))?.run).toContain(notesFile);
    expect(steps.find((s) => s.run?.includes("gh release create"))?.run).toContain(notesFile);
  });

  it("reads back provenance metadata before the notes claim it", () => {
    // The notes said "the npm package carries provenance" while the workflow verified digests and
    // dist-tags and never read `dist.attestations` — an assumption about what `--provenance` does,
    // published as a fact.
    // The notes are written before the publish; what must not happen before the provenance read
    // is *publishing* them. Ordering is on the Release, which is the outward-facing step.
    const provenance = indexOf("verify-cli-provenance.mjs");
    expect(provenance).toBeGreaterThan(indexOf("npm publish"));
    expect(provenance).toBeLessThan(indexOf("gh release create"));
  });

  it("pins the GitHub REST API version and encodes the tag in the path", () => {
    // GitHub versions its API by date; a request naming no version gets whatever is current, so a
    // breaking change would arrive as a release-time surprise rather than as a decision.
    const source = readFileSync(
      resolve(root, "apps/cli/scripts/verify-existing-cli-release.mjs"),
      "utf8",
    );
    expect(source).toContain("X-GitHub-Api-Version");
    expect(source).toContain("Accept: application/vnd.github+json");
    expect(source).toContain("encodeURIComponent(tag)");
  });

  it("reads provenance through the CLI's own pinned registry arguments", () => {
    // Not a bare `npm view`: every registry read in this path names the registry rather than
    // resolving it from npm config.
    const source = readFileSync(
      resolve(root, "apps/cli/scripts/verify-cli-provenance.mjs"),
      "utf8",
    );
    expect(source).toContain("NPM_CLI_VIEW_REGISTRY_ARGS");
  });

  it("never removes a dist-tag", () => {
    // A channel this workflow did not publish to is the owner's, and rewriting registry state to
    // make a check pass is not a fix. `latest` is the case that proves it: it holds the bootstrap
    // placeholder because npm put it there, npm refuses to remove it, and the contract was changed
    // to accept the registry rather than the workflow being taught to "repair" it.
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
    const release = steps.find((step) => step.run?.includes("gh release create"))?.run ?? "";
    expect(release).toContain("gh release create");
    expect(release).toContain("gh release edit");
    expect(release).toContain("--clobber");
  });

  it("decides create-versus-repair from a checked state, not from a failed command", () => {
    // `gh release view` failing is not the same as the Release not existing: a token problem, an
    // API outage, and a rate limit all fail too, and taking the create path against a Release that
    // is already there is how a run makes a second one.
    const check = indexOf("verify-existing-cli-release.mjs");
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(indexOf("gh release create"));
    expect(runs).not.toMatch(/if gh release view/);
    expect(steps.find((step) => step.run?.includes("gh release create"))?.run).toContain(
      'if [ "$RELEASE_EXISTS" = "true" ]',
    );
  });

  it("checks the existing Release before the last tag check", () => {
    // Ordered so the tag identity check stays immediately before `gh release`: a read-only API
    // call between them would still widen the window that check exists to close.
    const check = indexOf("verify-existing-cli-release.mjs");
    const lastTagCheck = steps.reduce(
      (last, step, index) => (step.run?.includes("verify-cli-release-tag.mjs") ? index : last),
      -1,
    );
    expect(check).toBeGreaterThan(indexOf("npm publish"));
    expect(check).toBeLessThan(lastTagCheck);
  });

  it("creates it only after the registry agrees", () => {
    // A Release created earlier would announce a publication this run had not yet verified.
    expect(indexOf("gh release create")).toBeGreaterThan(indexOf("--phase after-publish"));
  });

  it("refuses to create a tag it cannot find", () => {
    // `gh release create <tag>` creates the tag from the default branch's current head when it is
    // missing. Without `--verify-tag`, a tag deleted mid-run would produce a Release pointing at
    // `main` beside a package built from `TAG_COMMIT`.
    const release = steps.find((step) => step.run?.includes("gh release create"))?.run ?? "";
    const verifyTags = release.match(/--verify-tag/g) ?? [];
    expect(verifyTags).toHaveLength(2);
    expect(release).not.toContain("--target");
  });

  it("attaches the tarball and its checksum from the verified bundle", () => {
    const release = steps.find((step) => step.run?.includes("gh release create"))?.run ?? "";
    expect(release).toContain('"$TARBALL"');
    expect(release).toContain('"$RUNNER_TEMP/bundle/release-sha256.txt"');
  });

  it("does not double the v the version already carries", () => {
    // `@fairux/sdk v0.1.0-beta.2` shipped, and the version already carried its own prefix.
    const release = steps.find((step) => step.run?.includes("gh release create"))?.run ?? "";
    expect(release).toContain('--title "fairux ${VERSION}"');
    expect(release).not.toContain('--title "fairux v${VERSION}"');
  });

  it("marks a prerelease as one, derived from the dist-tag the bundle verifier produced", () => {
    const step = steps.find((s) => s.run?.includes("gh release create"));
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

describe("publish-cli.yml release tag identity", () => {
  const tagChecks = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.run?.includes("verify-cli-release-tag.mjs"))
    .map(({ index }) => index);

  it("re-reads the tag immediately before each irreversible outward step", () => {
    // `github.sha` is the commit the tag named when the run was triggered. The publish job waits on
    // the environment's required reviewer, so the gap is however long a human takes — long enough
    // for the tag to be deleted or force-moved, and nothing else in the run re-reads it.
    expect(tagChecks).toHaveLength(2);
    expect(tagChecks[0]).toBeLessThan(indexOf("npm publish"));
    expect(tagChecks[1]).toBeGreaterThan(indexOf("npm publish"));
    expect(tagChecks[1]).toBeLessThan(indexOf("gh release create"));
  });

  it("compares against the tag-trigger commit, passed as data", () => {
    for (const index of tagChecks) {
      expect(steps[index]?.run).toContain('--expected-commit "$TAG_COMMIT"');
      expect(steps[index]?.env?.TAG_COMMIT).toBe("${{ github.sha }}");
      expect(steps[index]?.env?.RELEASE_TAG).toBe("${{ github.ref_name }}");
    }
  });

  it("leaves no step between the second check and the Release", () => {
    // A check that is not immediately before the thing it guards is a check about a different
    // moment. The notes are generated before it, so nothing runs in between.
    expect(indexOf("gh release create")).toBe((tagChecks[1] as number) + 1);
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
  const indexesOf = (needle: string) =>
    candidate
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.run?.includes(needle))
      .map(({ index }) => index);

  const plan = at("--env-file");
  const publishAt = at("npm publish");
  const distTagsBefore = at("--phase before-publish");
  const distTagsAfter = at("--phase after-publish");
  const provenance = at("verify-cli-provenance.mjs");
  const existingRelease = at("verify-existing-cli-release.mjs");
  const digest = at("--require-present");
  const release = at("gh release create");
  const notes = at("release-notes.mjs");
  const preflights = indexesOf("check-trusted-publishing.mjs");
  const tagChecks = indexesOf("verify-cli-release-tag.mjs");
  const releaseStep = candidate.find((step) => step.run?.includes("gh release create"))?.run ?? "";

  if (plan < 0 || publishAt < 0) errors.push("the plan and the publish must both be present");
  if (plan >= 0 && publishAt >= 0 && plan > publishAt) {
    errors.push("the publication plan must run before the publish");
  }

  // The gate that can still refuse. Everything below it is a check about a version already spent.
  if (distTagsBefore < 0 || (publishAt >= 0 && distTagsBefore > publishAt)) {
    errors.push("the dist-tags must be verified before the publish");
  }
  if (distTagsBefore >= 0 && plan >= 0 && distTagsBefore < plan) {
    errors.push("the pre-publish dist-tag gate needs the publication plan's answer");
  }
  if (digest < 0 || (publishAt >= 0 && digest < publishAt)) {
    errors.push("the registry digest must be verified after the publish");
  }
  if (distTagsAfter < 0 || (digest >= 0 && distTagsAfter < digest)) {
    errors.push("the dist-tags must be verified again after the digest");
  }
  if (release < 0 || (distTagsAfter >= 0 && release < distTagsAfter)) {
    errors.push("the GitHub Release must be created after the registry agrees");
  }
  if (provenance < 0 || (publishAt >= 0 && provenance < publishAt)) {
    errors.push("provenance metadata must be read back after the publish");
  }
  if (notes < 0 || (publishAt >= 0 && notes > publishAt)) {
    errors.push("the release notes must be generated before anything is published");
  }
  if (candidate.filter((step) => step.run?.includes("release-notes.mjs")).length !== 1) {
    errors.push("the release notes must be generated exactly once");
  }
  if (provenance >= 0 && release >= 0 && provenance > release) {
    errors.push("provenance must be verified before the Release publishes the claim");
  }
  if (existingRelease < 0 || (release >= 0 && existingRelease > release)) {
    errors.push("an existing GitHub Release must be checked before it is edited");
  }
  if (releaseStep.includes("gh release view")) {
    errors.push("create-versus-repair must not be decided by whether a command failed");
  }

  // Two reads of the tag, each immediately before an irreversible outward step.
  if (tagChecks.length !== 2) {
    errors.push("the remote release tag must be re-read before the publish and before the Release");
  } else {
    if (publishAt >= 0 && (tagChecks[0] as number) > publishAt) {
      errors.push("the first tag check must run before the publish");
    }
    if (release >= 0 && (tagChecks[1] as number) > release) {
      errors.push("the second tag check must run before the GitHub Release");
    }
  }
  if ((releaseStep.match(/--verify-tag/g) ?? []).length !== 2) {
    errors.push("gh release create and edit must both pass --verify-tag");
  }
  if (releaseStep.includes("--target")) {
    errors.push("gh release must not be given a target to create a tag from");
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
  const editStep = (needle: string, edit: (run: string) => string) => {
    const candidate = clone();
    // `find`, not `findIndex` then index: the same lookup, without a number that
    // `noUncheckedIndexedAccess` then has to be talked out of.
    const target = candidate.find((step) => step.run?.includes(needle));
    if (!target) throw new Error(`the workflow has no step running ${needle}`);
    target.run = edit(target.run ?? "");
    return candidate;
  };
  const editPublish = (edit: (run: string) => string) => editStep("npm publish", edit);
  const editRelease = (edit: (run: string) => string) => editStep("gh release create", edit);
  const move = (needle: string, to: number) => {
    const candidate = clone();
    const from = candidate.findIndex((step) => step.run?.includes(needle));
    if (from < 0) throw new Error(`the workflow has no step running ${needle}`);
    const [step] = candidate.splice(from, 1);
    if (!step) throw new Error(`splice removed nothing at ${from}`);
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
    ["dropping both dist-tag verifications", drop("verify-cli-dist-tags.mjs")],
    ["dropping only the pre-publish dist-tag gate", drop("--phase before-publish")],
    [
      "moving the pre-publish dist-tag gate after the publish",
      move("--phase before-publish", steps.length - 1),
    ],
    ["dropping only the post-publish dist-tag check", drop("--phase after-publish")],
    ["dropping the provenance read-back", drop("verify-cli-provenance.mjs")],
    ["generating the notes after the publish", move("release-notes.mjs", steps.length - 1)],
    [
      "moving the provenance read-back after the Release",
      move("verify-cli-provenance.mjs", steps.length - 1),
    ],
    ["creating the Release before the registry is checked", move("gh release create", 0)],
    ["dropping the existing-Release state check", drop("verify-existing-cli-release.mjs")],
    [
      "checking the existing Release after it has been edited",
      move("verify-existing-cli-release.mjs", steps.length - 1),
    ],
    ["dropping a Trusted Publishing preflight", drop("check-trusted-publishing.mjs")],
    ["dropping both remote tag checks", drop("verify-cli-release-tag.mjs")],
    [
      "moving the first tag check after the publish",
      move("verify-cli-release-tag.mjs", steps.length - 1),
    ],
    [
      "dropping --verify-tag from gh release",
      editRelease((run) => run.replaceAll("--verify-tag \\\n", "")),
    ],
    [
      "letting gh release create the tag from a target",
      editRelease((run) => run.replace("--verify-tag", "--target main")),
    ],
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

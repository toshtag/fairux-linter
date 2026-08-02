import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../../..");
const path = ".github/workflows/approve-rule-change.yml";
const source = readFileSync(resolve(root, path), "utf8");

type Step = {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, string>;
};
type Job = {
  readonly permissions?: Record<string, string>;
  readonly environment?: { readonly name?: string; readonly deployment?: boolean };
  readonly needs?: string[];
  readonly steps: readonly Step[];
};
const workflow = parse(source) as {
  readonly on: Record<string, unknown>;
  readonly permissions: Record<string, string>;
  readonly jobs: Record<string, Job>;
};

const prepare = workflow.jobs.prepare as Job;
const approve = workflow.jobs.approve as Job;
const runOf = (job: Job, name: string) => job.steps.find((step) => step.name === name)?.run ?? "";

/**
 * The approval flow this replaced asked a maintainer to write a paragraph and an agent to transcribe
 * six values into JSON. This one asks for a click. The properties below are what make that a
 * relocation of the gate rather than a removal of it.
 */
describe("the rule change approval workflow", () => {
  it("runs only on manual dispatch, so a pull request cannot change its own approval", () => {
    // `workflow_dispatch` always executes the definition on the default branch. A `pull_request`
    // trigger would run the version in the branch being approved.
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("keeps write access out of the job that installs and builds the pull request's code", () => {
    expect(prepare.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(prepare.environment).toBeUndefined();
  });

  it("gates writing behind the protected environment, and records no deployment", () => {
    expect(approve.environment).toEqual({
      name: "rule-maintenance-approval",
      deployment: false,
    });
    expect(approve.needs).toEqual(["prepare"]);
    expect(approve.permissions?.contents).toBe("write");
  });

  it("refuses a fork and a closed pull request before anything else", () => {
    const read = runOf(prepare, "Read the pull request");
    expect(read).toContain("comes from a fork");
    expect(read).toContain("not OPEN");
  });

  it("checks the shape of both values that cross a job boundary", () => {
    // `$GITHUB_OUTPUT` is line-oriented, so a newline in either would let one value define another.
    // The branch name is chosen by whoever opened the pull request.
    const read = runOf(prepare, "Read the pull request");
    expect(read).toContain("head SHA is not 40 hex characters");
    expect(read).toContain("refusing an unusual branch name");
  });

  it("takes the approver from the environment review, not from who pressed the button", () => {
    // `github.actor` on a dispatch is whoever started the run. Recording that as the approver would
    // be worse than the manual flow, because it would look measured.
    const step = runOf(approve, "Read who approved the environment");
    expect(step).toContain("actions/runs/$GITHUB_RUN_ID/approvals");
    expect(step).toContain('select(.state == "approved")');
    expect(step).toContain("expected exactly one environment approver");
    expect(source).not.toContain("APPROVED_BY: ${{ github.actor }}");
  });

  it("refuses a branch that moved while the approval was pending, twice", () => {
    // Once before writing anything, and once before pushing — the run installs and builds the pull
    // request's own code in between.
    expect(runOf(approve, "Confirm the branch has not moved")).toContain(
      "Branch moved while approval was pending",
    );
    expect(runOf(approve, "Push the approval commit")).toContain("Branch moved during the run");
  });

  it("regenerates what the approval makes stale, before verifying the gate", () => {
    // The catalog embeds each rule's review status, approver, and date. Found by the first approval
    // that reached this job: the packet was valid, its own gate passed, and `rules:catalog:check`
    // failed on two generated files.
    const names = approve.steps.map((step) => step.name ?? step.uses ?? "");
    expect(names.indexOf("Regenerate the catalog the approval just changed")).toBeGreaterThan(
      names.indexOf("Record the approval"),
    );
    expect(names.indexOf("Regenerate the catalog the approval just changed")).toBeLessThan(
      names.indexOf("Verify the gate now passes"),
    );
  });

  it("commits every file the approval touches, generated ones included", () => {
    const push = runOf(approve, "Push the approval commit");
    for (const file of [
      "packages/rules/reviews/maintainer-approval.json",
      "packages/rules/reviews/built-in-rule-reviews.json",
      "packages/rules/src/generated/reviewed-governance.ts",
      "docs/generated/rule-catalog.json",
      "docs/rules.md",
    ]) {
      expect(push, file).toContain(file);
    }
  });

  it("verifies the commit lints, because an unmergeable branch is not an approval", () => {
    const names = approve.steps.map((step) => step.name ?? step.uses ?? "");
    expect(names).toContain("Verify the approval commit lints");
    expect(names.indexOf("Verify the approval commit lints")).toBeLessThan(
      names.indexOf("Push the approval commit"),
    );
  });

  it("verifies the gate passes before pushing, not after", () => {
    const steps = approve.steps.map((step) => step.name);
    expect(steps.indexOf("Verify the gate now passes")).toBeLessThan(
      steps.indexOf("Push the approval commit"),
    );
    const verify = runOf(approve, "Verify the gate now passes");
    expect(verify).toContain("rules:reviews:check:approved");
    expect(verify).toContain("rules:catalog:check");
  });

  it("runs its own tooling from the default branch, in both jobs", () => {
    // Found by running it: a pull request opened before the tooling existed does not contain it, and
    // the run died on a missing module. The deeper reason is the one that keeps this here —
    // measuring and recording an approval with code the change itself supplies would let a branch
    // decide what its own approval says.
    for (const job of [prepare, approve]) {
      const step = runOf(job, "Take the approval tooling from the default branch");
      expect(step).toContain('git checkout "origin/$DEFAULT_BRANCH" -- packages/rules/scripts');
    }
    // And it does not ride along into the pull request.
    expect(runOf(approve, "Push the approval commit")).toContain(
      "git restore --source=HEAD --staged --worktree -- packages/rules/scripts",
    );
  });

  it("fetches the default branch unshallowed, so the diff has a merge base", () => {
    // Found by the second run: `--depth=1` left the default branch with no history in common with
    // the pull request, and `git diff a...b` refused with `no merge base`.
    const step = runOf(prepare, "Take the approval tooling from the default branch");
    // The comment explains the choice, so match the command rather than the absence of a string.
    expect(step).toContain('git fetch --quiet origin "$DEFAULT_BRANCH"');
    expect(step).not.toMatch(/git fetch[^\n]*--depth=1/);
  });

  it("does not let an unavailable diff take the run with it", () => {
    // The summary informs a decision; the hashes and the corpus result are what bind it.
    expect(runOf(prepare, "Summarise the change")).toContain("diff unavailable");
  });

  it("takes the tooling before it installs or measures anything", () => {
    const names = prepare.steps.map((step) => step.name ?? step.uses ?? "");
    expect(names.indexOf("Take the approval tooling from the default branch")).toBeLessThan(
      names.indexOf("Measure what an approval would cover"),
    );
  });

  it("refuses a run only when nothing is prepared and the packet already agrees", () => {
    // "Nothing prepared" alone used to be the condition, and it refused the first run that was
    // genuinely needed: a change to how the digest is computed moves no review record. Both halves,
    // or a needed approval is unreachable.
    const step = runOf(prepare, "Refuse a run with nothing to approve");
    expect(step).toContain("agrees=\"$(jq -r '.agrees' facts.json)\"");
    expect(step).toContain('if [ "$count" -eq 0 ] && [ "$agrees" = "true" ]; then');
    expect(step).toContain("there is nothing here to approve");
  });

  it("lets a tooling change be approved only by an explicit, defaulted-off input", () => {
    // A pull request that changes the approval tooling cannot be approved by tooling that predates
    // it. The escape hatch is a named input rather than an unwritten habit of dispatching on the
    // branch's ref — where the branch would control the workflow definition too, invisibly.
    const dispatch = workflow.on.workflow_dispatch as {
      inputs: Record<string, { default: boolean; type: string }>;
    };
    const input = dispatch.inputs.approve_tooling_change;
    expect(input, "approve_tooling_change input").toBeDefined();
    expect(input.default).toBe(false);
    expect(input.type).toBe("boolean");

    for (const job of [prepare, approve]) {
      const step = runOf(job, "Take the approval tooling from the default branch");
      // And when it is used, the maintainer is shown exactly what they are trusting, in the summary
      // they are already reading when they decide.
      expect(step).toContain('if [ "$APPROVE_TOOLING_CHANGE" = "true" ]; then');
      expect(step).toContain('git diff "origin/$DEFAULT_BRANCH...HEAD" -- packages/rules/scripts');
      expect(step).toContain("$GITHUB_STEP_SUMMARY");
    }
  });

  it("does not merge anything", () => {
    // Approving and merging are separate decisions, and a workflow that did both would make the
    // second one invisible.
    expect(source).not.toMatch(/gh pr merge|--squash|--auto/);
    expect(runOf(approve, "Say what is left to do")).toContain("does not merge anything");
  });

  it("says that the pull request's checks will not re-run on their own", () => {
    // A `GITHUB_TOKEN` push deliberately triggers no workflow. Said in the summary rather than
    // discovered on a pull request whose checks look stale for no visible reason.
    expect(runOf(approve, "Say what is left to do")).toContain("does not");
    expect(runOf(approve, "Say what is left to do")).toContain("Re-run the pull request's checks");
  });

  it("pins every action to a commit SHA, like every other workflow here", () => {
    // Read from the source, not the parsed tree: the version comment is what makes a pinned SHA
    // reviewable, and parsing throws it away.
    const uses = source.split("\n").filter((line) => line.trim().startsWith("- uses:"));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line, line).toMatch(/@[0-9a-f]{40} # v/);
  });

  it("passes untrusted values through env rather than expanding them into a script", () => {
    // The pull request number and the default branch both reach a shell. Every occurrence is an
    // `env:` assignment, so neither is ever interpolated into a `run:` body.
    for (const line of source.split("\n")) {
      if (!line.includes("${{ inputs.") && !line.includes("repository.default_branch")) continue;
      expect(line, line).toMatch(/^\s+[A-Za-z_]+: \$\{\{ (inputs|github)\./);
    }
    expect(source).not.toMatch(/git (fetch|diff|push)[^\n]*\$\{\{/);
  });
});

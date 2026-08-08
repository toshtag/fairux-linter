import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Pins the two actions that issue #64 moved off Node 20, and the contracts the move had to leave
 * alone.
 *
 * A version comment is a note, not a runtime: `actions/download-artifact` v6 announced Node 24
 * support while its `action.yml` still declared `node20`. The SHAs below were taken from each
 * tag's dereferenced commit and each `action.yml` was read at that commit, so what this file
 * protects is that evidence — not the tag names, which can move.
 *
 * The workflow tree is walked rather than a known list of lines. A use added to a new workflow, or
 * a use of a target action that quietly disappears, both have to fail here; neither would show up
 * in a check that only revisited the places the pins are today.
 *
 * The publish privilege boundary is not re-asserted here. `publish-oidc-contract.test.ts` owns it,
 * and it reads the same two workflows.
 */

const root = resolve(import.meta.dirname, "../../..");
const workflowDir = resolve(root, ".github/workflows");

/** The approved Node 24 releases, by the commit each tag dereferences to. */
const APPROVED_PINS = {
  "pnpm/action-setup": { sha: "fc06bc1257f339d1d5d8b3a19a8cae5388b55320", version: "v5.0.0" },
  "actions/download-artifact": {
    sha: "37930b1c2abaa49bbe596cd826c3c89aef350131",
    version: "v7.0.0",
  },
} as const;

/** The Node 20 pins this change retired. Neither may come back, under any comment. */
const RETIRED_PINS = [
  "b906affcce14559ad1aafd4ab0e942779e9f58b1",
  "634f93cb2916e3fdff6788551b99b062d0335ce0",
] as const;

const TARGET_ACTIONS = Object.keys(APPROVED_PINS) as Array<keyof typeof APPROVED_PINS>;

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const workflowFiles = readdirSync(workflowDir)
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .sort();

const workflows = workflowFiles.map((file) => {
  const text = readFileSync(resolve(workflowDir, file), "utf8");
  return { file, text, parsed: parse(text) as Workflow };
});

interface Use {
  file: string;
  action: string;
  ref: string;
  comment: string | undefined;
}

/**
 * Every `uses:` in every workflow, read from the raw text because the version comment is the half
 * a reader checks and YAML parsing discards it.
 */
const uses: Use[] = workflows.flatMap(({ file, text }) =>
  [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+?)@(\S+)(?:\s+#\s*(.*?))?\s*$/gm)].map((match) => ({
    file,
    action: match[1] as string,
    ref: match[2] as string,
    comment: match[3],
  })),
);

const stepsOf = (job: Job | undefined) => job?.steps ?? [];
const allJobs = workflows.flatMap(({ file, parsed }) =>
  Object.entries(parsed.jobs).map(([name, job]) => ({ file, name, job })),
);
const stepsUsing = (action: string) =>
  allJobs.flatMap(({ file, name, job }) =>
    stepsOf(job)
      .filter((step) => step.uses?.startsWith(`${action}@`))
      .map((step) => ({ file, job: name, step })),
  );

describe("action runtime pins", () => {
  it("finds workflows to check at all", () => {
    // Without this, every assertion below passes vacuously if the directory is renamed or the read
    // returns nothing.
    expect(workflowFiles).toContain("ci.yml");
    expect(workflowFiles).toContain("publish-cli.yml");
    expect(workflowFiles).toContain("publish-sdk.yml");
    expect(uses.length).toBeGreaterThan(10);
  });

  it("pins every action by full commit SHA", () => {
    // A tag or a major alias is mutable: whatever it names today, the upstream owner can point it
    // somewhere else tomorrow without this repository changing.
    const floating = uses.filter((use) => !/^[0-9a-f]{40}$/.test(use.ref));
    expect(floating).toEqual([]);
  });

  it.each(TARGET_ACTIONS)("pins %s to the approved Node 24 release", (action) => {
    const approved = APPROVED_PINS[action];
    const found = uses.filter((use) => use.action === action);

    // An action that stops appearing is a failure too: it would mean the use moved somewhere this
    // contract no longer describes, and the remaining assertions would hold over nothing.
    expect(found.length).toBeGreaterThan(0);
    for (const use of found) {
      expect(use.ref, `${use.file}: ${action}`).toBe(approved.sha);
      expect(use.comment, `${use.file}: ${action}`).toBe(approved.version);
    }
  });

  it("keeps the retired Node 20 pins out of every workflow", () => {
    for (const { file, text } of workflows) {
      for (const sha of RETIRED_PINS) {
        expect(text, `${file} still pins ${sha}`).not.toContain(sha);
      }
    }
  });
});

/**
 * The half of the pin policy a pin cannot provide.
 *
 * Pinning to a commit means the tree a workflow runs never changes — including when the tag it came
 * from moves to fix something. So the policy needs a second half: something that proposes the next
 * commit on a schedule. That is Dependabot, and what matters here is that it cannot be the thing
 * that loosens the pin it is updating.
 *
 * It cannot, and not because of its own configuration: the assertions above walk every workflow and
 * fail a ref that is not forty hex characters, whoever opened the pull request. This checks that
 * both ecosystems are actually covered, and that nothing here merges without a person.
 */
describe("dependency update contract", () => {
  interface Ecosystem {
    "package-ecosystem": string;
    schedule?: { interval?: string };
    "open-pull-requests-limit"?: number;
    groups?: Record<string, { patterns?: string[]; "update-types"?: string[] }>;
    ignore?: { "dependency-name": string; "update-types"?: string[] }[];
  }
  const dependabot = parse(readFileSync(resolve(root, ".github/dependabot.yml"), "utf8")) as {
    version: number;
    updates: Ecosystem[];
  };
  const ecosystem = (name: string) =>
    dependabot.updates.find((entry) => entry["package-ecosystem"] === name);

  it("covers both ecosystems this repository has, at a cadence its size earns", () => {
    expect(dependabot.version).toBe(2);
    expect(dependabot.updates.map((entry) => entry["package-ecosystem"]).sort()).toEqual([
      "github-actions",
      "npm",
    ]);
    for (const entry of dependabot.updates) {
      expect(entry.schedule?.interval, entry["package-ecosystem"]).toBe("monthly");
      // A limit that lets a routine group pull request starve the major beside it would defeat the
      // grouping change below; a limit of one would do exactly that.
      expect(entry["open-pull-requests-limit"], entry["package-ecosystem"]).toBeGreaterThan(1);
      expect(entry["open-pull-requests-limit"], entry["package-ecosystem"]).toBeLessThanOrEqual(3);
    }
  });

  it("groups only what a reviewer can answer yes to in one pass", () => {
    // The defect this replaced: every Action update in one pull request meant an `actions/checkout`
    // patch arrived hostage to two majors, one of which announces breaking changes in its own
    // release notes. A major's answer is a conversation, and a conversation needs its own diff.
    for (const entry of dependabot.updates) {
      const groups = Object.entries(entry.groups ?? {});
      expect(groups.length, entry["package-ecosystem"]).toBeGreaterThan(0);
      for (const [name, group] of groups) {
        expect(group["update-types"], `${entry["package-ecosystem"]}/${name}`).toEqual([
          "minor",
          "patch",
        ]);
      }
    }
  });

  it("does not propose a @types/node major, which the Node floor already refuses", () => {
    // `node-contract.test.ts` is what defends the floor; this is what stops the same refused pull
    // request arriving every cycle until somebody stops reading them. Majors only — a minor or a
    // patch still arrives.
    const ignored = ecosystem("npm")?.ignore ?? [];
    const types = ignored.find((entry) => entry["dependency-name"] === "@types/node");
    expect(types?.["update-types"]).toEqual(["version-update:semver-major"]);

    // And the floor it is protecting is the one the manifest actually declares, read rather than
    // restated: an ignore rule pinned to a major nobody supports any more would be worse than none.
    const root_ = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
      engines: { node: string };
    };
    const typesMajor = /(\d+)/.exec(root_.devDependencies["@types/node"] ?? "")?.[1];
    const nodeFloorMajor = /(\d+)/.exec(root_.engines.node)?.[1];
    expect(typesMajor, "@types/node should track the supported Node floor").toBe(nodeFloorMajor);
  });

  it("leaves the merge to a person, and gives its pull requests no privilege", () => {
    // An update that merged itself would be a commit nobody read changing what every workflow
    // executes. `pull_request_target` is the other way that happens without anyone deciding to: it
    // runs the base branch's workflow with a writable token on a pull request from a branch the
    // author controls.
    for (const { file, text, parsed } of workflows) {
      const runs = Object.values(parsed.jobs)
        .flatMap((job) => stepsOf(job))
        .map((step) => step.run ?? "")
        .join("\n");
      expect(runs, `${file} must not merge a dependency update`).not.toMatch(/gh pr merge/);
      expect(text, `${file} must not run on pull_request_target`).not.toMatch(
        /^\s*pull_request_target:/m,
      );
    }
  });
});

describe("pnpm selection contract", () => {
  it("leaves the root manifest as the only authority on the pnpm version", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(manifest.packageManager).toBe("pnpm@10.33.2");
  });

  it("passes pnpm/action-setup no inputs at all", () => {
    // `version` would move the decision into the workflow; `run_install` and `cache` would change
    // what the step does beyond installing pnpm. The repository has always relied on
    // `packageManager` and on `actions/setup-node`'s own `cache: pnpm`.
    const steps = stepsUsing("pnpm/action-setup");
    expect(steps.length).toBeGreaterThan(0);
    for (const { file, job, step } of steps) {
      expect(step.with, `${file}/${job}`).toBeUndefined();
    }
  });

  it("asserts the selected pnpm version on Linux and on Windows before installing", () => {
    const jobsToCheck = [
      { file: "ci.yml", job: "verify" },
      { file: "release-contract.yml", job: "config-windows" },
      { file: "release-contract.yml", job: "pack-smoke-windows" },
    ];
    for (const { file, job: jobName } of jobsToCheck) {
      const { parsed } = workflows.find((workflow) => workflow.file === file) ?? {};
      const steps = stepsOf(parsed?.jobs[jobName]);
      const check = steps.findIndex((step) =>
        step.run?.includes("scripts/check-pnpm-selection.mjs"),
      );
      const install = steps.findIndex((step) => step.run?.includes("pnpm install"));
      // After the install, the lockfile has already been resolved by whichever pnpm was selected,
      // so the assertion would only be reporting what it failed to prevent.
      expect(check, `${jobName} must assert the pnpm version`).toBeGreaterThanOrEqual(0);
      expect(install).toBeGreaterThan(check);
    }
  });
});

describe("artifact handoff contract", () => {
  /** Each download in the tree, with the name and destination it must keep. */
  const HANDOFFS = [
    { file: "publish-cli.yml", name: "fairux-tarball", path: "${{ runner.temp }}/bundle" },
    { file: "publish-sdk.yml", name: "fairux-sdk-tarball", path: "${{ runner.temp }}/bundle" },
  ] as const;

  it("downloads exactly the artifacts this repository uploads, and nowhere else", () => {
    const downloads = stepsUsing("actions/download-artifact");
    expect(downloads.map((download) => download.file).sort()).toEqual(
      HANDOFFS.map((handoff) => handoff.file).sort(),
    );
  });

  it.each(HANDOFFS)("keeps $file's artifact name and destination", ({ file, name, path }) => {
    const workflow = workflows.find((candidate) => candidate.file === file);
    const download = stepsUsing("actions/download-artifact").find((step) => step.file === file);
    const uploadNames = Object.values(workflow?.parsed.jobs ?? {})
      .flatMap((job) => stepsOf(job))
      .filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
      .map((step) => step.with?.name);

    expect(download?.step.with?.name).toBe(name);
    expect(download?.step.with?.path).toBe(path);
    // A rename on one side only would leave the download waiting for an artifact nothing produces.
    expect(uploadNames).toContain(name);

    // `github-token`, `repository`, and `run-id` would reach outside this run; `pattern`,
    // `merge-multiple`, and `artifact-ids` would change what lands at the destination the
    // downstream steps read.
    expect(Object.keys(download?.step.with ?? {}).sort()).toEqual(["name", "path"]);
  });
});

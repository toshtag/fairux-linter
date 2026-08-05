import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * `publish-sdk.yml`'s structure, over the parsed document.
 *
 * These five facts used to be asserted by `release-check.mjs` searching this file's text. Every one
 * of those searches was measured against the workflow it guards, and four of them passed a
 * mutation that would have changed what the release did:
 *
 *   the trigger moved to `other-v*` with `"sdk-v*"` left in a comment
 *   the trigger moved under a `workflow_dispatch` input default
 *   `packages/sdk/package.json` dropped from the command and written in a comment
 *   `--ignore-scripts` deleted from the publish command and written in a comment below it
 *
 * and two of them rejected a comment that was simply explaining the rule:
 *
 *   a comment saying the workflow does not read `apps/cli/package.json`
 *   a comment saying `setup-node` is deliberately given no `registry-url`
 *
 * A parsed document has no comments in it, which is what makes both classes go away at once. What
 * a parser cannot establish — that the job *ran* on the right ref — is not attempted here; it is
 * `validateSdkReleaseRuntimeContext`, checked in the job itself. That split matters because no test
 * in this file runs at release time: `ci.yml` triggers on pushes to `main` and on pull requests, so
 * a tag push runs no test suite at all.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const text = readFileSync(resolve(root, ".github/workflows/publish-sdk.yml"), "utf8");

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}
interface Job {
  steps?: Step[];
  permissions?: Record<string, string>;
}
interface Workflow {
  on?: unknown;
  jobs: Record<string, Job>;
}

const workflow = parse(text) as Workflow;
const jobs = Object.entries(workflow.jobs);
const allSteps = jobs.flatMap(([name, job]) => (job.steps ?? []).map((step) => ({ name, step })));
const publishSteps = workflow.jobs.publish?.steps ?? [];
const PUBLISH_SCRIPT = "packages/sdk/scripts/publish-sdk.mjs";

/** Every executable line in the workflow — `run:` bodies only, so comments are not evidence. */
const executable = allSteps.map(({ step }) => step.run ?? "").join("\n");

describe("W1 — the SDK publishes on one trigger", () => {
  it("is triggered by sdk-v* tag pushes and nothing else", () => {
    // Exact, not `toContain`: an added `workflow_dispatch`, an added branch, or a second tag
    // pattern each fail here. The old check asked whether the string `"sdk-v*"` appeared anywhere
    // in the file, which a comment satisfied.
    expect(workflow.on).toEqual({ push: { tags: ["sdk-v*"] } });
  });

  it("has a runtime guard that does not depend on this test having run", () => {
    // The workflow's shape is pinned above; what it was actually invoked with is pinned in the job.
    // Both, because a tag can be pushed at any commit and no test suite runs on a tag push.
    expect(executable).toContain("release-check.mjs");

    // Run it, rather than look for the call. Searching the source for
    // `validateSdkReleaseRuntimeContextFromEnv` passed with the call deleted — the import line
    // still carried the name. That is the same shape of mistake this whole branch is removing.
    const version = (
      JSON.parse(readFileSync(resolve(root, "packages/sdk/package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    const tag = `sdk-v${version}`;
    const context = {
      GITHUB_ACTIONS: "true",
      GITHUB_REF: `refs/tags/${tag}`,
      GITHUB_REF_NAME: tag,
      GITHUB_REF_TYPE: "tag",
    };
    const check = (env: Record<string, string>) =>
      spawnSync("node", ["packages/sdk/scripts/release-check.mjs", "--tag", tag], {
        cwd: root,
        encoding: "utf8",
        // No TARBALL and no FAIRUX_RELEASE_CHECK_NPM: nothing here unpacks an archive or reaches
        // the network. Only the checkout's own files are read.
        env: { ...process.env, TARBALL: "", FAIRUX_RELEASE_CHECK_NPM: "", ...env },
      });

    const dispatched = check({ ...context, GITHUB_EVENT_NAME: "workflow_dispatch" });
    expect(dispatched.status, "a manual dispatch must not pass the release check").not.toBe(0);
    // `bad()` writes to stderr; only `ok()` goes to stdout.
    expect(dispatched.stderr).toContain("push event only");

    expect(check({ ...context, GITHUB_EVENT_NAME: "push" }).status).toBe(0);
  });
});

describe("W2/W3 — which manifest the release is about", () => {
  it("names the SDK manifest where it hands one to a script", () => {
    expect(executable).toContain("packages/sdk/package.json");
  });

  it("never reads the CLI manifest in anything that executes", () => {
    // `run:` bodies only. The file may say `apps/cli/package.json` in a comment explaining that it
    // does not read it — which the old whole-file search rejected.
    expect(executable).not.toContain("apps/cli/package.json");
  });

  it("lets comments mention the CLI manifest", () => {
    // Not a tautology: it fails if this assertion is ever rewritten against the raw text.
    const commentary = text
      .split("\n")
      .filter((line) => line.trim().startsWith("#"))
      .join("\n");
    expect(() => parse(text)).not.toThrow();
    expect(`${commentary}\n# apps/cli/package.json is not read here`).toContain(
      "apps/cli/package.json",
    );
    expect(executable).not.toContain("apps/cli/package.json");
  });
});

describe("W4 — one owner for the publication", () => {
  it("publishes by calling the script, exactly once", () => {
    const calls = publishSteps.filter((step) => step.run?.includes(PUBLISH_SCRIPT));
    expect(calls).toHaveLength(1);
  });

  it("runs no raw npm publish anywhere in the workflow", () => {
    // The flags are the script's, and its tests assert the exact argv. A second, hand-written
    // `npm publish` would be a second set of flags that nothing checks.
    expect(executable).not.toMatch(/\bnpm\s+publish\b/);
  });

  it("leaves the skip decision to the script rather than a step condition", () => {
    // `if: env.PUBLISH_NEEDED == 'true'` on the publish step would be a branch no unit test can
    // reach. The script reads `PUBLISH_NEEDED`, so both paths are testable.
    const publish = publishSteps.find((step) => step.run?.includes(PUBLISH_SCRIPT));
    expect(publish?.if).toBeUndefined();
  });

  it("publishes immediately after the last credential preflight", () => {
    const preflight = publishSteps.findLastIndex((step) =>
      step.run?.includes("check-trusted-publishing.mjs"),
    );
    const publish = publishSteps.findIndex((step) => step.run?.includes(PUBLISH_SCRIPT));
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(publish - preflight).toBe(1);
  });

  it("verifies the registry digest after publishing", () => {
    const publish = publishSteps.findIndex((step) => step.run?.includes(PUBLISH_SCRIPT));
    const verify = publishSteps.findIndex((step) => step.run?.includes("--require-present"));
    expect(verify).toBeGreaterThan(publish);
  });

  it("installs nothing in the privileged job", () => {
    // The script is dependency-free for this reason. An install here would run third-party
    // lifecycle code in the job that holds `id-token: write`.
    const runs = publishSteps.map((step) => step.run ?? "").join("\n");
    expect(runs).not.toMatch(/pnpm install|npm ci|npm install|yarn install/);
    expect(workflow.jobs.publish?.permissions?.["id-token"]).toBe("write");
  });
});

describe("W5 — nothing suppresses the OIDC exchange", () => {
  it("gives setup-node no registry-url, in any job", () => {
    // `actions/setup-node` with `registry-url` writes an unresolved ${NODE_AUTH_TOKEN} placeholder,
    // which suppressed the OIDC exchange and burned the sdk-v0.1.0-beta.1 tag (run 30233771956).
    for (const { name, step } of allSteps) {
      if (step.uses?.startsWith("actions/setup-node@")) {
        expect(step.with?.["registry-url"], `${name} must not set registry-url`).toBeUndefined();
      }
    }
  });

  it("lets comments mention registry-url", () => {
    // The whole-file regex `!/registry-url:/` rejected exactly this sentence.
    const withComment = `${text}\n# setup-node is deliberately given no registry-url: here\n`;
    const reparsed = parse(withComment) as Workflow;
    for (const job of Object.values(reparsed.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/setup-node@")) {
          expect(step.with?.["registry-url"]).toBeUndefined();
        }
      }
    }
  });

  it("supplies no static npm credential in any executable step", () => {
    for (const { name, step } of allSteps) {
      for (const key of Object.keys(step.env ?? {})) {
        expect(key, `${name} must not set ${key}`).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN/);
      }
    }
    expect(text).not.toMatch(/secrets\.[A-Za-z_]*(NPM|TOKEN|npm|token)/);
  });
});

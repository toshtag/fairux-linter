import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Pins the publish workflows to the configuration that lets npm Trusted Publishing work, and to
 * the privilege boundary that keeps package lifecycle code away from the OIDC token.
 *
 * The SDK's first release attempt (run 30233771956) burned the `sdk-v0.1.0-beta.1` tag: it packed,
 * smoke-tested, audited, and signed provenance for a tarball, then got `E404` from the registry
 * `PUT`. `actions/setup-node` had been given `registry-url`, which writes an unresolved
 * `${NODE_AUTH_TOKEN}` placeholder into the npm user config; npm read that as a credential and
 * never attempted the OIDC exchange.
 *
 * These assertions do not save the version number — the workflows are tag-triggered, so the tag
 * exists before any step runs — they save the wasted build and the doomed registry attempt, and
 * they keep `pnpm install` out of the job that can mint a token.
 */

const root = resolve(import.meta.dirname, "../../..");

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
interface Job {
  environment?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const readWorkflow = (file: string): { text: string; parsed: Workflow } => {
  const text = readFileSync(resolve(root, ".github/workflows", file), "utf8");
  return { text, parsed: parse(text) as Workflow };
};

const runsOf = (job: Job | undefined) =>
  (job?.steps ?? []).map((step) => step.run ?? "").join("\n");

const PUBLISH_WORKFLOWS = ["publish-sdk.yml", "publish-cli.yml"] as const;

describe.each(PUBLISH_WORKFLOWS)("%s", (file) => {
  const { text, parsed } = readWorkflow(file);
  const publish = parsed.jobs.publish;
  const steps = publish?.steps ?? [];
  const publishCommand = steps
    .map((step) => step.run ?? "")
    .find((run) => run.includes("npm publish"));

  it("keeps OIDC and write access on the publish job only", () => {
    expect(parsed.permissions?.contents).toBe("read");
    expect(parsed.permissions?.["id-token"]).toBeUndefined();
    expect(publish?.permissions?.["id-token"]).toBe("write");
    expect(publish?.environment).toBe("publish");

    for (const [name, job] of Object.entries(parsed.jobs)) {
      if (name === "publish") continue;
      expect(job.permissions?.["id-token"], `${name} must not mint an OIDC token`).toBeUndefined();
      expect(job.permissions?.contents, `${name} must stay read-only`).toBe("read");
    }
  });

  it("runs no install, build, or package lifecycle in the privileged job", () => {
    // A dependency or prepack script running here could mint an OIDC token and publish on its own;
    // a final credential check cannot undo what already happened.
    const runs = runsOf(publish);
    for (const forbidden of ["pnpm install", "npm install", "pnpm pack", "npm pack", "prepack"]) {
      expect(runs, `${file} publish job`).not.toContain(forbidden);
    }
  });

  it("prepares the artifact in an unprivileged job and hands it over", () => {
    const prepare = parsed.jobs.prepare;
    expect(prepare?.permissions?.contents).toBe("read");
    expect(prepare?.permissions?.["id-token"]).toBeUndefined();
    expect(prepare?.environment).toBeUndefined();
    expect(runsOf(prepare)).toContain("pnpm install --frozen-lockfile");
    expect(runsOf(prepare)).toContain("pack --pack-destination");

    expect(
      (prepare?.steps ?? []).some((step) => step.uses?.startsWith("actions/upload-artifact@")),
    ).toBe(true);
    expect(steps.some((step) => step.uses?.startsWith("actions/download-artifact@"))).toBe(true);
  });

  it("re-derives the bundle's identity before trusting it", () => {
    const runs = runsOf(publish);
    expect(runs).toContain("verify-release-bundle.mjs");
    expect(runs).toContain("--kind");
    expect(runs).toContain("--commit");
    expect(runs).toContain("--tag");
    expect(runs).toContain("--github-env");
  });

  it("never evaluates anything the bundle produced", () => {
    // The verifier used to print `export KEY='value'` and this job ran `eval` on it. A crafted
    // `distTag` in the bundle then executed in the job holding id-token: write.
    expect(text).not.toMatch(/eval\s+"\$\(/);
    expect(text).not.toContain("eval ");
  });

  it("audits the tarball's contents with the checkout's own auditor, then re-checks the digest", () => {
    const steps = publish?.steps ?? [];
    const verify = steps.findIndex((step) => step.run?.includes("verify-release-bundle.mjs"));
    const audit = steps.findIndex((step) => step.name?.startsWith("Audit tarball contents"));
    const recheck = steps.findIndex((step) => step.name?.startsWith("Re-verify tarball digest"));
    const publishIndex = steps.findIndex((step) => step.run?.includes("npm publish"));

    // Matching digests only prove the bundle is self-consistent; the contents still need auditing
    // by code that did not travel with them.
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(audit).toBeGreaterThan(verify);
    expect(recheck).toBeGreaterThan(audit);
    expect(publishIndex).toBeGreaterThan(recheck);
  });

  it("names one checksum file, shared by both workflows", () => {
    expect(text).toContain("release-sha256.txt");
    expect(text).not.toContain("fairux-sdk-sha256.txt");
    expect(text).not.toContain("tarball-sha256.txt");
  });

  it("validates the tag before any job installs anything", () => {
    const validate = parsed.jobs.validate;
    expect(validate?.permissions?.contents).toBe("read");
    expect(runsOf(validate)).not.toContain("pnpm install");
    expect(parsed.jobs.prepare?.needs).toBe("validate");
    expect(publish?.needs).toContain("validate");
    expect(publish?.needs).toContain("prepare");
  });

  it("gives setup-node no registry-url, anywhere", () => {
    for (const job of Object.values(parsed.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/setup-node@")) {
          expect(step.with?.["registry-url"]).toBeUndefined();
        }
      }
    }
  });

  it("names the registry on the publish command", () => {
    expect(publishCommand).toContain("--registry=https://registry.npmjs.org/");
  });

  it("supplies no static npm credential", () => {
    // Structure, not raw text: both workflows name these variables in comments explaining why
    // they are absent.
    for (const job of Object.values(parsed.jobs)) {
      for (const step of job.steps ?? []) {
        for (const name of Object.keys(step.env ?? {})) {
          expect(name).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN/);
        }
      }
    }
    expect(text).not.toMatch(/secrets\.[A-Za-z_]*(NPM|TOKEN|npm|token)/);
  });

  it("verifies the preconditions immediately before publishing", () => {
    const checkIndex = steps.findLastIndex((step) =>
      step.run?.includes("check-trusted-publishing.mjs"),
    );
    const publishIndex = steps.findIndex((step) => step.run?.includes("npm publish"));
    expect(checkIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex - checkIndex).toBe(1);
  });

  it("publishes with provenance, without scripts, from the packed tarball", () => {
    expect(publishCommand).toContain("--provenance");
    expect(publishCommand).toContain("--ignore-scripts");
    expect(publishCommand).toContain('"$TARBALL"');
  });
});

describe("publish-sdk.yml specifics", () => {
  const { text, parsed } = readWorkflow("publish-sdk.yml");
  const publish = parsed.jobs.publish;
  const publishCommand = (publish?.steps ?? [])
    .map((step) => step.run ?? "")
    .find((run) => run.includes("npm publish"));

  it("publishes the SDK publicly on the next dist-tag and refuses stable versions", () => {
    expect(publishCommand).toContain("--access public");
    // The dist-tag is fixed where the bundle is built and carried in its metadata; the publish job
    // takes it from the verified bundle rather than deciding it while holding the token.
    expect(runsOf(parsed.jobs.prepare)).toContain('distTag: "next"');
    expect(publishCommand).toContain('--tag "$DIST_TAG"');
    expect(runsOf(parsed.jobs.validate)).toContain("beta-only");
  });

  it("needs the smoke matrix as well as prepare", () => {
    expect(parsed.jobs["sdk-smoke"]?.needs).toBe("validate");
    expect(publish?.needs).toContain("sdk-smoke");
  });

  it("holds contents: write only because it creates the GitHub Release", () => {
    expect(publish?.permissions?.contents).toBe("write");
    expect(runsOf(publish)).toContain("gh release");
  });

  it("attaches release assets from the verified bundle directory", () => {
    // The checksum was uploaded into `$RUNNER_TEMP/bundle/` but attached from `$RUNNER_TEMP/`,
    // so the Release step would have failed with ENOENT *after* npm publish succeeded.
    const release = runsOf(publish);
    expect(release).toContain('"$RUNNER_TEMP/bundle/release-sha256.txt"');
    expect(release).toContain('"$RUNNER_TEMP/bundle/sdk-release-notes.md"');
    expect(release).not.toMatch(/"\$RUNNER_TEMP\/release-sha256\.txt"/);
  });
});

describe("publish-cli.yml specifics", () => {
  const { parsed } = readWorkflow("publish-cli.yml");
  const publish = parsed.jobs.publish;

  it("stays read-only on contents, creating no GitHub Release", () => {
    expect(publish?.permissions?.contents).toBe("read");
    expect(runsOf(publish)).not.toContain("gh release");
  });
});

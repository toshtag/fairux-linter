import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Pins the publish jobs to the configuration that lets npm Trusted Publishing work.
 *
 * The SDK's first release attempt (run 30233771956) burned the `sdk-v0.1.0-beta.1` tag: it packed,
 * smoke-tested, audited, and signed provenance for a tarball, then got `E404` from the registry
 * `PUT`. `actions/setup-node` had been given `registry-url`, which writes an unresolved
 * `${NODE_AUTH_TOKEN}` placeholder into the npm user config; npm read that as a credential and
 * never attempted the OIDC exchange.
 *
 * A tag cannot be moved, so a regression here costs a version number. These assertions make the
 * regression fail in CI instead.
 */

const root = resolve(import.meta.dirname, "../../..");

interface Job {
  environment?: string;
  permissions?: Record<string, string>;
  steps?: Array<{ name?: string; run?: string; uses?: string; with?: Record<string, unknown> }>;
}
interface Workflow {
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const readWorkflow = (file: string): { text: string; parsed: Workflow } => {
  const text = readFileSync(resolve(root, ".github/workflows", file), "utf8");
  return { text, parsed: parse(text) as Workflow };
};

const PUBLISH_WORKFLOWS = [
  ["publish-sdk.yml", "@fairux/sdk"],
  ["publish-cli.yml", "fairux"],
] as const;

describe.each(PUBLISH_WORKFLOWS)("%s publish job", (file) => {
  const { text, parsed } = readWorkflow(file);
  const publish = parsed.jobs.publish;
  const steps = publish?.steps ?? [];
  const setupNode = steps.filter((step) => step.uses?.startsWith("actions/setup-node@"));
  const publishCommand = steps
    .map((step) => step.run ?? "")
    .find((run) => run.includes("npm publish"));

  it("requests an OIDC token and runs behind the publish environment", () => {
    expect(parsed.permissions?.["id-token"]).toBe("write");
    expect(publish?.environment).toBe("publish");
  });

  it("gives setup-node no registry-url", () => {
    // The single line that caused run 30233771956. `with.registry-url` makes setup-node write
    // `_authToken=${NODE_AUTH_TOKEN}`, which suppresses OIDC.
    expect(setupNode.length).toBeGreaterThan(0);
    for (const step of setupNode) {
      expect(step.with?.["registry-url"]).toBeUndefined();
    }
  });

  it("names the registry on the publish command instead", () => {
    expect(publishCommand).toBeDefined();
    expect(publishCommand).toContain("--registry=https://registry.npmjs.org/");
  });

  it("supplies no static npm credential", () => {
    // Assert on structure, not on the word appearing anywhere: both workflows mention
    // NODE_AUTH_TOKEN and NPM_TOKEN in comments explaining precisely why they are absent.
    for (const step of steps) {
      for (const name of Object.keys((step as { env?: Record<string, unknown> }).env ?? {})) {
        expect(name, `${file} step env`).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN/);
      }
    }
    expect(text).not.toMatch(/secrets\.[A-Za-z_]*(NPM|TOKEN|npm|token)/);
  });

  it("verifies the Trusted Publishing preconditions before doing any work", () => {
    const check = steps.findIndex((step) => step.run?.includes("check-trusted-publishing.mjs"));
    const pack = steps.findIndex((step) => step.run?.includes("pack --pack-destination"));
    expect(check).toBeGreaterThanOrEqual(0);
    expect(pack).toBeGreaterThanOrEqual(0);
    // Fail before building the artifact, not after the registry refuses it.
    expect(check).toBeLessThan(pack);
  });

  it("publishes with provenance and without running package scripts", () => {
    expect(publishCommand).toContain("--provenance");
    expect(publishCommand).toContain("--ignore-scripts");
  });

  it("publishes the one tarball it packed", () => {
    expect(publishCommand).toContain('"$TARBALL"');
  });
});

describe("publish-sdk.yml specifics", () => {
  const { text, parsed } = readWorkflow("publish-sdk.yml");
  const steps = parsed.jobs.publish?.steps ?? [];
  const publishCommand = steps
    .map((step) => step.run ?? "")
    .find((run) => run.includes("npm publish"));

  it("publishes the SDK publicly", () => {
    expect(publishCommand).toContain("--access public");
  });

  it("keeps prereleases on the next dist-tag and refuses stable versions", () => {
    expect(text).toContain("DIST_TAG=next");
    expect(text).toContain("beta-only");
  });

  it("drops registry-url from the smoke job too, which never publishes", () => {
    const smokeSetup = (parsed.jobs["sdk-smoke"]?.steps ?? []).filter((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );
    expect(smokeSetup.length).toBeGreaterThan(0);
    for (const step of smokeSetup) expect(step.with?.["registry-url"]).toBeUndefined();
  });
});

describe("no workflow reintroduces registry-url", () => {
  it.each(["publish-sdk.yml", "publish-cli.yml", "ci.yml"])("%s", (file) => {
    const { parsed } = readWorkflow(file);
    for (const job of Object.values(parsed.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/setup-node@")) {
          expect(step.with?.["registry-url"]).toBeUndefined();
        }
      }
    }
  });
});

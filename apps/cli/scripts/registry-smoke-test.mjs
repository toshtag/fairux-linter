#!/usr/bin/env node
/**
 * Install the published `fairux` CLI from the public registry and run the installed-CLI contract
 * against it.
 *
 * The packed smoke already proves that a locally packed tarball installs and behaves. That is a
 * different artifact with a different provenance: it never went through npm's publish pipeline, was
 * never stored or served by the registry, and carries no dist-tag. "These bytes install and run" is
 * not "the bytes npm serves install and run", and only the second one is a statement about a
 * release.
 *
 * So the difference between this file and `pack-smoke-test.mjs` is provenance and nothing else. The
 * behaviour contract is `installed-cli-smoke-contract.mjs`, called unchanged by both — a
 * registry-only variant would be a second contract that drifts from the first, and the drift would
 * be invisible precisely because each path would keep passing its own copy.
 *
 * Deliberately out of scope: packing, the tarball's structure, dist-tags, tags, and Releases. This
 * starts at "npm serves this exact version" and ends at "the CLI it installs behaves".
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NPM_CLI_INSTALL_REGISTRY_ARGS,
  PUBLIC_NPM_REGISTRY,
} from "../../../scripts/public-npm-registry.mjs";
import { runCommand } from "../../../scripts/run-command.mjs";
import { installedCliBinPath, runInstalledCliSmoke } from "./installed-cli-smoke-contract.mjs";
import { getNpmRegistryState } from "./npm-registry-state.mjs";

const TIMEOUT = 120_000;

/**
 * The exact `npm install` arguments this smoke uses.
 *
 * Exported so a unit test can pin them without a network call: whether the install is pinned to the
 * public registry is the one property of this file that cannot be observed from a green run — a run
 * that installed from the wrong host would be just as green, and just as meaningless.
 *
 * @param {string} spec  `fairux@<version>`
 * @returns {string[]}
 */
export function registrySmokeInstallArgs(spec) {
  return ["install", spec, "--no-audit", "--no-fund", ...NPM_CLI_INSTALL_REGISTRY_ARGS];
}

/**
 * Why a registry state cannot be smoked, or `null` when it can.
 *
 * Read before the install rather than after it. `npm install` answers a missing package with a 404
 * buried in its own error output, which reads as "the smoke is broken" — where the true state,
 * until the first beta ships, is "`fairux` is not published yet". A reader of a red canary has to
 * be able to tell those apart at a glance, and `absent` and `unavailable` are different answers:
 * one is a fact about the release, the other is a fact about the read.
 *
 * @param {string} spec
 * @param {{status: string, reason?: string}} state
 * @returns {string | null}
 */
export function unsmokableRegistryState(spec, state) {
  if (state.status === "present") return null;
  if (state.status === "absent") {
    return `${spec} is not on ${PUBLIC_NPM_REGISTRY} — nothing to smoke. The CLI has not been published.`;
  }
  return `${PUBLIC_NPM_REGISTRY} could not be read for ${spec}: ${state.reason}`;
}

/**
 * Why an installed version is not the one this run is evidence about, or `null` when it is.
 *
 * The installed manifest is the subject, not the spec that was asked for. A dist-tag that moved
 * between the resolve step and this install would otherwise let the run pass under the resolved
 * version's name while exercising a different one — which is the one way a green canary can lie.
 *
 * @param {{installed: unknown, expected: string}} input
 * @returns {string | null}
 */
export function installedVersionMismatch({ installed, expected }) {
  if (installed === expected) return null;
  return (
    `installed fairux is ${String(installed)}, expected ${expected} — ` +
    "the registry served a different version than the one resolved"
  );
}

/** What `npm audit signatures --json --include-attestations` reports, as far as this file cares. */
const SLSA_PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";

/**
 * What a signature audit of the installed tree says about the published CLI, as failures.
 *
 * The publish workflow reads back that npm *reports* attestation metadata for the version it just
 * published. That is a claim about a registry API response, made by the process that wrote it. This
 * is the independent half the release runbook delegates here: a clean install, audited from the
 * outside, verifying the signature and the provenance attestation against the registry's own keys.
 *
 * Only `fairux` is held to the provenance standard. `verified` lists packages that carry
 * attestations, which most of the dependency tree does not, and failing on that would be failing on
 * other maintainers' publish choices. An *invalid* signature anywhere is different: that is a
 * tampered artifact in the tree this CLI runs from.
 *
 * @param {{report: unknown, packageName: string, expectedVersion: string, registry: string}} input
 * @returns {string[]} failures; empty means the audit supports the release
 */
export function signatureAuditFailures({ report, packageName, expectedVersion, registry }) {
  const failures = [];
  const audit = /** @type {Record<string, unknown[]>} */ (report ?? {});
  const list = (key) => (Array.isArray(audit[key]) ? audit[key] : []);

  if (list("invalid").length > 0) {
    const names = list("invalid").map((entry) => `${entry?.name}@${entry?.version}`);
    failures.push(`npm audit signatures reports invalid signatures: ${names.join(", ")}`);
  }

  const missing = list("missing").find((entry) => entry?.name === packageName);
  if (missing) failures.push(`${packageName} has no registry signature`);

  const verified = list("verified").find((entry) => entry?.name === packageName);
  if (!verified) {
    failures.push(
      `${packageName} carries no verified attestation — the published CLI must have provenance`,
    );
    return failures;
  }
  if (verified.version !== expectedVersion) {
    failures.push(`the audited ${packageName} is ${verified.version}, expected ${expectedVersion}`);
  }
  if (verified.registry !== registry) {
    failures.push(`${packageName} was verified against ${verified.registry}, expected ${registry}`);
  }
  if (verified.attestations?.provenance?.predicateType !== SLSA_PROVENANCE_PREDICATE) {
    failures.push(
      `${packageName} carries no SLSA provenance predicate (${verified.attestations?.provenance?.predicateType})`,
    );
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const spec = process.env.CLI_SPEC;
  const expectedVersion = process.env.EXPECTED_VERSION;
  if (!spec || !expectedVersion) {
    console.error(
      "Usage: CLI_SPEC=fairux@<version> EXPECTED_VERSION=<version> pnpm registry:smoke:cli",
    );
    process.exit(2);
  }

  // What a canary run must be readable from its log alone: which registry was asked, for what,
  // expecting what, on which runtime and platform. A green run whose log does not say where it
  // installed from is not evidence about a release.
  console.log(`registry=${PUBLIC_NPM_REGISTRY}`);
  console.log(`spec=${spec}`);
  console.log(`expectedVersion=${expectedVersion}`);
  console.log(`node=${process.version}`);
  console.log(`platform=${process.platform}`);

  const work = mkdtempSync(join(tmpdir(), "fairux-cli-registry-smoke-"));
  let failed = false;
  const ok = (m) => console.log(`✓ ${m}`);
  const bad = (m) => {
    console.error(`✗ ${m}`);
    failed = true;
  };

  try {
    // A cache private to this run. npm's shared cache can serve a tarball it fetched earlier, and a
    // cached artifact is not evidence about what the registry serves now — which is the question.
    //
    // The whole inherited environment goes with it, deliberately: `runCommand` treats `env` as the
    // environment the child actually gets *and* resolves the command against that same environment,
    // so handing it the cache override alone would leave `npm` unfindable on an empty `PATH`.
    const env = { ...process.env, npm_config_cache: join(work, ".npm-cache") };
    const run = (cmd, args) => runCommand(cmd, args, { cwd: work, env, timeout: TIMEOUT }).stdout;

    const state = getNpmRegistryState(spec);
    const unsmokable = unsmokableRegistryState(spec, state);
    if (unsmokable) throw new Error(unsmokable);
    ok(`registry serves ${spec} (${state.integrity})`);

    run("npm", ["init", "-y"]);
    run("npm", registrySmokeInstallArgs(spec));
    ok(`installed ${spec} from ${PUBLIC_NPM_REGISTRY} into a clean project`);

    const manifestPath = join(work, "node_modules", "fairux", "package.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`npm install produced no fairux manifest at ${manifestPath}`);
    }
    const installedVersion = JSON.parse(readFileSync(manifestPath, "utf8")).version;
    const mismatch = installedVersionMismatch({
      installed: installedVersion,
      expected: expectedVersion,
    });
    if (mismatch) throw new Error(mismatch);
    ok(`installed version is the resolved one (${installedVersion})`);

    // The signature and provenance audit the release runbook delegates here. `--include-attestations`
    // is what makes the report carry a `verified` array at all; without it the response is only the
    // invalid and missing lists, and "no invalid signatures" is not the same claim as "this package
    // has verifiable provenance".
    try {
      const auditRaw = run("npm", ["audit", "signatures", "--json", "--include-attestations"]);
      const auditFailures = signatureAuditFailures({
        report: JSON.parse(auditRaw),
        packageName: "fairux",
        expectedVersion: installedVersion,
        registry: PUBLIC_NPM_REGISTRY,
      });
      for (const failure of auditFailures) bad(failure);
      if (auditFailures.length === 0) {
        ok(`npm audit signatures verified fairux@${installedVersion} with SLSA provenance`);
      }
    } catch (error) {
      bad(`npm audit signatures failed: ${error.message}`);
    }

    // The executable npm generated, never `node dist/index.js`: a published `bin` pointing at a
    // file npm never linked would still run under `node` while `npx fairux` was broken.
    const bin = installedCliBinPath(work);
    ok(`installed package exposes the npm-generated bin shim (${bin})`);

    for (const failure of runInstalledCliSmoke({
      runCli: (args, { expectStatus = 0, input, cwd = work } = {}) =>
        runCommand(bin, args, { cwd, input, expectStatus, timeout: TIMEOUT }),
      projectDir: work,
      packageVersion: installedVersion,
      onPass: ok,
    })) {
      bad(failure);
    }
  } catch (error) {
    bad(`registry smoke errored: ${error.message}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  console.log(failed ? "\n✗ registry CLI smoke FAILED" : "\n✓ registry CLI smoke passed");
  process.exitCode = failed ? 1 : 0;
}

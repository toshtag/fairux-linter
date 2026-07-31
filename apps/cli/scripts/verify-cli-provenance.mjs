#!/usr/bin/env node
/**
 * Read back the registry's provenance attestation metadata for the version this run published.
 *
 * Runs in the privileged publish job, after the digest and dist-tag checks and before the release
 * notes are written — because the notes make a claim about provenance, and a claim the workflow
 * has not checked is an assumption.
 *
 * Absence is retried, on the same reasoning as the post-publish digest verification: attestation
 * metadata can lag a write the registry has already accepted. Nothing else is. A `dist.attestations`
 * that is present and the wrong shape is a wrong answer, not a late one, and the publish has
 * already happened — retrying would spend the deadline before reporting the same thing.
 *
 * This does not verify a signature or fetch the bundle. `npm audit signatures` against a clean
 * install does that, and it belongs to the registry-installed smoke in M1-R4 where an install
 * exists to audit.
 *
 * Node built-ins only.
 */
import { NPM_CLI_VIEW_REGISTRY_ARGS } from "../../../scripts/public-npm-registry.mjs";
import { runSync } from "../../../scripts/release-subprocess.mjs";
import { waitForCliProvenance } from "./cli-provenance-contract.mjs";
import { cliReleaseSpec } from "./cli-release-contract.mjs";

const USAGE = "Usage: verify-cli-provenance.mjs --version <version>";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/**
 * `npm view <spec> dist.attestations --json`.
 *
 * npm prints nothing at all when the field is absent, so empty output is the absent signal rather
 * than a broken read. A failed command is raised: a registry or credential error must not be
 * mistaken for "no attestation yet".
 */
function readAttestations(spec, run) {
  const stdout = run("npm", [
    "view",
    spec,
    "dist.attestations",
    "--json",
    ...NPM_CLI_VIEW_REGISTRY_ARGS,
  ]);
  const trimmed = stdout.trim();
  if (trimmed === "") return undefined;
  return JSON.parse(trimmed);
}

const version = option("--version");
if (!version) {
  console.error(USAGE);
  process.exit(2);
}

const spec = cliReleaseSpec(version);

let result;
try {
  result = await waitForCliProvenance({
    spec,
    read: (target) => readAttestations(target, runSync),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => performance.now(),
  });
} catch (error) {
  // A failed read is not a passing check. The publish already happened; this run must still go red.
  console.error(`ERROR: could not read provenance metadata for ${spec}: ${error.message}`);
  process.exit(1);
}

if (result.state !== "present") {
  console.error(`\n✖ ${spec} has no usable provenance attestation metadata:\n`);
  for (const failure of result.failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`✓ npm reports provenance attestation metadata for ${spec}`);
console.log("  Signature and bundle verification is npm audit signatures, in M1-R4.");

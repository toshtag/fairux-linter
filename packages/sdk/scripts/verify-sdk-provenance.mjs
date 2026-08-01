#!/usr/bin/env node
/**
 * Read back the registry's provenance attestation metadata for the SDK version this run published.
 *
 * The CLI release path has had this since M1-R2; the SDK's did not, while its release notes told a
 * reader "the npm package carries provenance". That claim was an assumption about what
 * `npm publish --provenance` does rather than a statement about what the registry ended up holding
 * — [issue #83](https://github.com/toshtag/fairux-linter/issues/83).
 *
 * The classification and the bounded absent-only wait are `cli-provenance-contract.mjs`'s, unchanged
 * and unwrapped: what the registry must say about a published version's provenance does not differ
 * between two packages on the same registry, and a second copy would be a second answer. The only
 * SDK-specific values are the registry arguments — scoped names resolve through `@fairux:registry`
 * before `registry` — and the spec.
 *
 * What this proves: the registry reports provenance attestation metadata for this exact version. It
 * does not verify a signature or fetch the bundle; `npm audit signatures` against a clean install
 * does that, and the registry consumer smoke is where an install exists to audit.
 *
 * Node built-ins only — this runs in the privileged publish job.
 */
import { waitForCliProvenance } from "../../../apps/cli/scripts/cli-provenance-contract.mjs";
import { NPM_SDK_VIEW_REGISTRY_ARGS } from "../../../scripts/public-npm-registry.mjs";
import { runSync } from "../../../scripts/release-subprocess.mjs";
import { SDK_PACKAGE_NAME } from "./release-notes.mjs";

const USAGE = "Usage: verify-sdk-provenance.mjs --version <version>";

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
    ...NPM_SDK_VIEW_REGISTRY_ARGS,
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

const spec = `${SDK_PACKAGE_NAME}@${version}`;

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

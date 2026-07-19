#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { getNpmRegistryState } from "./npm-registry-state.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const spec = arg("--spec");
const expectedShasum = arg("--shasum");
const expectedIntegrity = arg("--integrity");
const envFile = arg("--env-file");
const requirePresent = process.argv.includes("--require-present");

if (!spec || !expectedShasum || !expectedIntegrity) {
  console.error(
    "Usage: release-registry-plan.mjs --spec <pkg@version> --shasum <sha1> --integrity <sri> [--env-file <path>] [--require-present]",
  );
  process.exit(2);
}

const state = getNpmRegistryState(spec);
let publishNeeded = "false";
if (state.status === "absent") {
  if (requirePresent) {
    console.error(`ERROR: ${spec} is absent from npm after publish`);
    process.exit(1);
  }
  publishNeeded = "true";
  console.log(`${spec} is absent from npm; publish is required.`);
} else if (state.status === "present") {
  if (state.shasum !== expectedShasum || state.integrity !== expectedIntegrity) {
    console.error(`ERROR: ${spec} exists on npm with a different digest.`);
    console.error(`Expected shasum:   ${expectedShasum}`);
    console.error(`Registry shasum:   ${state.shasum}`);
    console.error(`Expected integrity: ${expectedIntegrity}`);
    console.error(`Registry integrity: ${state.integrity}`);
    process.exit(1);
  }
  console.log(`${spec} exists on npm with matching digest; publish can be skipped.`);
} else {
  console.error(`ERROR: npm registry state is unavailable for ${spec}: ${state.reason}`);
  process.exit(1);
}

if (envFile) {
  appendFileSync(envFile, `PUBLISH_NEEDED=${publishNeeded}\n`, "utf8");
  appendFileSync(envFile, `REGISTRY_STATE=${state.status}\n`, "utf8");
}

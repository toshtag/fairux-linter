#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { computeTarballDigests } from "./sdk-release-utils.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const tarball = arg("--tarball");
const envFile = arg("--env-file");
const checksumFile = arg("--checksum-file");
if (!tarball) {
  console.error(
    "Usage: tarball-digests.mjs --tarball <file> [--env-file <file>] [--checksum-file <file>]",
  );
  process.exit(2);
}

const digests = computeTarballDigests(tarball);
if (envFile) {
  appendFileSync(envFile, `SHA1=${digests.sha1}\n`, "utf8");
  appendFileSync(envFile, `SHA256=${digests.sha256}\n`, "utf8");
  appendFileSync(envFile, `INTEGRITY=${digests.integrity}\n`, "utf8");
}
if (checksumFile) {
  writeFileSync(checksumFile, `${digests.sha256}  ${tarball}\n`, "utf8");
}
console.log(JSON.stringify(digests, null, 2));

#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSync } from "./sdk-release-utils.mjs";

function parseRegistryPayload(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { status: "unavailable", reason: "npm view returned empty output" };
  }
  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch (error) {
    return { status: "unavailable", reason: `npm view returned malformed JSON: ${error.message}` };
  }

  const version = payload.version;
  const shasum = payload.dist?.shasum ?? payload["dist.shasum"];
  const integrity = payload.dist?.integrity ?? payload["dist.integrity"];
  if (typeof version === "string" && typeof shasum === "string" && typeof integrity === "string") {
    return { status: "present", version, shasum, integrity };
  }
  return {
    status: "unavailable",
    reason: `npm view response is missing version, dist.shasum, or dist.integrity`,
  };
}

function classifyNpmError(error) {
  const stderr = String(error.stderr ?? error.cause?.stderr ?? "");
  const stdout = String(error.stdout ?? error.cause?.stdout ?? "");
  const combined = `${stdout}\n${stderr}`;
  if (/\bE404\b|404 Not Found|is not in this registry/i.test(combined)) {
    return { status: "absent" };
  }
  const reason =
    combined
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(" ") || error.message;
  return { status: "unavailable", reason };
}

export function getNpmRegistryState(spec, options = {}) {
  const run = options.run ?? runSync;
  try {
    const stdout = run("npm", ["view", spec, "version", "dist.shasum", "dist.integrity", "--json"]);
    return parseRegistryPayload(stdout);
  } catch (error) {
    return classifyNpmError(error);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const specIndex = process.argv.indexOf("--spec");
  const spec = specIndex >= 0 ? process.argv[specIndex + 1] : process.argv[2];
  if (!spec) {
    console.error("Usage: npm-registry-state.mjs --spec @fairux/sdk@<version>");
    process.exit(2);
  }
  const state = getNpmRegistryState(spec);
  console.log(JSON.stringify(state, null, 2));
  process.exitCode = state.status === "unavailable" ? 1 : 0;
}

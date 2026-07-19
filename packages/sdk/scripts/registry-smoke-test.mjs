#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConsumerSmoke } from "./consumer-smoke.mjs";
import { runSync } from "./sdk-release-utils.mjs";

const spec = process.env.SDK_SPEC;
const expectedVersion = process.env.EXPECTED_VERSION;
if (!spec || !expectedVersion) {
  console.error(
    "Usage: SDK_SPEC=@fairux/sdk@<version> EXPECTED_VERSION=<version> pnpm registry:smoke:sdk",
  );
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "fairux-sdk-registry-smoke-"));
let failed = false;
try {
  runSync("npm", ["init", "-y"], {
    cwd: work,
    env: { npm_config_cache: join(work, ".npm-cache") },
  });
  runSync("npm", ["install", spec, "--no-audit", "--no-fund"], {
    cwd: work,
    env: { npm_config_cache: join(work, ".npm-cache") },
  });
  runConsumerSmoke({ work, expectedVersion });
} catch (error) {
  failed = true;
  console.error(error.message);
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;

#!/usr/bin/env node
/**
 * Decide whether a publish is needed, or verify that one landed.
 *
 * The same script answers both questions, from opposite sides of `npm publish`, and they are not
 * the same read. Before the publish, absence is the expected answer and the only sensible response
 * is a single read. After it, absence is a claim about a write the registry already accepted, and
 * `sdk-v0.1.0-beta.2` showed it can be wrong for a few seconds (issue #62). So the wait is an
 * explicit flag rather than a mode this script infers: `--wait-for-present` waits, and it is
 * accepted only alongside `--require-present`, which is what makes "post-publish" a property of the
 * command line the workflow contract can pin.
 */
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getNpmRegistryState } from "./npm-registry-state.mjs";
import { waitForRegistryVersion } from "./release-registry-wait.mjs";
import { runSync } from "./sdk-release-utils.mjs";

export const REGISTRY_PLAN_USAGE =
  "Usage: release-registry-plan.mjs --spec <pkg@version> --shasum <sha1> --integrity <sri> " +
  "[--env-file <path>] [--require-present [--wait-for-present]]";

export class RegistryPlanUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "RegistryPlanUsageError";
  }
}

/**
 * @param {readonly string[]} argv  arguments only, without the node and script paths
 */
export function parseRegistryPlanArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const spec = value("--spec");
  const expectedShasum = value("--shasum");
  const expectedIntegrity = value("--integrity");
  const envFile = value("--env-file");
  const requirePresent = argv.includes("--require-present");
  const waitForPresent = argv.includes("--wait-for-present");

  if (!spec || !expectedShasum || !expectedIntegrity) {
    throw new RegistryPlanUsageError(REGISTRY_PLAN_USAGE);
  }
  if (waitForPresent && !requirePresent) {
    // Waiting is only meaningful where absence is a failure. Allowing it on the pre-publish read
    // would turn the expected answer there — "not published yet" — into a 97-second pause before
    // the publish that is about to fix it.
    throw new RegistryPlanUsageError(
      "--wait-for-present requires --require-present; the pre-publish plan is a single read",
    );
  }

  return { spec, expectedShasum, expectedIntegrity, envFile, requirePresent, waitForPresent };
}

/** Real sleeping, kept out of the pure wait module so the tests never reach it. */
const realSleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * A reader bound to a cache directory of its own.
 *
 * `--prefer-online` already revalidates, but the wait loop is the one place where a negative
 * response could otherwise be re-served across attempts, so the answer is a cache that did not
 * exist before this step and does not outlive it.
 *
 * @param {string} cacheDir
 */
function readerWithCache(cacheDir) {
  return (spec) =>
    getNpmRegistryState(spec, {
      run: (cmd, args) => runSync(cmd, args, { env: { npm_config_cache: cacheDir } }),
    });
}

/**
 * @param {object} options
 * @param {string} options.spec
 * @param {string} options.expectedShasum
 * @param {string} options.expectedIntegrity
 * @param {boolean} [options.requirePresent]
 * @param {boolean} [options.waitForPresent]
 * @param {(spec: string) => unknown} [options.readState]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]
 * @param {readonly number[]} [options.delaysMs]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{publishNeeded: boolean, status: string}>}
 */
export async function runRegistryPlan({
  spec,
  expectedShasum,
  expectedIntegrity,
  requirePresent = false,
  waitForPresent = false,
  readState,
  sleep = realSleep,
  now = () => Date.now(),
  delaysMs,
  log = console.log,
}) {
  if (waitForPresent) {
    const match = await waitForRegistryVersion({
      spec,
      expectedShasum,
      expectedIntegrity,
      readState: readState ?? getNpmRegistryState,
      sleep,
      now,
      ...(delaysMs ? { delaysMs } : {}),
      onAttempt: ({ attempt, status, elapsedMs, nextDelayMs }) => {
        const next = nextDelayMs === undefined ? "" : `; retrying in ${nextDelayMs}ms`;
        log(`attempt ${attempt}: ${spec} is ${status} after ${elapsedMs}ms${next}`);
      },
    });
    log(
      `${spec} is present on npm with matching digest after ${match.attempts} attempt(s), ${match.elapsedMs}ms.`,
    );
    return { publishNeeded: false, status: "present" };
  }

  const state = await (readState ?? getNpmRegistryState)(spec);

  if (state.status === "absent") {
    if (requirePresent) {
      throw new Error(`ERROR: ${spec} is absent from npm after publish`);
    }
    log(`${spec} is absent from npm; publish is required.`);
    return { publishNeeded: true, status: "absent" };
  }

  if (state.status === "present") {
    if (state.shasum !== expectedShasum || state.integrity !== expectedIntegrity) {
      throw new Error(
        [
          `ERROR: ${spec} exists on npm with a different digest.`,
          `Expected shasum:   ${expectedShasum}`,
          `Registry shasum:   ${state.shasum}`,
          `Expected integrity: ${expectedIntegrity}`,
          `Registry integrity: ${state.integrity}`,
        ].join("\n"),
      );
    }
    log(`${spec} exists on npm with matching digest; publish can be skipped.`);
    return { publishNeeded: false, status: "present" };
  }

  throw new Error(`ERROR: npm registry state is unavailable for ${spec}: ${state.reason}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseRegistryPlanArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  // The cache exists only for the wait loop, and only for the length of this process.
  const cacheDir = options.waitForPresent
    ? mkdtempSync(join(tmpdir(), "fairux-sdk-registry-wait-cache-"))
    : undefined;

  try {
    const { publishNeeded, status } = await runRegistryPlan({
      ...options,
      ...(cacheDir ? { readState: readerWithCache(cacheDir) } : {}),
    });
    if (options.envFile) {
      appendFileSync(options.envFile, `PUBLISH_NEEDED=${publishNeeded}\n`, "utf8");
      appendFileSync(options.envFile, `REGISTRY_STATE=${status}\n`, "utf8");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
  }
}

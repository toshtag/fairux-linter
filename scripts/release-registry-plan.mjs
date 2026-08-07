/**
 * Decide whether a publish is needed, or verify that one landed.
 *
 * The same script answers both questions, from opposite sides of `npm publish`, and they are not
 * the same read. Before the publish, absence is the expected answer and the only sensible response
 * is a single read. After it, absence is a claim about a write the registry already accepted, and
 * `sdk-v0.1.0-beta.2` showed it can be wrong for a few seconds (issue #62). So the wait is an
 * explicit flag rather than a mode this module infers: `--wait-for-present` waits, and it is
 * accepted only alongside `--require-present`, which is what makes "post-publish" a property of the
 * command line the workflow contract can pin.
 *
 * Extracted from `packages/sdk/scripts/release-registry-plan.mjs` for the CLI release path, which
 * had none of this: `publish-cli.yml` called `npm publish` unconditionally and stopped there. A
 * rerun of a successful release went red on `E409`, a version already present with different bytes
 * was left to the registry to reject rather than being reported as a conflict, and nothing ever
 * compared the published digest to the audited one.
 *
 * Everything package-specific is the registry arguments and the cache prefix. The three states, the
 * conflict rule, and the "only absence is retried" rule are shared, and have to be: they are the
 * part that took an incident to get right.
 */
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { readNpmRegistryState } from "./npm-registry-state.mjs";
import { waitForRegistryVersion } from "./release-registry-wait.mjs";
import { runSync } from "./release-subprocess.mjs";

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
    // would turn the expected answer there — "not published yet" — into a wait of up to the whole
    // deadline before the publish that is about to fix it.
    throw new RegistryPlanUsageError(
      "--wait-for-present requires --require-present; the pre-publish plan is a single read",
    );
  }

  return { spec, expectedShasum, expectedIntegrity, envFile, requirePresent, waitForPresent };
}

/** Real sleeping, kept out of the pure wait module so the tests never reach it. */
const realSleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * A reader that answers inside the budget it is given, from a cache of its own.
 *
 * Two properties the wait depends on, neither of which the pure module can provide:
 *
 * - **The subprocess honours the deadline.** `runSync`'s default per-call timeout is larger than
 *   the whole wait budget, so without a deadline of its own a single hanging `npm view` could
 *   outlast the wait it is part of — one read is enough. The schedule's own numbers are a contract
 *   `release-registry-wait.test.ts` holds; they are not restated here.
 * - **A cached negative cannot survive into a later attempt.** `--prefer-online` already
 *   revalidates, but the documented guarantee is stronger than revalidation, so each attempt reads
 *   through a directory of its own under a root that did not exist before this step and does not
 *   outlive it.
 *
 * @param {object} options
 * @param {string} options.cacheRoot
 * @param {readonly string[]} options.registryArgs
 * @param {(cmd: string, args: string[], options?: object) => string} [options.run]
 * @param {(spec: string, options?: object) => unknown} [options.readState]
 */
export function createRegistryReader({
  cacheRoot,
  registryArgs,
  run = runSync,
  readState = readNpmRegistryState,
}) {
  return (spec, { attempt, remainingMs }) => {
    // The wait module hands over whole milliseconds it has already decided are spendable. Clamping
    // here instead would hand the subprocess budget the deadline had not granted — a `Math.max(1,…)`
    // turns a 0.4ms remainder into a 1ms process.
    if (!Number.isInteger(remainingMs) || remainingMs < 1) {
      throw new TypeError(`remainingMs must be a positive integer, got ${String(remainingMs)}`);
    }
    return readState(spec, {
      registryArgs,
      // Only E404 may mean "absent". A killed, unauthenticated, or 5xx `npm view` is raised, so the
      // wait can tell a deadline from a broken read — reported as `unavailable`, both would have
      // been indistinguishable from the registry answering.
      throwOnReadError: true,
      run: (cmd, args) =>
        run(cmd, args, {
          timeout: remainingMs,
          env: { npm_config_cache: join(cacheRoot, `attempt-${attempt}`) },
        }),
    });
  };
}

/**
 * @param {object} options
 * @param {string} options.spec
 * @param {string} options.expectedShasum
 * @param {string} options.expectedIntegrity
 * @param {readonly string[]} [options.registryArgs]  required unless `readState` is supplied
 * @param {boolean} [options.requirePresent]
 * @param {boolean} [options.waitForPresent]
 * @param {(spec: string, context?: object) => unknown} [options.readState]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]  monotonic milliseconds
 * @param {readonly number[]} [options.delaysMs]
 * @param {number} [options.maxElapsedMs]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{publishNeeded: boolean, status: string}>}
 */
export async function runRegistryPlan({
  spec,
  expectedShasum,
  expectedIntegrity,
  registryArgs,
  requirePresent = false,
  waitForPresent = false,
  readState,
  sleep = realSleep,
  // Monotonic. `Date.now()` can step backwards or jump forwards under an NTP correction, which
  // would either extend the deadline or expire it early — the wait measures a duration, not a time.
  now = () => performance.now(),
  delaysMs,
  maxElapsedMs,
  log = console.log,
}) {
  // The same pairing the CLI enforces, so a programmatic caller cannot reach a mode the command
  // line refuses.
  if (waitForPresent && !requirePresent) {
    throw new RegistryPlanUsageError(
      "--wait-for-present requires --require-present; the pre-publish plan is a single read",
    );
  }

  if (waitForPresent && readState === undefined) {
    // No implicit reader in wait mode. A bare `readNpmRegistryState` ignores the read context, so it
    // would give the subprocess no timeout, no per-attempt cache, and no way to distinguish a killed
    // read from a registry answer — the deadline would bound the loop's bookkeeping and nothing
    // else. Measured against a 500ms `npm` with a 50ms deadline: the fallback blocked for over a
    // second. The entrypoint owns the cache lifetime and passes the reader; a programmatic caller
    // must do the same.
    throw new RegistryPlanUsageError(
      "waitForPresent requires a deadline-aware readState; build one with createRegistryReader()",
    );
  }

  if (waitForPresent) {
    const match = await waitForRegistryVersion({
      spec,
      expectedShasum,
      expectedIntegrity,
      readState,
      sleep,
      now,
      // Explicit, not truthy: `maxElapsedMs: 0` is an invalid deadline the wait module rejects, and
      // a truthy spread dropped it so the caller silently got the 120s default instead.
      ...(delaysMs !== undefined ? { delaysMs } : {}),
      ...(maxElapsedMs !== undefined ? { maxElapsedMs } : {}),
      onAttempt: ({ attempt, status, elapsedMs, remainingMs, nextDelayMs }) => {
        const next = nextDelayMs === undefined ? "" : `; retrying in ${nextDelayMs}ms`;
        log(
          `attempt ${attempt}: ${spec} is ${status} after ${elapsedMs}ms, ${remainingMs}ms left${next}`,
        );
      },
    });
    log(
      `${spec} is present on npm with matching digest after ${match.attempts} attempt(s), ${match.elapsedMs}ms.`,
    );
    return { publishNeeded: false, status: "present" };
  }

  const state = await (readState ? readState(spec) : readNpmRegistryState(spec, { registryArgs }));

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

/**
 * The entrypoint both release paths run, given their own registry arguments.
 *
 * Kept here rather than duplicated in each wrapper because the cache root's lifetime is part of the
 * contract: it exists only for the wait loop, only for the length of this process, and each attempt
 * gets a directory below it.
 *
 * @param {object} options
 * @param {readonly string[]} options.argv
 * @param {readonly string[]} options.registryArgs
 * @param {string} options.cachePrefix  distinguishes the two packages' temp directories
 * @returns {Promise<number>} the process exit code
 */
export async function runRegistryPlanCli({ argv, registryArgs, cachePrefix }) {
  let options;
  try {
    options = parseRegistryPlanArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 2;
  }

  const cacheRoot = options.waitForPresent ? mkdtempSync(join(tmpdir(), cachePrefix)) : undefined;

  try {
    const { publishNeeded, status } = await runRegistryPlan({
      ...options,
      registryArgs,
      ...(cacheRoot ? { readState: createRegistryReader({ cacheRoot, registryArgs }) } : {}),
    });
    if (options.envFile) {
      appendFileSync(options.envFile, `PUBLISH_NEEDED=${publishNeeded}\n`, "utf8");
      appendFileSync(options.envFile, `REGISTRY_STATE=${status}\n`, "utf8");
    }
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  } finally {
    if (cacheRoot) rmSync(cacheRoot, { recursive: true, force: true });
  }
}

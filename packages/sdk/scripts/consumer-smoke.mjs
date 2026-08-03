#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdkDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(sdkDir, "..", "..");
const fixturesDir = resolve(repoRoot, "tests", "fixtures");
const TIMEOUT = 120_000;
/**
 * Two ceilings, because they answer different questions.
 *
 * The unminified bundle is what esbuild emits here; no consumer ships it, so its ceiling is a
 * coarse guard against the SDK gaining a dependency-sized amount of code at once. The minified one
 * is what a browser product actually serves, and it is the number worth being strict about.
 *
 * Raised from 180 KiB when the journey contract, the Risk Index contract, and remediation validation
 * landed: real features whose code the scanner reaches, so no amount of tree-shaking removes them.
 * A budget that is raised whenever it is hit measures nothing — the minified ceiling exists so this
 * one does not have to carry the whole argument alone.
 */
const MAX_BROWSER_BUNDLE_BYTES = 192 * 1024;
const MAX_MINIFIED_BROWSER_BUNDLE_BYTES = 112 * 1024;
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => name.replace(/^node:/, "")),
  ...builtinModules.map((name) => `node:${name.replace(/^node:/, "")}`),
]);

/** Every check that reported `✗`, so the failure can be raised rather than only printed. */
const failures = [];
const ok = (message) => console.log(`✓ ${message}`);
const bad = (message) => {
  console.error(`✗ ${message}`);
  failures.push(message);
};
const assert = (condition, message) => (condition ? ok(message) : bad(message));

function run(cmd, args, options = {}) {
  const { env = {}, ...execOptions } = options;
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TIMEOUT,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...env },
      ...execOptions,
    });
  } catch (error) {
    const stdout = String(error.stdout ?? "");
    const stderr = String(error.stderr ?? "");
    throw new Error(
      [
        `${cmd} ${args.join(" ")} failed`,
        stdout ? `stdout:\n${stdout}` : undefined,
        stderr ? `stderr:\n${stderr}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function repoBin(name) {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  const rootBin = resolve(repoRoot, "node_modules", ".bin", `${name}${suffix}`);
  if (existsSync(rootBin)) return rootBin;
  return resolve(sdkDir, "node_modules", ".bin", `${name}${suffix}`);
}

function importSpecifiers(source) {
  const specs = [];
  const re =
    /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(re)) specs.push(match[1] ?? match[2] ?? match[3]);
  return specs;
}

function assertNoNodeBuiltins(source, label) {
  const imports = importSpecifiers(source).filter((specifier) => nodeBuiltins.has(specifier));
  assert(imports.length === 0, `${label} has no Node builtin import`);
}

function copyFixture(name, work) {
  const target = join(work, name);
  rmSync(target, { recursive: true, force: true });
  cpSync(join(fixturesDir, name), target, { recursive: true });
}

/**
 * The fixtures each profile stages — the whole list, from one function, so a test can pin the
 * separation and neither profile can quietly borrow the other's trees.
 *
 * The release fixtures evolve with the default branch: ahead of the next SDK publication they may
 * use new API, types, RulePack metadata, or validation the published SDK does not have yet. The
 * registry canary therefore stages only `sdk-registry-consumer-v1`, a frozen consumer contract
 * written against the published beta; proving new surface belongs to a future v2 directory.
 *
 * @param {string} profile
 * @returns {string[]}
 */
export function consumerSmokeFixtureNames(profile) {
  if (profile === "release") {
    return [
      "sdk-custom-rule-pack",
      "sdk-node-consumer",
      "sdk-browser-consumer",
      "sdk-typescript-consumer",
    ];
  }
  if (profile === "registry-consumer") {
    return [REGISTRY_CONSUMER_CONTRACT_ID];
  }
  throw new Error(`unknown consumer smoke profile: ${JSON.stringify(profile)}`);
}

const REGISTRY_CONSUMER_CONTRACT_ID = "sdk-registry-consumer-v1";
const REGISTRY_CONSUMER_MINIMUM_SDK_VERSION = "0.1.0-beta.2";
const REGISTRY_CONSUMER_CONTRACT_FILES = Object.freeze([
  "browser-entry.ts",
  "node-consumer.mjs",
  "purchase-guard-pack.mjs",
  "tsconfig.json",
  "typescript-consumer.ts",
]);

/**
 * Prove the v1 registry consumer fixture is exactly the frozen contract it claims to be.
 *
 * The frozen-ness of `sdk-registry-consumer-v1` is what makes the canary honest, and prose alone
 * does not freeze anything: an edit that quietly used next-main SDK surface would pass every
 * structural boundary — no release fixture reference, no workspace reference, same file names —
 * and only fail weeks later, on the scheduled run against the published SDK. So the contract
 * manifest pins a content digest, and this validator refuses a directory whose identity, file
 * set, or bytes differ from it. Editing v1 therefore fails ordinary CI, which is the point:
 * the sanctioned path for new surface is a v2 directory with its own contract.
 *
 * The digest covers the listed files in their listed order — for each, the UTF-8 relative name,
 * a NUL, the raw bytes, a NUL — and deliberately not `contract.json` itself.
 *
 * @param {string} [fixtureDir]
 */
export function validateRegistryConsumerContract(
  fixtureDir = resolve(fixturesDir, REGISTRY_CONSUMER_CONTRACT_ID),
) {
  const fail = (message) => {
    throw new Error(`registry consumer contract violated: ${message}`);
  };
  const contract = JSON.parse(readFileSync(join(fixtureDir, "contract.json"), "utf8"));
  if (contract.id !== REGISTRY_CONSUMER_CONTRACT_ID) {
    fail(`id must be ${REGISTRY_CONSUMER_CONTRACT_ID}, got ${JSON.stringify(contract.id)}`);
  }
  if (contract.minimumSdkVersion !== REGISTRY_CONSUMER_MINIMUM_SDK_VERSION) {
    fail(
      `minimumSdkVersion must be ${REGISTRY_CONSUMER_MINIMUM_SDK_VERSION}, got ${JSON.stringify(
        contract.minimumSdkVersion,
      )}`,
    );
  }
  if (JSON.stringify(contract.files) !== JSON.stringify([...REGISTRY_CONSUMER_CONTRACT_FILES])) {
    fail(`files must list exactly ${REGISTRY_CONSUMER_CONTRACT_FILES.join(", ")}`);
  }

  const entries = readdirSync(fixtureDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) fail(`${entry.name} is not a regular file`);
  }
  const actual = entries.map((entry) => entry.name).sort();
  const expected = ["contract.json", ...REGISTRY_CONSUMER_CONTRACT_FILES].sort();
  for (const name of expected) {
    if (!actual.includes(name)) fail(`missing file: ${name}`);
  }
  for (const name of actual) {
    if (!expected.includes(name)) fail(`unexpected file: ${name}`);
  }

  if (
    typeof contract.contentSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(contract.contentSha256)
  ) {
    fail("contentSha256 must be 64 lowercase hex characters");
  }
  const hash = createHash("sha256");
  for (const file of contract.files) {
    hash.update(file, "utf8");
    hash.update("\0");
    hash.update(readFileSync(join(fixtureDir, file)));
    hash.update("\0");
  }
  const digest = hash.digest("hex");
  if (digest !== contract.contentSha256) {
    fail(`content digest mismatch: expected ${contract.contentSha256}, computed ${digest}`);
  }

  return Object.freeze({
    id: contract.id,
    minimumSdkVersion: contract.minimumSdkVersion,
    files: Object.freeze([...contract.files]),
    contentSha256: contract.contentSha256,
  });
}

/**
 * Bundle a fixture's `browser-entry.ts` for the browser platform, audit the bundle, and execute it
 * against a browser-like DOM. Identical for both profiles except for which fixture supplies the
 * entry — which is exactly the point: the bundle contract is the published SDK's, not a fixture's.
 */
function runBrowserConsumer(work, fixtureName, manifest) {
  const browserDist = join(work, fixtureName, "dist");
  mkdirSync(browserDist, { recursive: true });
  const browserBundle = join(browserDist, "browser-bundle.mjs");
  const browserMeta = join(browserDist, "meta.json");
  run(
    repoBin("esbuild"),
    [
      join(work, fixtureName, "browser-entry.ts"),
      "--bundle",
      "--platform=browser",
      "--format=esm",
      `--metafile=${browserMeta}`,
      `--outfile=${browserBundle}`,
    ],
    { cwd: work },
  );
  ok("browser consumer bundles with platform=browser");
  const meta = JSON.parse(readFileSync(browserMeta, "utf8"));
  const outputImports = Object.values(meta.outputs).flatMap((output) => output.imports ?? []);
  assert(outputImports.length === 0, "browser bundle has no unresolved external imports");
  const bundleSource = readFileSync(browserBundle, "utf8");
  assertNoNodeBuiltins(bundleSource, "browser bundle");
  assert(!bundleSource.includes(repoRoot), "browser bundle has no SDK source tree references");
  const browserBundleSize = readFileSync(browserBundle).byteLength;
  assert(
    browserBundleSize < MAX_BROWSER_BUNDLE_BYTES,
    `browser bundle under ${MAX_BROWSER_BUNDLE_BYTES} bytes (${browserBundleSize})`,
  );
  // What a consumer actually serves. Measured from the same entry, so the two numbers describe one
  // bundle rather than two builds that drifted.
  const minifiedBundle = `${browserBundle}.min.mjs`;
  run(
    repoBin("esbuild"),
    [
      join(work, fixtureName, "browser-entry.ts"),
      "--bundle",
      "--minify",
      "--platform=browser",
      "--format=esm",
      `--outfile=${minifiedBundle}`,
    ],
    { cwd: work },
  );
  const minifiedSize = readFileSync(minifiedBundle).byteLength;
  assert(
    minifiedSize < MAX_MINIFIED_BROWSER_BUNDLE_BYTES,
    `minified browser bundle under ${MAX_MINIFIED_BROWSER_BUNDLE_BYTES} bytes (${minifiedSize})`,
  );

  const require = createRequire(pathToFileURL(join(sdkDir, "package.json")).href);
  const happyDomPath = require.resolve("happy-dom");
  const browserRun = `
    const { Window } = await import(${JSON.stringify(pathToFileURL(happyDomPath).href)});
    const mod = await import(${JSON.stringify(pathToFileURL(browserBundle).href)});
    const window = new Window();
    window.document.body.innerHTML = "<main><label><input type='checkbox' checked> Email me</label><form><input name='email'><button>Buy now</button></form></main>";
    globalThis.document = window.document;
    const result = mod.scanCurrentDocument();
    if (!result || result.findings < 2 || result.reused !== true) throw new Error("expected reusable browser findings");
    if (result.contextFinding !== true) throw new Error("expected browser DOM context-gated finding");
    if (result.taxonomyCategories < 1) throw new Error("expected browser DOM taxonomy categories");
    if (result.taxonomyPageContexts < 1) throw new Error("expected browser DOM taxonomy page contexts");
    if (result.toolVersion !== ${JSON.stringify(manifest.version)}) {
      throw new Error(\`expected browser toolVersion ${manifest.version}, got \${result.toolVersion}\`);
    }
  `;
  run("node", ["--input-type=module", "--eval", browserRun], { cwd: repoRoot });
  ok("browser bundle executes against a browser-like DOM");
}

/**
 * The release claim: the SDK artifact packed from this checkout matches this checkout — its
 * generated rule catalog exactly, its fixed rule, source, and maturity counts, its specific
 * official sources and known-limitation text, and its authoring fixtures.
 */
function runReleaseChecks(work, manifest) {
  // The generated catalog is this checkout's, not the published SDK's — copying it is exactly
  // the release-only claim, so the registry-consumer profile must never see it.
  cpSync(
    join(repoRoot, "docs", "generated", "rule-catalog.json"),
    join(work, "sdk-node-consumer", "rule-catalog.json"),
  );

  const nodeOut = JSON.parse(
    run("node", [join(work, "sdk-node-consumer", "consumer.mjs")], { cwd: work }),
  );
  assert(
    nodeOut.ok === true && nodeOut.findings >= 2,
    "Node consumer reports built-in and custom findings",
  );
  assert(
    nodeOut.toolVersion === manifest.version,
    "Node consumer report.toolVersion matches installed SDK version",
  );
  assert(nodeOut.taxonomyCategories >= 1, "Node consumer sees scanner taxonomy categories");
  assert(nodeOut.taxonomyPageContexts >= 1, "Node consumer sees scanner taxonomy page contexts");
  assert(nodeOut.builtInGovernance === true, "Node consumer verifies built-in governance metadata");
  assert(
    nodeOut.builtInGovernanceExactRules === 13,
    "Node consumer exact-compares all 13 built-in governance contracts",
  );
  assert(nodeOut.builtInRuntimeSources === 31, "Node consumer sees 31 built-in runtime sources");
  assert(nodeOut.builtInStableRules === 11, "Node consumer sees 11 stable built-in rules");
  assert(
    nodeOut.builtInExperimentalRules === 2,
    "Node consumer sees 2 experimental built-in rules",
  );
  assert(nodeOut.contextFindings >= 2, "Node consumer runs external page-context rules");

  const governanceOut = JSON.parse(
    run("node", [join(work, "sdk-node-consumer", "governance-consumer.mjs")], {
      cwd: work,
    }),
  );
  assert(governanceOut.ok === true, "packed governance consumer succeeds");
  assert(governanceOut.fullMetadata === true, "packed governance metadata is preserved");
  assert(governanceOut.frozen === true, "packed governance metadata is deeply frozen");
  assert(
    governanceOut.mutationIsolated === true,
    "packed governance metadata is mutation isolated",
  );
  assert(governanceOut.invalidPacksRejected === 3, "packed invalid governance is rejected");

  run(repoBin("tsc"), ["--noEmit", "-p", join(work, "sdk-typescript-consumer", "tsconfig.json")], {
    cwd: work,
  });
  ok("TypeScript consumer compiles against installed declarations");

  runBrowserConsumer(work, "sdk-browser-consumer", manifest);
}

/**
 * The registry claim: a published SDK, installed clean from the public registry, still satisfies
 * the frozen v1 consumer contract — entry points, composition, provenance, taxonomy, governance
 * metadata presence and immutability, malformed-pack rejection, and version identity. No
 * generated catalog, no fixed counts, no checkout-specific text: those are release facts.
 */
function runRegistryConsumerChecks(work, manifest) {
  const fixtureName = "sdk-registry-consumer-v1";
  const nodeOut = JSON.parse(
    run("node", [join(work, fixtureName, "node-consumer.mjs")], { cwd: work }),
  );
  assert(
    nodeOut.ok === true && nodeOut.findings >= 2,
    "Node consumer reports built-in and Purchase Guard findings",
  );
  assert(
    nodeOut.toolVersion === manifest.version,
    "Node consumer report.toolVersion matches installed SDK version",
  );
  assert(nodeOut.taxonomyCategories >= 1, "Node consumer sees scanner taxonomy categories");
  assert(nodeOut.taxonomyPageContexts >= 1, "Node consumer sees scanner taxonomy page contexts");
  assert(nodeOut.contextFindings >= 2, "Node consumer runs external page-context rules");
  assert(nodeOut.governedRules >= 1, "Node consumer sees governed built-in rules");
  assert(nodeOut.stableRules >= 1, "Node consumer sees stable built-in rules");
  assert(nodeOut.frozen === true, "composed taxonomy is deeply frozen");
  assert(nodeOut.mutationIsolated === true, "source pack mutation stays isolated");
  assert(nodeOut.malformedPackRejected === true, "malformed external pack is rejected");

  run(repoBin("tsc"), ["--noEmit", "-p", join(work, fixtureName, "tsconfig.json")], {
    cwd: work,
  });
  ok("TypeScript consumer compiles against installed declarations");

  runBrowserConsumer(work, fixtureName, manifest);
}

/**
 * @param {object} [options]
 * @param {string} [options.work]
 * @param {string} [options.expectedVersion]
 * @param {"release" | "registry-consumer"} [options.profile]  what the run asserts, and which
 *   fixtures it stages — see `consumerSmokeFixtureNames`. `release` (the default, and the
 *   pack/tarball callers' behavior) holds the installed SDK to this checkout: generated catalog,
 *   exact counts, specific sources and limitations, and the evolving authoring fixtures.
 *   `registry-consumer` runs only the frozen `sdk-registry-consumer-v1` contract, because between
 *   a change on the default branch and the next SDK publication, the published SDK and this
 *   checkout legitimately differ — a canary that held one to the other would fail on ordinary
 *   development with no consumer-compatibility fact behind it. The profile is explicit — never
 *   inferred from `expectedVersion` or the caller's shape.
 */
export function runConsumerSmoke(options = {}) {
  const profile = options.profile ?? "release";
  const fixtures = consumerSmokeFixtureNames(profile);
  // `failures` is module state shared with `assert`, so a second call in the same process would
  // otherwise inherit the first call's verdict. Both callers run it once per process today; this
  // keeps that from being load-bearing.
  failures.length = 0;
  const work = resolve(options.work ?? process.cwd());
  const expectedVersion = options.expectedVersion ?? process.env.EXPECTED_VERSION;
  if (profile === "registry-consumer") {
    // Before anything is staged: a drifted v1 tree must fail as a contract violation here, not
    // as a confusing consumer failure later. The release fixtures are the checkout's to evolve,
    // so the release profile carries no digest.
    validateRegistryConsumerContract();
  }
  for (const fixture of fixtures) {
    copyFixture(fixture, work);
  }

  const manifest = JSON.parse(
    readFileSync(join(work, "node_modules", "@fairux", "sdk", "package.json"), "utf8"),
  );
  if (expectedVersion) {
    assert(
      manifest.version === expectedVersion,
      `installed SDK version matches expected ${expectedVersion}`,
    );
  }

  if (profile === "registry-consumer") {
    runRegistryConsumerChecks(work, manifest);
  } else {
    runReleaseChecks(work, manifest);
  }

  // Raised, not returned. Both callers wrap this in a try/catch that marks the run failed, and
  // both ignored a boolean — so a `✗` line printed here left the smoke exiting 0.
  if (failures.length > 0) {
    throw new Error(
      [
        `SDK consumer smoke failed ${failures.length} check(s):`,
        ...failures.map((m) => `- ${m}`),
      ].join("\n"),
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runConsumerSmoke({ work: process.cwd() });
    console.log("\n✓ SDK consumer smoke passed");
  } catch (error) {
    console.error(`\n✗ SDK consumer smoke FAILED\n${error.message}`);
    process.exitCode = 1;
  }
}

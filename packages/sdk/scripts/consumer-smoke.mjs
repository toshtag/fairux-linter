#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdkDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(sdkDir, "..", "..");
const fixturesDir = resolve(repoRoot, "tests", "fixtures");
const TIMEOUT = 120_000;
const MAX_BROWSER_BUNDLE_BYTES = 180 * 1024;
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => name.replace(/^node:/, "")),
  ...builtinModules.map((name) => `node:${name.replace(/^node:/, "")}`),
]);

let failed = false;
const ok = (message) => console.log(`✓ ${message}`);
const bad = (message) => {
  console.error(`✗ ${message}`);
  failed = true;
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

export function runConsumerSmoke(options = {}) {
  const work = resolve(options.work ?? process.cwd());
  const expectedVersion = options.expectedVersion ?? process.env.EXPECTED_VERSION;
  for (const fixture of [
    "sdk-custom-rule-pack",
    "sdk-node-consumer",
    "sdk-browser-consumer",
    "sdk-typescript-consumer",
  ]) {
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
  assert(nodeOut.contextFindings >= 2, "Node consumer runs external page-context rules");

  run(repoBin("tsc"), ["--noEmit", "-p", join(work, "sdk-typescript-consumer", "tsconfig.json")], {
    cwd: work,
  });
  ok("TypeScript consumer compiles against installed declarations");

  const browserDist = join(work, "sdk-browser-consumer", "dist");
  mkdirSync(browserDist, { recursive: true });
  const browserBundle = join(browserDist, "browser-bundle.mjs");
  const browserMeta = join(browserDist, "meta.json");
  run(
    repoBin("esbuild"),
    [
      join(work, "sdk-browser-consumer", "browser-entry.ts"),
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

  return !failed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runConsumerSmoke({ work: process.cwd() });
  } catch (error) {
    bad(error.message);
  }
  console.log(failed ? "\n✗ SDK consumer smoke FAILED" : "\n✓ SDK consumer smoke passed");
  process.exitCode = failed ? 1 : 0;
}

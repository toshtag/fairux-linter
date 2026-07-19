#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdkDir = join(repoRoot, "packages", "sdk");
const exampleDir = join(repoRoot, "examples", "rule-pack-author");
const work = mkdtempSync(join(tmpdir(), "fairux-rule-pack-author-example-"));
const packDir = join(work, "pack");
const consumerDir = join(work, "example");
const TIMEOUT = 120_000;
const forbiddenFairuxPackages = ["@fairux/core", "@fairux/rules", "@fairux/html", "@fairux/dom"];

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
      env: { ...process.env, npm_config_cache: join(work, ".npm-cache"), ...env },
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

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    if (entry.isFile() && /\.(ts|tsx|js|mjs|json|md)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function assertNoForbiddenImports() {
  const importPattern =
    /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const file of sourceFiles(consumerDir)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (forbiddenFairuxPackages.includes(specifier)) {
        bad(`${relative(consumerDir, file)} imports forbidden package ${specifier}`);
      }
      if (/packages\/.*\/src/.test(specifier)) {
        bad(`${relative(consumerDir, file)} imports workspace source path ${specifier}`);
      }
    }
  }
  assert(true, "example source imports only public SDK entry points and local files");
}

try {
  run("pnpm", ["--filter", "@fairux/sdk", "pack", "--pack-destination", packDir], {
    cwd: repoRoot,
  });
  const tarballName = readdirSync(packDir).find(
    (file) => file.startsWith("fairux-sdk-") && file.endsWith(".tgz"),
  );
  if (!tarballName) throw new Error("SDK pack did not produce a tarball");
  const tarball = join(packDir, tarballName);
  ok(`packed SDK tarball ${tarballName}`);

  cpSync(exampleDir, consumerDir, { recursive: true });
  const manifestPath = join(consumerDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dependencies = {
    ...manifest.dependencies,
    "@fairux/sdk": `file:${tarball}`,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  assertNoForbiddenImports();

  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumerDir });
  ok("installed example dependencies with @fairux/sdk from the packed tarball");

  for (const packageName of forbiddenFairuxPackages) {
    const packagePath = join(consumerDir, "node_modules", ...packageName.split("/"));
    assert(!existsSync(packagePath), `${packageName} is not installed in the external example`);
  }

  const installedManifest = JSON.parse(
    readFileSync(join(consumerDir, "node_modules", "@fairux", "sdk", "package.json"), "utf8"),
  );
  const sourceManifest = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8"));
  assert(
    installedManifest.version === sourceManifest.version,
    `example installed SDK ${installedManifest.version} from packed tarball`,
  );

  run("npm", ["run", "build"], { cwd: consumerDir });
  ok("external example TypeScript build passed");
  run("npm", ["test"], { cwd: consumerDir });
  ok("external example Vitest tests passed");
} catch (error) {
  bad(error.message);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(
  failed ? "\n✗ RulePack author example smoke FAILED" : "\n✓ RulePack author example smoke passed",
);
process.exitCode = failed ? 1 : 0;

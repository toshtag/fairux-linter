#!/usr/bin/env node
/**
 * The CLI's release preflight — the whole publishable contract, in one command.
 *
 * `pnpm release:check:cli -- --tag v0.1.0-beta.1` answers "would this commit release cleanly?"
 * without a tag existing, without a registry, and without publishing. Runnable at any time, which
 * is the point: the CLI's release path was first exercised end to end by a real tag, and that is
 * when a mistake costs a consumed version rather than a red check. Where it runs in CI is the
 * workflows' business — `release-dry-run.mjs` invokes it as part of the rehearsal, and the publish
 * job runs it twice, once on the manifest and once on the bytes it downloaded.
 *
 * Two modes, deliberately one script:
 *
 * - **Without a tarball** it audits the checked-out manifest. That is the preflight.
 * - **With `--tarball` (or `TARBALL`)** it additionally audits those exact packed bytes, using this
 *   checkout's own auditor. That is what the privileged publish job runs against the bundle it
 *   downloaded, where the tarball is untrusted input.
 *
 * Node built-ins only: no external `tar`, no install, no CLI execution, no network.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditCliReleaseManifest, cliTarballName } from "./cli-release-contract.mjs";
import { auditPackedCliTarball } from "./packed-tarball-contract.mjs";

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(cliDir, "..", "..");

const USAGE = "Usage: release-check.mjs [--tag <tag>] [--tarball <path>]";

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function main(rawArgv) {
  // `pnpm release:check:cli -- --tag v0.1.0-beta.1` forwards the bare `--` as an argument. Dropping
  // it here keeps the pnpm invocation and the plain `node` one accepting the same flags.
  const argv = rawArgv.filter((argument) => argument !== "--");

  for (const argument of argv) {
    if (argument.startsWith("--") && argument !== "--tag" && argument !== "--tarball") {
      console.error(`ERROR: unknown argument: ${argument}\n${USAGE}`);
      process.exit(2);
    }
  }

  const tag = option(argv, "--tag");
  const tarball = option(argv, "--tarball") ?? process.env.TARBALL;

  const manifestPath = resolve(cliDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const failures = auditCliReleaseManifest({ manifest, tag });
  if (failures.length === 0) {
    console.log(`✓ apps/cli/package.json satisfies the CLI release contract`);
    console.log(`  package:  ${manifest.name} ${manifest.version}`);
    if (tag) console.log(`  tag:      ${tag}`);
    console.log(`  tarball:  ${cliTarballName(manifest.version)}`);
  }

  if (tarball) {
    if (!existsSync(tarball)) {
      failures.push(`tarball does not exist: ${tarball}`);
    } else {
      // The name is derived from the manifest rather than read off the file, so a bundle carrying
      // a correctly-shaped tarball for a different version cannot pass by being present.
      const expected = cliTarballName(manifest.version);
      // `basename`, not a `/`-suffix comparison: the separator differs by platform, and this
      // script runs on every runner the release path is rehearsed on.
      if (basename(resolve(tarball)) !== expected) {
        failures.push(`tarball is not named ${expected}: ${tarball}`);
      }
      failures.push(
        ...auditPackedCliTarball({
          tarball: resolve(tarball),
          sourceManifestPath: manifestPath,
          repoRoot,
          onPass: (message) => console.log(`✓ ${message}`),
        }),
      );
    }
  }

  if (failures.length > 0) {
    console.error("\n✖ CLI release check failed:\n");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log("\n✓ CLI release check passed");
}

main(process.argv.slice(2));

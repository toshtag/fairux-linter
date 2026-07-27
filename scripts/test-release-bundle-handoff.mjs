#!/usr/bin/env node
/**
 * Run the prepare→publish artifact handoff on a real filesystem, in ordinary CI.
 *
 * The release workflows fire on tag push, so nothing in them executes during a pull request. That
 * gap produced a defect that only a tag could have found: the SDK's checksum step wrote into
 * `$RUNNER_TEMP/bundle`, which no step created, while the upload read `$RUNNER_TEMP`. Unit tests
 * passed — they drive the pure contract with in-memory file lists, and never touch a path.
 *
 * So this exercises the two executables the workflows actually invoke, against a synthetic tarball,
 * and asserts both the happy path and the tampering the verifier exists to catch. It costs a few
 * seconds per CI run, and it is the only thing between an edit here and a failed release.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");

let failed = 0;
const ok = (message) => console.log(`✓ ${message}`);
const bad = (message) => {
  failed += 1;
  console.error(`✗ ${message}`);
};

function check(label, fn) {
  try {
    fn();
    ok(label);
  } catch (error) {
    bad(`${label} — ${error.message}`);
  }
}

/** A minimal well-formed .tgz, so the assembler has real bytes to digest. */
function syntheticTarball(name) {
  const header = Buffer.alloc(512);
  header.write(`package/${name}`, 0);
  header.write("0000644\0", 100);
  header.write("00000000000\0", 124); // size 0
  header.write("        ", 148); // checksum placeholder
  header.write("0", 156);
  header.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));
}

function node(args, options = {}) {
  return execFileSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
}

const workspace = mkdtempSync(join(tmpdir(), "fairux-handoff-"));
try {
  for (const kind of ["sdk", "cli"]) {
    const manifestPath = kind === "sdk" ? "packages/sdk/package.json" : "apps/cli/package.json";
    const manifest = JSON.parse(readFileSync(join(repoRoot, manifestPath), "utf8"));
    const tagPrefix = kind === "sdk" ? "sdk-v" : "v";
    const tag = `${tagPrefix}${manifest.version}`;
    const commit = "0".repeat(40);
    const expected = `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`;

    const packed = join(workspace, `${kind}-packed`, expected);
    mkdirSync(dirname(packed), { recursive: true });
    writeFileSync(packed, syntheticTarball("package.json"));

    const bundle = join(workspace, `${kind}-bundle`);
    const envFile = join(workspace, `${kind}.env`);
    writeFileSync(envFile, "");

    const assemble = () =>
      node([
        "scripts/assemble-release-bundle.mjs",
        "--kind",
        kind,
        "--tarball",
        packed,
        "--manifest",
        manifestPath,
        "--tag",
        tag,
        "--commit",
        commit,
        "--out",
        bundle,
        "--env-file",
        envFile,
      ]);

    const verify = (env = join(workspace, `${kind}-verified.env`)) => {
      writeFileSync(env, "");
      return node([
        "scripts/verify-release-bundle.mjs",
        "--kind",
        kind,
        "--bundle",
        bundle,
        "--tag",
        tag,
        "--commit",
        commit,
        "--package-json",
        manifestPath,
        "--github-env",
        env,
      ]);
    };

    check(`[${kind}] assemble writes the bundle the workflow uploads`, () => {
      assemble();
      const env = Object.fromEntries(
        readFileSync(envFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const at = line.indexOf("=");
            return [line.slice(0, at), line.slice(at + 1)];
          }),
      );
      // The exact defect this file exists for: BUNDLE_DIR is what the upload step passes, and the
      // assembler must have written every file into it.
      if (env.BUNDLE_DIR !== bundle) throw new Error(`BUNDLE_DIR is ${env.BUNDLE_DIR}`);
      if (env.TARBALL !== join(bundle, expected)) throw new Error(`TARBALL is ${env.TARBALL}`);
      const checksum = readFileSync(join(bundle, "release-sha256.txt"), "utf8");
      const sha256 = createHash("sha256").update(readFileSync(packed)).digest("hex");
      // Basename, not the absolute path the old digest script wrote.
      if (checksum !== `${sha256}  ${expected}\n`) throw new Error(`checksum line is ${checksum}`);
      JSON.parse(readFileSync(join(bundle, "release-metadata.json"), "utf8"));
    });

    check(`[${kind}] verify accepts the assembled bundle`, () => {
      verify();
    });

    check(`[${kind}] verify refuses an extra file`, () => {
      writeFileSync(join(bundle, "EXTRA.txt"), "x");
      try {
        verify();
        throw new Error("verifier accepted an extra file");
      } catch (error) {
        if (!String(error.stderr ?? error.message).includes("bundle contents do not match"))
          throw error;
      } finally {
        rmSync(join(bundle, "EXTRA.txt"), { force: true });
      }
    });

    check(`[${kind}] verify refuses a directory in the bundle`, () => {
      const intruder = join(bundle, "payload.d");
      mkdirSync(intruder, { recursive: true });
      try {
        verify();
        throw new Error("verifier accepted a directory");
      } catch (error) {
        if (!String(error.stderr ?? error.message).includes("not regular files")) throw error;
      } finally {
        rmSync(intruder, { recursive: true, force: true });
      }
    });

    check(`[${kind}] verify refuses a symlink in the bundle`, () => {
      const link = join(bundle, "release-notes.md");
      symlinkSync("/etc/passwd", link);
      try {
        verify();
        throw new Error("verifier accepted a symlink");
      } catch (error) {
        if (!String(error.stderr ?? error.message).includes("not regular files")) throw error;
      } finally {
        rmSync(link, { force: true });
      }
    });

    check(`[${kind}] verify refuses a rewritten tarball`, () => {
      writeFileSync(join(bundle, expected), syntheticTarball("evil.js"));
      try {
        verify();
        throw new Error("verifier accepted mismatched bytes");
      } catch (error) {
        if (!String(error.stderr ?? error.message).includes("release-sha256.txt")) throw error;
      } finally {
        chmodSync(bundle, 0o755);
        assemble();
      }
    });

    check(`[${kind}] verify refuses a tampered dist-tag`, () => {
      const metadataPath = join(bundle, "release-metadata.json");
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      metadata.distTag = "latest";
      writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
      try {
        verify();
        throw new Error("verifier accepted a tampered dist-tag");
      } catch (error) {
        if (!String(error.stderr ?? error.message).includes("release bundle rejected")) throw error;
      } finally {
        assemble();
      }
    });
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

console.log(failed ? "\n✗ release bundle handoff FAILED" : "\n✓ release bundle handoff verified");
process.exitCode = failed ? 1 : 0;

#!/usr/bin/env node
/**
 * Run the publish job's trusted audits against real artifacts, plus adversarial ones, in CI.
 *
 * `scripts/test-release-bundle-handoff.mjs` chains the assembler to the verifier — the bundle's
 * *outer* envelope. It says nothing about what is inside the tarball, so the whole second half of
 * each publish job (`release-check.mjs`, `audit-packed-tarball.mjs`) went unexercised until a tag
 * fired. Every finding in the fifth review round lived there: duplicate members, `.`-segment
 * aliases, manifest field injection, comment-obfuscated dynamic imports.
 *
 * This packs both publishable packages for real, runs the full chain, and then rebuilds each
 * tarball with a specific defect and requires the audit to reject it. Building the negatives from
 * the *current* artifact matters: a hand-written fixture drifts, and would keep passing after the
 * thing it models stopped existing.
 *
 * It never contacts the registry, mints a token, or publishes.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
const ok = (message) => console.log(`✓ ${message}`);
const bad = (message) => {
  failed += 1;
  console.error(`✗ ${message}`);
};

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

const node = (args, options) => run(process.execPath, args, options);

/** Rebuild a tarball from an explicit member list, so a negative fixture can be exact. */
function writeTarball(target, members) {
  const blocks = [];
  for (const [name, content] of members) {
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\x0000", 257);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header);
    const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
    content.copy(body);
    blocks.push(body);
  }
  blocks.push(Buffer.alloc(1024));
  writeFileSync(target, gzipSync(Buffer.concat(blocks)));
}

/** Every member of a tarball, as [name, bytes]. */
function readMembers(tarball) {
  return run("tar", ["-tzf", tarball])
    .split("\n")
    .filter(Boolean)
    .map((name) => [name, run("tar", ["-xzOf", tarball, name], { encoding: "buffer" })]);
}

const PACKAGES = [
  {
    kind: "sdk",
    filter: "@fairux/sdk",
    manifest: "packages/sdk/package.json",
    tagPrefix: "sdk-v",
    entry: "package/dist/dom.js",
    audit: (tarball, tag) =>
      node(["packages/sdk/scripts/release-check.mjs", "--tag", tag], {
        env: { ...process.env, TARBALL: tarball },
      }),
  },
  {
    kind: "cli",
    filter: "fairux",
    manifest: "apps/cli/package.json",
    tagPrefix: "v",
    entry: "package/dist/index.js",
    audit: (tarball) =>
      node(["apps/cli/scripts/audit-packed-tarball.mjs"], {
        env: { ...process.env, TARBALL: tarball },
      }),
  },
];

const workspace = mkdtempSync(join(tmpdir(), "fairux-artifact-"));
try {
  for (const pkg of PACKAGES) {
    const manifest = JSON.parse(readFileSync(join(repoRoot, pkg.manifest), "utf8"));
    const tag = `${pkg.tagPrefix}${manifest.version}`;
    const commit = "0".repeat(40);
    const packDir = join(workspace, `${pkg.kind}-pack`);
    mkdirSync(packDir, { recursive: true });

    run("pnpm", ["--filter", pkg.filter, "pack", "--pack-destination", packDir]);
    const packed = join(
      packDir,
      `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`,
    );

    const bundle = join(workspace, `${pkg.kind}-bundle`);
    node([
      "scripts/assemble-release-bundle.mjs",
      "--kind",
      pkg.kind,
      "--tarball",
      packed,
      "--manifest",
      pkg.manifest,
      "--tag",
      tag,
      "--commit",
      commit,
      "--out",
      bundle,
    ]);

    const inBundle = join(
      bundle,
      `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`,
    );

    try {
      node([
        "scripts/verify-release-bundle.mjs",
        "--kind",
        pkg.kind,
        "--bundle",
        bundle,
        "--tag",
        tag,
        "--commit",
        commit,
        "--package-json",
        pkg.manifest,
      ]);
      pkg.audit(inBundle, tag);
      ok(`[${pkg.kind}] pack → assemble → verify → trusted audit, on the real artifact`);
    } catch (error) {
      bad(
        `[${pkg.kind}] the real artifact failed its own chain — ${String(error.stderr || error.message).slice(0, 400)}`,
      );
      continue;
    }

    // --- Negatives, each built from the artifact that just passed ------------------------------
    const members = readMembers(inBundle);
    const patchManifest = (patch) =>
      members.map(([name, bytes]) =>
        name === "package/package.json"
          ? [name, Buffer.from(JSON.stringify(patch(JSON.parse(bytes.toString("utf8"))), null, 2))]
          : [name, bytes],
      );

    const negatives = [
      [
        "a duplicate member whose first copy is an empty comment",
        // `tar -xzOf` concatenates both copies, so the auditor reads `//import "node:fs";` while
        // extraction keeps the second. Caught by uniqueness, not by reading content.
        [
          ...members.map(([name, bytes]) =>
            name === pkg.entry ? [name, Buffer.from("//")] : [name, bytes],
          ),
          [pkg.entry, Buffer.from('import "node:fs";\nexport const x = 1;\n')],
        ],
      ],
      [
        "a dot-segment alias for the entry point",
        [
          ...members,
          [
            pkg.entry.replace(/\/([^/]+)$/, "/./$1"),
            Buffer.from('import "node:fs";\nexport const x = 1;\n'),
          ],
        ],
      ],
      [
        "a member colliding only by case",
        [
          ...members,
          [
            pkg.entry.replace(/\/([^/]+)$/, (_, file) => `/${file.toUpperCase()}`),
            Buffer.from("1"),
          ],
        ],
      ],
      [
        "os/cpu/libc/bundleDependencies injected into the manifest",
        patchManifest((m) => ({
          ...m,
          os: ["!darwin"],
          cpu: ["!arm64"],
          libc: ["glibc"],
          bundleDependencies: ["evil"],
        })),
      ],
      [
        "a prepublish script, which npm still runs on install",
        patchManifest((m) => ({ ...m, scripts: { ...m.scripts, prepublish: "node evil.mjs" } })),
      ],
      [
        "a postinstall script",
        patchManifest((m) => ({ ...m, scripts: { ...m.scripts, postinstall: "node evil.mjs" } })),
      ],
    ];

    if (pkg.kind === "sdk") {
      negatives.push([
        "a comment-obfuscated dynamic import in the browser entry",
        members.map(([name, bytes]) =>
          name === pkg.entry
            ? [name, Buffer.from('export const x = import(/* webpackIgnore: true */ "node:fs");\n')]
            : [name, bytes],
        ),
      ]);
    }

    for (const [label, memberList] of negatives) {
      const crafted = join(workspace, `${pkg.kind}-negative.tgz`);
      writeTarball(crafted, memberList);
      let accepted = false;
      try {
        pkg.audit(crafted, tag);
        accepted = true;
      } catch {
        // expected
      }
      if (accepted) {
        bad(`[${pkg.kind}] the trusted audit ACCEPTED ${label}`);
      } else {
        ok(`[${pkg.kind}] rejected: ${label}`);
      }
    }
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

console.log(
  failed ? "\n✗ packed artifact contract FAILED" : "\n✓ packed artifact contract verified",
);
process.exitCode = failed ? 1 : 0;

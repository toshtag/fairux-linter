#!/usr/bin/env node
/**
 * The non-secret facts an outside reviewer would otherwise have to assemble by hand.
 *
 * [The security review packet](../docs/maintainers/security-review.md) says what to look at and why.
 * This says what the tree *is* at the commit being reviewed: the commit itself, the published
 * versions and what their tarballs contain, the lockfile's identity, every workflow with its
 * triggers and permissions, every action and the commit it is pinned to, and the exact commands the
 * repository's own gate runs.
 *
 * Written rather than pasted because a packet that restates any of it starts going stale the moment
 * it is written, and a reviewer who has been handed a stale inventory has been handed a wrong one.
 * Every value here is read from the tree; nothing is a copy somebody maintains.
 *
 *     pnpm review:evidence              # to stdout
 *     pnpm review:evidence -- --out ./review-evidence.json
 *
 * **Nothing secret, and nothing local.** No environment variables, no absolute paths, no `.npmrc`,
 * no tokens, no user data. `tests/unit/review-evidence.test.ts` fails the run if an absolute path
 * or a home directory reaches the output — the check has to be mechanical, because "I did not
 * include anything sensitive" is exactly the claim a person gets wrong once.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { VERIFY_FULL_STEPS } from "./verify-full-contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = join(ROOT, ".github/workflows");

function readJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
}

/**
 * `git`, for the two facts that place a review in time.
 *
 * A reviewer's findings are about a tree. Without the commit they are about "FairUX", which is not
 * something anyone can fix — and without the dirty flag, a review of somebody's uncommitted work
 * would be recorded against a commit that never contained it.
 */
function commit() {
  const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  return {
    sha: git(["rev-parse", "HEAD"]),
    // Not the branch: a branch name is a label that moves, and a review is of a tree.
    committedAt: git(["show", "-s", "--format=%cI", "HEAD"]),
    worktreeClean: git(["status", "--porcelain"]) === "",
  };
}

/** The packages a consumer can install, and what each one says it ships. */
function publishedPackages() {
  const found = [];
  for (const directory of ["apps/cli", "packages/sdk"]) {
    const manifest = readJson(`${directory}/package.json`);
    found.push({
      directory,
      name: manifest.name,
      version: manifest.version,
      engines: manifest.engines,
      files: manifest.files,
      bin: manifest.bin ?? null,
      dependencies: Object.keys(manifest.dependencies ?? {}).sort(),
    });
  }
  return found;
}

/**
 * Every workflow, with what starts it and what it is allowed to do.
 *
 * Triggers and permissions together, because neither answers the question on its own: a workflow
 * with `contents: write` that only runs on a tag is a different risk from the same permissions on a
 * pull request, and the pair is what a reviewer reads first.
 */
function workflows() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => {
      const parsed = parse(readFileSync(join(WORKFLOW_DIR, name), "utf8")) ?? {};
      const jobs = Object.entries(parsed.jobs ?? {});
      return {
        file: name,
        // The parsed `on:` block, branches, paths, and cron included. Read from the document rather
        // than matched out of it: a regular expression over indented keys cannot tell a trigger from
        // a job that happens to be called `push`, and a security packet carrying wrong triggers is
        // worse than one carrying none.
        triggers: parsed.on ?? null,
        permissions: parsed.permissions ?? null,
        jobs: jobs.map(([job, definition]) => ({
          name: job,
          runsOn: definition?.["runs-on"] ?? null,
          permissions: definition?.permissions ?? null,
          environment: definition?.environment ?? null,
        })),
      };
    });
}

/** Every action used anywhere, with the commit it is pinned to and the tag comment beside it. */
function actionPins() {
  const pins = new Map();
  for (const name of readdirSync(WORKFLOW_DIR).filter((file) => file.endsWith(".yml"))) {
    const text = readFileSync(join(WORKFLOW_DIR, name), "utf8");
    for (const match of text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+?)@(\S+)(?:\s+#\s*(.*?))?\s*$/gm)) {
      const [, action, ref, comment] = match;
      const key = `${action}@${ref}`;
      const entry = pins.get(key) ?? {
        action,
        ref,
        comment: comment ?? null,
        pinnedBySha: /^[0-9a-f]{40}$/.test(ref),
        usedIn: [],
      };
      entry.usedIn.push(name);
      pins.set(key, entry);
    }
  }
  return [...pins.values()]
    .map((entry) => ({ ...entry, usedIn: [...new Set(entry.usedIn)].sort() }))
    .sort((left, right) => (left.action < right.action ? -1 : 1));
}

/** The generated artifacts that describe a public surface, by digest. */
function surfaceArtifacts() {
  return ["sdk-api-inventory.json", "cli-surface-inventory.json", "rule-catalog.json"]
    .map((name) => `docs/generated/${name}`)
    .map((path) => ({
      path,
      sha256: createHash("sha256")
        .update(readFileSync(join(ROOT, path)))
        .digest("hex"),
    }));
}

export function collect() {
  const rootManifest = readJson("package.json");
  return {
    schemaVersion: 1,
    note: "Non-secret facts about one commit, for an independent security review. Generated by scripts/collect-review-evidence.mjs.",
    commit: commit(),
    toolchain: {
      packageManager: rootManifest.packageManager,
      engines: rootManifest.engines,
      nodeVersionFile: readFileSync(join(ROOT, ".node-version"), "utf8").trim(),
      lockfileSha256: createHash("sha256")
        .update(readFileSync(join(ROOT, "pnpm-lock.yaml")))
        .digest("hex"),
    },
    publishedPackages: publishedPackages(),
    workflows: workflows(),
    actionPins: actionPins(),
    surfaceArtifacts: surfaceArtifacts(),
    // From the gate's own declaration, so a reviewer running "everything this repository runs" runs
    // what it actually runs. A list typed into the packet would be a second copy of this one.
    verification: {
      command: "pnpm verify:full",
      steps: VERIFY_FULL_STEPS.map((step) => ({ script: step.script, covers: step.why })),
    },
  };
}

function main() {
  const argv = process.argv.slice(2).filter((argument) => argument !== "--");
  const outIndex = argv.indexOf("--out");
  const evidence = collect();
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;

  if (outIndex >= 0) {
    const target = argv[outIndex + 1];
    if (!target) {
      process.stderr.write("review evidence: --out needs a path\n");
      process.exitCode = 2;
      return;
    }
    writeFileSync(target, serialized, "utf8");
    process.stderr.write(`review evidence: wrote ${target}\n`);
    return;
  }
  process.stdout.write(serialized);
}

const thisFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFilePath) main();

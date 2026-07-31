#!/usr/bin/env node
/**
 * Assert that the release tag still names the commit this run is building.
 *
 * Runs twice in the privileged publish job, immediately before each irreversible outward step:
 * once before `npm publish`, to protect the package's source identity, and once before the GitHub
 * Release, to protect the identity of the tag that Release is attached to. The gap between them is
 * a publish plus two registry reads, and the gap before the first is however long the environment's
 * required reviewer takes — so a single check at the top of the job would be a check about a
 * different moment than the one it guards.
 *
 * The concrete failure it closes: `gh release create <tag>` creates the tag when it is missing,
 * from the default branch's current head. Without this, a tag deleted mid-run would produce an npm
 * package built from `TAG_COMMIT` sitting beside a GitHub Release tag pointing at `main`.
 * `--verify-tag` on `gh release` refuses that too; this refuses earlier, and additionally catches
 * the force-moved case that `--verify-tag` cannot see.
 *
 * `git ls-remote` is invoked with the tag as an argv element, never through a shell. Git permits
 * `"`, `$`, `;`, and a backtick in a ref name, so a tag is data here.
 *
 * Node built-ins and `git` only: no install, no network beyond the fetch git itself performs.
 */
import { execFileSync } from "node:child_process";
import { CliReleaseTagError, verifyRemoteTagCommit } from "./release-tag-contract.mjs";

const USAGE = "Usage: verify-cli-release-tag.mjs --tag <tag> --expected-commit <sha> [--remote origin]";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const tag = option("--tag");
const expectedCommit = option("--expected-commit");
const remote = option("--remote") ?? "origin";

if (!tag || !expectedCommit) {
  console.error(USAGE);
  process.exit(2);
}

let output;
try {
  // Both refs in one call: `refs/tags/<t>` is the tag object for an annotated tag, and
  // `refs/tags/<t>^{}` is the commit it peels to. Asking for only the first would reject every
  // annotated tag, because a tag object's SHA is never its commit's.
  output = execFileSync(
    "git",
    ["ls-remote", "--tags", remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
  );
} catch (error) {
  // A failed read is not a passing check: this guards an irreversible step, so it must go red.
  console.error(`ERROR: could not read ${tag} from ${remote}: ${error.message}`);
  process.exit(1);
}

try {
  const resolved = verifyRemoteTagCommit({ tag, output, expectedCommit });
  console.log(
    `✓ ${tag} on ${remote} names ${resolved.commit}` +
      (resolved.annotated ? " (peeled from an annotated tag)" : ""),
  );
} catch (error) {
  console.error(
    error instanceof CliReleaseTagError ? `ERROR: ${error.message}` : `ERROR: ${error.message}`,
  );
  process.exit(1);
}

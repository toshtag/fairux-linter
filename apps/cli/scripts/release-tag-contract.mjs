/**
 * What `git ls-remote` says the release tag points at — decided from its output, not from a shell.
 *
 * The workflow is triggered by a tag push, and `github.sha` is the commit that tag named *at that
 * moment*. Between then and the privileged job — which waits on an environment reviewer, so the gap
 * is however long a human takes — the tag can be deleted or force-moved. Two things then go wrong,
 * and only one of them is obvious:
 *
 * - `gh release create <tag>` **creates the tag** when it does not exist, from the default branch's
 *   current head. A release whose npm package was built from `TAG_COMMIT` would be published beside
 *   a GitHub Release tag pointing at whatever `main` happened to be. `--verify-tag` is the flag that
 *   refuses instead, and it is set on both `create` and `edit`.
 * - Nothing else in the run re-reads the tag at all, so a force-moved tag is simply not noticed.
 *
 * This module is the parser. It takes `git ls-remote --tags` output as text and answers what commit
 * the tag resolves to, or refuses. It runs no command and interpolates nothing into a shell: the
 * caller passes the tag as an argv element, and a tag containing `"`, `$`, `;`, or a backtick — all
 * of which git permits in a ref name — is data here rather than syntax.
 *
 * Annotated tags are the reason this is not a one-line comparison. `git ls-remote --tags` reports an
 * annotated tag twice: `refs/tags/<t>` is the tag *object*, and `refs/tags/<t>^{}` is the commit it
 * peels to. Comparing against the first would reject every annotated tag, because a tag object's
 * SHA is never the commit's.
 */

const LS_REMOTE_LINE = /^([0-9a-f]{40})\t(\S+)$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

export class CliReleaseTagError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliReleaseTagError";
  }
}

/**
 * Resolve one tag from `git ls-remote --tags origin refs/tags/<t> refs/tags/<t>^{}` output.
 *
 * @param {object} input
 * @param {string} input.tag
 * @param {string} input.output  raw stdout
 * @returns {{commit: string, annotated: boolean}}
 * @throws {CliReleaseTagError} when the tag is absent, duplicated, or the output is malformed
 */
export function resolveRemoteTag({ tag, output }) {
  if (typeof tag !== "string" || tag === "") {
    throw new CliReleaseTagError("release tag is missing");
  }
  if (typeof output !== "string") {
    throw new CliReleaseTagError("git ls-remote produced no output to read");
  }

  const direct = `refs/tags/${tag}`;
  const peeled = `${direct}^{}`;

  /** @type {Map<string, string[]>} */
  const refs = new Map();
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const match = LS_REMOTE_LINE.exec(line);
    if (!match) {
      // A line that is not `<sha>\t<ref>` means this is not the output this parser understands.
      // Skipping it would be deciding that whatever git said does not matter.
      throw new CliReleaseTagError(`git ls-remote produced a line this cannot read: ${line}`);
    }
    const [, sha, ref] = match;
    // Refs are filtered by the caller's arguments, but git may still report others; anything that
    // is not one of the two this asked about is ignored rather than treated as a candidate.
    if (ref !== direct && ref !== peeled) continue;
    refs.set(ref, [...(refs.get(ref) ?? []), /** @type {string} */ (sha)]);
  }

  for (const [ref, shas] of refs) {
    const distinct = [...new Set(shas)];
    if (distinct.length > 1) {
      throw new CliReleaseTagError(
        `${ref} resolves to more than one commit on origin: ${distinct.sort().join(", ")}`,
      );
    }
  }

  const peeledSha = refs.get(peeled)?.[0];
  const directSha = refs.get(direct)?.[0];

  if (peeledSha !== undefined) return { commit: peeledSha, annotated: true };
  if (directSha !== undefined) return { commit: directSha, annotated: false };

  throw new CliReleaseTagError(
    `tag ${tag} does not exist on origin. It was deleted or renamed after this run started; ` +
      "publishing now would attach a release to a tag that no longer names this commit.",
  );
}

/**
 * Resolve the tag and require it to name an exact commit.
 *
 * @param {object} input
 * @param {string} input.tag
 * @param {string} input.output
 * @param {string} input.expectedCommit  the commit the tag named when the workflow was triggered
 * @returns {{commit: string, annotated: boolean}}
 */
export function verifyRemoteTagCommit({ tag, output, expectedCommit }) {
  if (typeof expectedCommit !== "string" || !COMMIT_SHA.test(expectedCommit)) {
    throw new CliReleaseTagError(
      `expected commit must be a full 40-hex SHA, got ${JSON.stringify(expectedCommit)}`,
    );
  }

  const resolved = resolveRemoteTag({ tag, output });
  if (resolved.commit !== expectedCommit) {
    throw new CliReleaseTagError(
      [
        `tag ${tag} no longer names the commit this run is building.`,
        `Expected: ${expectedCommit}`,
        `On origin: ${resolved.commit}${resolved.annotated ? " (peeled from an annotated tag)" : ""}`,
        "The tag was force-moved after this run started. The artifact was built from the expected",
        "commit, so publishing now would put a package and a GitHub Release under one tag that",
        "names two different sources.",
      ].join("\n"),
    );
  }
  return resolved;
}

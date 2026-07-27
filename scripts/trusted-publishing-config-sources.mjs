/**
 * Collect every npm config file that applies to a publish.
 *
 * npm layers project over user over global. An earlier version of the preflight read only the user
 * config, so the exact placeholder that broke run 30233771956 passed when it sat at the repository
 * root instead. Splitting the collection out of the entrypoint is what makes that regression
 * testable: with the filesystem and `npm config get` injected, a test can assert the collector
 * really consults all three, rather than only asserting on sources handed to it.
 *
 * Nothing here inspects contents — that is `trusted-publishing-contract.mjs`'s job — and no error
 * message includes them.
 */

/**
 * @param {object} deps
 * @param {string} deps.cwd  the directory `npm publish` will run in
 * @param {(key: string) => string} deps.npmConfigGet  `npm config get <key>`
 * @param {(path: string) => string} deps.readFile  reads UTF-8, throws with a `.code`
 * @param {(path: string) => string} deps.resolvePath  absolute-path resolver
 * @returns {Array<{kind: "project"|"user"|"global", path: string, contents: string}>}
 */
export function collectNpmConfigSources({ cwd, npmConfigGet, readFile, resolvePath }) {
  // Project first: on a duplicate path the earlier, more specific kind is what gets reported.
  const candidates = [
    ["project", resolvePath(`${cwd}/.npmrc`)],
    ["user", npmConfigGet("userconfig")],
    ["global", npmConfigGet("globalconfig")],
  ];

  const sources = [];
  const seen = new Set();

  for (const [kind, rawPath] of candidates) {
    if (!rawPath || rawPath === "undefined" || rawPath === "null") continue;
    const path = resolvePath(rawPath);
    if (seen.has(path)) continue;
    seen.add(path);

    let contents;
    try {
      contents = readFile(path);
    } catch (error) {
      // Absent is a legitimate answer. Anything else is a config we cannot clear, and passing on
      // it would be the fail-open this check exists to prevent.
      if (error?.code === "ENOENT") continue;
      throw new Error(
        `Cannot read the ${kind} npm config at ${path}: ${error?.code ?? "unknown error"}. ` +
          "Refusing to publish rather than assume it holds no credential.",
        { cause: error },
      );
    }
    sources.push({ kind, path, contents });
  }

  return sources;
}

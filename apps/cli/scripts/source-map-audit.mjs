/**
 * What `fairux`'s published source map may contain.
 *
 * The CLI ships `dist/index.js.map`; the SDK ships no map at all. That difference is why this is a
 * separate auditor rather than a call into `packages/sdk/scripts/source-map-audit.mjs`, and the
 * difference is in the rules, not the wiring: the SDK's auditor rejects any `sources` entry that
 * resolves inside the build repository, because for a package that publishes no map, a repository
 * path in one is a leak. For the CLI a repository-relative path is the *point* — it is what makes a
 * stack trace from an installed `fairux` point at a file a maintainer can open. Sharing one module
 * would have meant weakening that rule for both packages or parameterising it until it said nothing.
 *
 * The policy this file encodes, decided in the M1-R1 release readiness audit:
 *
 * - **`sourcesContent` must be empty.** The published map carried 11 non-empty entries, about
 *   218 KB, including `apps/cli/src/*.ts` — source the SDK's own auditor refuses outright. The
 *   repository is public and Apache-2.0, so this was never a disclosure incident; it was two
 *   publishable packages in one repository held to opposite policies with neither written down.
 *   `sources` and `mappings` stay, so paths and positions still resolve.
 * - **Every source path stays inside the repository.** A map is published bytes: a path that
 *   escapes the repository names a machine that built it, and one that is absolute names it
 *   outright.
 * - **No absolute path, no `file://`, nothing that reads as a credential or an environment file.**
 *
 * Pure: string and path math only, no filesystem and no network, so the same function audits the
 * built map in the workspace and the packed map inside a tarball.
 */

/** Where the CLI's map sits, relative to the repository root, when it is built in place. */
export const CLI_SOURCE_MAP_DIR = "apps/cli/dist";

/**
 * Paths that must never appear in a published map, whatever they resolve to.
 *
 * Deliberately narrower than the SDK's list: `packages/*​/src` is absent, because the CLI inlines
 * its workspace siblings and their sources are legitimate entries here.
 */
const REJECTED_SOURCE_PATTERNS = Object.freeze([
  { pattern: /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, label: "a URL" },
  { pattern: /(^|\/)\.env($|[./_-])/, label: "an environment file" },
  { pattern: /(^|\/)\.npmrc($|\/)/, label: "an npm config file" },
  { pattern: /(^|\/)secrets?($|[./_-])/i, label: "a secret path" },
  { pattern: /workspace:/, label: "a workspace protocol specifier" },
]);

/** Windows drive letters and UNC paths, which `node:path/posix` does not treat as absolute. */
const WINDOWS_ABSOLUTE = /^([A-Za-z]:[\\/]|\\\\)/;

/**
 * Resolve a `/`-separated relative path against a `/`-separated base, without touching the disk.
 *
 * `node:path`'s resolver anchors on the process working directory, which would make the verdict
 * depend on where the auditor was invoked from — the privileged publish job runs it from a
 * different directory than `pnpm pack:smoke` does. This is pure segment arithmetic instead, and it
 * returns `null` for a path that climbs above the base, which is the answer the caller wants.
 */
function resolveWithin(base, source) {
  const segments = base === "" ? [] : base.split("/").filter((part) => part !== "");
  for (const part of source.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join("/");
}

/**
 * @param {string} entry  how the map is named in failure messages
 * @param {string} text   the map's bytes, as UTF-8
 * @param {{mapDir?: string}} [options]  where the map sits relative to the repository root
 * @returns {string[]} failures; empty means the map satisfies the policy
 */
export function auditCliSourceMap(entry, text, options = {}) {
  const mapDir = options.mapDir ?? CLI_SOURCE_MAP_DIR;
  const failures = [];

  let map;
  try {
    map = JSON.parse(text);
  } catch (error) {
    return [`${entry}: source map is not valid JSON (${error.message})`];
  }
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    return [`${entry}: source map is not an object`];
  }

  if (map.version !== 3) {
    failures.push(`${entry}: source map version must be 3, got ${JSON.stringify(map.version)}`);
  }

  // The map has to still be a map. Stripping `sourcesContent` by emitting an empty shell would
  // satisfy every rule below and give a debugger nothing to work with.
  if (typeof map.mappings !== "string" || map.mappings === "") {
    failures.push(`${entry}: source map has no mappings`);
  }
  if (!Array.isArray(map.sources) || map.sources.length === 0) {
    failures.push(`${entry}: source map lists no sources`);
  }

  // Absent is the intended shape — `sourcemapExcludeSources` omits the key entirely. An array of
  // nulls or empty strings is accepted rather than required to be absent: it carries no source.
  if (map.sourcesContent !== undefined) {
    if (!Array.isArray(map.sourcesContent)) {
      failures.push(`${entry}: sourcesContent must be absent or an array`);
    } else {
      for (const [index, content] of map.sourcesContent.entries()) {
        if (typeof content === "string" && content.length > 0) {
          failures.push(
            `${entry}: sourcesContent[${index}] embeds ${content.length} bytes of source; the ` +
              "published map carries paths, not code",
          );
        }
      }
    }
  }

  for (const [index, source] of (Array.isArray(map.sources) ? map.sources : []).entries()) {
    if (typeof source !== "string" || source === "") {
      failures.push(`${entry}: sources[${index}] is not a non-empty string`);
      continue;
    }

    // Normalised for inspection only; every message quotes what the map actually says.
    const normalized = source.replaceAll("\\", "/");

    if (normalized.startsWith("/") || WINDOWS_ABSOLUTE.test(source)) {
      failures.push(`${entry}: sources[${index}] is an absolute path: ${source}`);
      continue;
    }

    let rejected = false;
    for (const { pattern, label } of REJECTED_SOURCE_PATTERNS) {
      if (pattern.test(normalized)) {
        failures.push(`${entry}: sources[${index}] looks like ${label}: ${source}`);
        rejected = true;
        break;
      }
    }
    if (rejected) continue;

    if (resolveWithin(mapDir, normalized) === null) {
      failures.push(`${entry}: sources[${index}] escapes the repository from ${mapDir}: ${source}`);
    }
  }

  return failures;
}

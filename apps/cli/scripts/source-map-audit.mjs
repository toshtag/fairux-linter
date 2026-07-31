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
 * The policy, decided in the M1-R1 release readiness audit:
 *
 * - **`sourcesContent` must carry nothing.** The published map had 11 non-empty entries, about
 *   218 KB, including `apps/cli/src/*.ts` — source the SDK's own auditor refuses outright. The
 *   repository is public and Apache-2.0, so this was never a disclosure incident; it was two
 *   publishable packages in one repository held to opposite policies with neither written down.
 *   `sources` and `mappings` stay, so paths and positions still resolve.
 * - **Every source location stays inside the repository, and is a path.** A map is published
 *   bytes: a location that escapes the repository names a machine that built it, and one carrying
 *   a URI scheme is not a repository path at all.
 *
 * The first version of this checked `map.sources` and nothing else, which let four whole classes
 * through — all reproduced against it:
 *
 *     sourceRoot: "../../../../"                        → passed
 *     sourceRoot: "file:///private/tmp/"                → passed
 *     sources: ["data:application/typescript;base64,…"] → passed
 *     sourcesContent: [{ code: "embedded" }]            → passed
 *
 * `sourceRoot` is prepended to every `sources` entry, so auditing `sources` alone audits a value
 * the consumer never uses. The URI test required `://`, so every `scheme:opaque` form — `data:`,
 * `node:`, `file:relative` — read as an ordinary relative path. And the `sourcesContent` rule only
 * looked at non-empty *strings*, so any other type was ignored. Each of those is now the effective
 * value's problem rather than the raw value's.
 *
 * A later round found the same gap in the path grammar itself. This auditor treats every value as
 * a repository filesystem path, and a NUL, a newline, a tab, a `?`, or a `#` inside one is not a
 * path a consumer resolves: `../../src/a.ts?query=1` names a file called `a.ts?query=1`. Refusing
 * them is what makes the escape check meaningful, rather than something run against a value that
 * was never a path.
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
  { pattern: /(^|\/)\.env($|[./_-])/, label: "an environment file" },
  { pattern: /(^|\/)\.npmrc($|\/)/, label: "an npm config file" },
  { pattern: /(^|\/)secrets?($|[./_-])/i, label: "a secret path" },
  { pattern: /workspace:/, label: "a workspace protocol specifier" },
]);

/**
 * Any URI, not only the `scheme://` forms.
 *
 * The previous `^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/` caught `https://` and `file:///` and missed
 * `data:application/typescript;base64,…`, `node:fs`, and `file:../../source.ts` — the opaque forms,
 * which are the ones that carry a payload rather than a location.
 *
 * A Windows path is not a URI even though `C:\…` matches a scheme grammar, so drive letters are
 * excluded here and reported as absolute paths instead, which is what they are.
 */
const URI_SCHEME = /^(?![A-Za-z]:[\\/])[A-Za-z][A-Za-z0-9+.-]*:/;

/** Windows drive letters and UNC paths, which POSIX path rules do not treat as absolute. */
const WINDOWS_ABSOLUTE = /^([A-Za-z]:[\\/]|\\\\)/;

/**
 * Whether a published path carries a character a filesystem path may not.
 *
 * C0 controls, DEL, and the Unicode line and paragraph separators. This auditor's whole model is
 * "these values are repository paths", and a NUL, a newline, or a tab inside one is not a path a
 * consumer resolves — it is a value that will be truncated, split across a log line, or misread by
 * whatever reads the map next. Refusing them is what makes the rest of the audit's reasoning
 * apply; passing them through would mean the escape check had been run on something that is not a
 * path at all.
 *
 * A code-point scan rather than a character class, for the same reason `release-notes.mjs` uses
 * one: a regex literal containing control characters is unreadable in review and is what
 * `noControlCharactersInRegex` exists to stop.
 */
function hasForbiddenPathCharacter(value) {
  for (const character of value) {
    const code = /** @type {number} */ (character.codePointAt(0));
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/**
 * A URL's query and fragment, which a filesystem path has no room for.
 *
 * The values here are resolved as paths, so `../../src/a.ts?query=1` names a file called
 * `a.ts?query=1` — and `#fragment` names one ending in a fragment. Neither is something the CLI's
 * build emits or a debugger needs, and treating either as part of a filename is exactly the kind
 * of "well, it resolved to something" that a fail-closed audit must not do.
 */
const URL_QUERY_OR_FRAGMENT = /[?#]/;

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
 * Percent-decode a source-map location, or report that it cannot be decoded.
 *
 * Map locations are URLs, so `..%2f..%2foutside.ts` is a traversal a byte comparison does not see.
 * Both the raw and the decoded form are audited: decoding first alone would miss a raw `..`, and
 * auditing raw alone misses the encoded one.
 *
 * @returns {{decoded: string} | {error: string}}
 */
function percentDecode(value) {
  if (!value.includes("%")) return { decoded: value };
  try {
    return { decoded: decodeURIComponent(value) };
  } catch {
    return { error: "is not decodable as a URL" };
  }
}

/**
 * Audit one location — a `sourceRoot`, a `sources` entry, or the two joined — as a path.
 *
 * @param {string} value
 * @param {string} mapDir  when given, the value must also resolve inside the repository from here
 * @returns {string | null} why it is refused, or `null` when it is acceptable
 */
function locationFailure(value, mapDir) {
  const forms = [value];
  const { decoded, error } = percentDecode(value);
  if (error) return error;
  if (decoded !== value) forms.push(decoded);

  for (const form of forms) {
    const normalized = form.replaceAll("\\", "/");
    if (hasForbiddenPathCharacter(form)) {
      // Escaped, because printing the raw value would put the control character into the log this
      // message exists to be read in.
      return `contains a control character (${JSON.stringify(form)})`;
    }
    if (URI_SCHEME.test(form)) return "carries a URI scheme";
    if (URL_QUERY_OR_FRAGMENT.test(form)) return "carries a URL query or fragment";
    if (normalized.startsWith("/") || WINDOWS_ABSOLUTE.test(form)) return "is an absolute path";
    for (const { pattern, label } of REJECTED_SOURCE_PATTERNS) {
      if (pattern.test(normalized)) return `looks like ${label}`;
    }
    if (mapDir !== undefined && resolveWithin(mapDir, normalized) === null) {
      return `escapes the repository from ${mapDir}`;
    }
  }
  return null;
}

/**
 * `sourceRoot` is prepended to each `sources` entry, with a `/` between them when it lacks one.
 *
 * The joined value is what a consumer resolves, so it is what the escape check has to run on:
 * `sourceRoot: "../.."` and `source: "../outside.ts"` are each harmless and together are not.
 */
function joinSourceRoot(sourceRoot, source) {
  if (sourceRoot === "") return source;
  return sourceRoot.endsWith("/") ? `${sourceRoot}${source}` : `${sourceRoot}/${source}`;
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

  // --- sourceRoot, which every source entry inherits ------------------------------------------
  let sourceRoot = "";
  if (map.sourceRoot !== undefined) {
    if (typeof map.sourceRoot !== "string") {
      failures.push(
        `${entry}: sourceRoot must be a string when present, got ${typeof map.sourceRoot}`,
      );
    } else if (map.sourceRoot !== "") {
      // Audited on its own as well as joined: a `sourceRoot` that is a `file://` URL or an absolute
      // path is wrong whatever the sources beside it happen to be.
      const failure = locationFailure(map.sourceRoot, mapDir);
      if (failure) {
        failures.push(`${entry}: sourceRoot ${failure}: ${map.sourceRoot}`);
      } else {
        sourceRoot = map.sourceRoot;
      }
    }
  }

  // --- sourcesContent: null or empty, and one entry per source --------------------------------
  // Absent is the intended shape — `sourcemapExcludeSources` omits the key entirely. Anything present
  // must carry nothing, and must not be some other type: the previous rule only inspected non-empty
  // strings, so `[{ code: "embedded" }]` passed.
  if (map.sourcesContent !== undefined) {
    if (!Array.isArray(map.sourcesContent)) {
      failures.push(`${entry}: sourcesContent must be absent or an array`);
    } else {
      for (const [index, content] of map.sourcesContent.entries()) {
        if (content === null || content === "") continue;
        const described =
          typeof content === "string"
            ? `${content.length} bytes of source`
            : `a ${Array.isArray(content) ? "array" : typeof content}`;
        failures.push(
          `${entry}: sourcesContent[${index}] must be null or an empty string, got ${described}; ` +
            "the published map carries paths, not code",
        );
      }
      // A short or long array leaves the entry-to-source correspondence ambiguous, which is how a
      // partially-populated array could look like a fully-empty one.
      if (Array.isArray(map.sources) && map.sourcesContent.length !== map.sources.length) {
        failures.push(
          `${entry}: sourcesContent has ${map.sourcesContent.length} entries for ` +
            `${map.sources.length} sources`,
        );
      }
    }
  }

  // --- sources, raw and as the consumer resolves them ------------------------------------------
  for (const [index, source] of (Array.isArray(map.sources) ? map.sources : []).entries()) {
    if (typeof source !== "string" || source === "") {
      failures.push(`${entry}: sources[${index}] is not a non-empty string`);
      continue;
    }

    // The entry on its own first, so the message names what is actually written in the map.
    const own = locationFailure(source, undefined);
    if (own) {
      failures.push(`${entry}: sources[${index}] ${own}: ${source}`);
      continue;
    }

    // Then the value a consumer resolves. `sourceRoot` is "" when absent or already refused above,
    // so a bad root is reported once rather than again for every source under it.
    const effective = joinSourceRoot(sourceRoot, source);
    const joined = locationFailure(effective, mapDir);
    if (joined) {
      failures.push(
        `${entry}: sources[${index}] ${joined}: sourceRoot=${JSON.stringify(sourceRoot)}, ` +
          `source=${JSON.stringify(source)}`,
      );
    }
  }

  return failures;
}

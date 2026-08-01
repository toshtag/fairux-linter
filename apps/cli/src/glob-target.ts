/**
 * How a scan target is recognised as a glob pattern, and what form that pattern has to be in
 * before it reaches the expander.
 *
 * This is separate from expansion for two reasons. The rules are platform-dependent and the tests
 * have to state which platform they are describing, so every function here takes the platform as an
 * argument rather than reading `process.platform` at the point of decision. And the same rules are
 * needed twice per scan — once to expand the pattern, once to decide where config discovery starts
 * from — so they cannot live inside either caller.
 *
 * The Windows rule is a relaxation, not a normalisation: `\` stops meaning "escape the next
 * character" only on `win32`, where the character it would escape cannot appear in a filename
 * anyway, and where neither `cmd.exe` nor PowerShell expands a glob before the CLI sees it.
 */

/** Characters that make a target a pattern rather than a literal path. */
const GLOB_CHARS = new Set(["*", "?", "[", "{"]);

/**
 * Index of the first character that makes `pattern` a glob, or `-1` when there is none.
 *
 * @param pattern a scan target as the user typed it
 */
export function globMagicIndex(pattern: string): number {
  return [...pattern].findIndex((character) => GLOB_CHARS.has(character));
}

/**
 * Whether a target is a glob pattern at all.
 *
 * This says nothing about whether it matches: an existing file whose name contains glob magic is
 * still a literal target, and the caller settles that by checking the filesystem first.
 *
 * @param pattern a scan target as the user typed it
 */
export function isGlobPattern(pattern: string): boolean {
  return globMagicIndex(pattern) >= 0;
}

/**
 * Whether a Windows target names a UNC share (`\\server\share\…`), a device (`\\.\…`), or an
 * extended-length path (`\\?\…`) — the three forms that start with two separators.
 *
 * Only meaningful on `win32`. A POSIX path beginning `//` is an ordinary absolute path, and
 * collapsing it would change which file the pattern names.
 *
 * @param target a scan target as the user typed it
 * @param platform the platform whose rules apply
 */
export function isUncPattern(target: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  return /^[\\/]{2}[^\\/]/.test(target);
}

/**
 * The form of `pattern` the glob expander understands.
 *
 * On `win32` a backslash is translated to a forward slash, so `inputs\*.html` — the form a Windows
 * user types, and the form the shell hands over untouched — names the same files as the portable
 * `inputs/*.html`. Nothing is lost by the translation: `*`, `?`, `[`, `{`, and `\` itself cannot
 * appear in a Windows filename, so there is no name on that platform that backslash-escaping could
 * have expressed and this cannot.
 *
 * Everywhere else the pattern is returned unchanged, because there a backslash is a meaningful
 * escape character and `a\*.html` names the single file `a*.html`.
 *
 * UNC, device, and extended-length patterns are *not* handled here — see {@link isUncPattern}. They
 * are refused by the caller rather than translated, because the expander does not support them and
 * a silent translation would turn "unsupported" into "matched nothing".
 *
 * @param pattern a glob pattern as the user typed it
 * @param platform the platform whose rules apply
 */
export function toPortableGlobPattern(pattern: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return pattern;
  return pattern.replaceAll("\\", "/");
}

/**
 * Sanitize untrusted-input fields for safe Markdown rendering.
 *
 * The Markdown reporter embeds evidence text, locator values, file paths, and
 * descriptions verbatim. A malicious or adversarial input could inject:
 * - C0 control characters (including ANSI escape sequences) that corrupt terminal output
 * - Newlines in paths that break Markdown structure or inject arbitrary lines
 * - Backticks that break out of inline-code spans and inject arbitrary Markdown
 * - Markdown structural characters (|, *, _, #, [, ], >) that could alter the report
 *
 * This module strips/escapes those so the rendered Markdown is safe for untrusted evidence.
 */

const BIDI_CONTROLS = new Set([
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

/** Strip C0 control characters (0x00–0x1F) and Unicode bidi controls. Keeps tab (0x09) and newline (0x0A). */
export function stripControlChars(value: string): string {
  let result = "";
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a) continue;
    if (code === 0x2028 || code === 0x2029) continue;
    if (BIDI_CONTROLS.has(code)) continue;
    result += ch;
  }
  return result;
}

/** Strip newlines (and carriage returns) from values that must stay on a single line (e.g. file paths). */
export function stripNewlines(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

/** Escape backticks so untrusted text can't break out of inline-code spans. */
export function escapeBackticks(value: string): string {
  return value.replace(/`/g, "\\`");
}

/**
 * Sanitize a value that will be rendered inside backticks (inline code).
 * Strips control chars and escapes backticks. Newlines are stripped because
 * inline-code spans are single-line in practice.
 */
export function sanitizeInlineCode(value: string): string {
  return escapeBackticks(stripControlChars(stripNewlines(value)));
}

/**
 * Sanitize a value that will be rendered as plain Markdown text (outside code spans).
 * Strips control chars and escapes Markdown structural characters.
 */
export function sanitizeMarkdownText(value: string): string {
  const stripped = stripControlChars(value);
  // Escape characters that have structural meaning in Markdown:
  // backtick (code span), pipe (table), asterisk/underscore (emphasis),
  // hash (heading), bracket (link), greater-than (blockquote), backslash (escape)
  return stripped.replace(/[`|*_#[\]>\\]/g, (ch) => `\\${ch}`);
}

/** Sanitize a file path for display: strip control chars and newlines. */
export function sanitizePath(value: string): string {
  return stripControlChars(stripNewlines(value));
}

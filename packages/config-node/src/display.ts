export function sanitizeSingleLineDisplay(value: unknown): string {
  const input = value instanceof Error ? value.message : String(value);
  let output = "";

  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    const isLineBreak = code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    const isBidi =
      code === 0x061c ||
      (code >= 0x200e && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);

    if (isLineBreak) {
      output += " ";
      continue;
    }
    if (!isControl && !isBidi) {
      output += ch;
    }
  }

  return output.replace(/\s+/gu, " ").trim();
}

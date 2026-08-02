/**
 * Turning a recorded source range into an edit, without reading a file.
 *
 * This is the piece that decides whether a *built-in* rule can propose a fix at all. An external
 * RulePack is trusted, unsandboxed Node code and can open the file it was pointed at; `@fairux/core`
 * and `@fairux/rules` are browser-safe and cannot. Everything an edit needs — where the text is and
 * what it currently says — therefore has to arrive on the node or the fix cannot be built.
 */

import type { SourceSpan, TextEdit, UiNode } from "./types.js";

/**
 * A `TextEdit` that removes one attribute, or `undefined` when the node carries no range for it.
 *
 * `undefined` rather than a guessed range: an adapter that was not asked for `source-range` supplies
 * nothing, and a rule that filled in the gap by counting characters would be relying on the applier
 * to catch its arithmetic. Refusing to propose a fix is a fine outcome; proposing one built from a
 * guess is the failure `TextEdit.expected` exists to catch.
 *
 * Removal is the only edit derivable from a range alone. Replacing an attribute's *value* needs the
 * value's own range, which is not recorded — the enclosing range covers the attribute and the
 * whitespace before it, and splitting it back apart means re-parsing the text this deliberately does
 * not re-parse.
 */
export function removeAttributeEdit(node: UiNode, attribute: string): TextEdit | undefined {
  const span: SourceSpan | undefined = node.attributeRanges?.[attribute];
  if (!span) return undefined;
  return Object.freeze({
    startLine: span.startLine,
    startColumn: span.startColumn,
    endLine: span.endLine,
    endColumn: span.endColumn,
    expected: span.text,
    replacement: "",
  });
}

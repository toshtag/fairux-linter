import type { Remediation, UiDocument, UiNode } from "@fairux/core";
import { removeAttributeEdit } from "@fairux/core";

/**
 * The one edit a built-in rule is allowed to propose: deleting a preselection attribute.
 *
 * Everything else a consent finding might suggest — rewording a label, reordering two buttons,
 * adding a reject control — is a change to what a page *says*, and no rule can know whether the
 * replacement is true. Removing `checked` is different in kind: the resulting markup is markup the
 * author could have written, the diff is one attribute long, and reading it is enough to check it.
 * That is what `safe` is for, and it is the whole of what is claimed here.
 *
 * Nothing about this is a guess. `@fairux/rules` is browser-safe and cannot open a file, so every
 * input arrives on the document or there is no remediation: the exact range from the adapter, the
 * exact text that range currently holds, and the checksum of the bytes both were computed against.
 * When any of those is missing the answer is **no remediation** — never `review-required`, which
 * would claim a fix exists and put the burden of refusing it on a reader.
 */

/**
 * Every spelling of `checked` this will remove, and no others.
 *
 * HTML says a boolean attribute is true when present, whatever its value, so `checked="yes"` is a
 * pre-checked box too. It is deliberately not matched: this list is the set whose meaning is
 * beyond argument, and a page outside it gets a finding with no fix rather than an edit resting on
 * a reading of the spec. The leading whitespace is part of the span the adapter records, and
 * removing it with the attribute is what keeps `<input type="checkbox" checked>` from becoming
 * `<input type="checkbox" >`.
 */
const REMOVABLE_CHECKED = /^\s+checked(\s*=\s*(?:"checked"|'checked'|""|''|checked))?$/i;

/** Lowercase hex SHA-256, the only form `Remediation.fileChecksum` accepts. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Propose removing a node's `checked` attribute, or nothing at all.
 *
 * Returns `undefined` — not a cautious remediation — whenever the proof is short of complete:
 *
 * - the document does not declare `source-range`, so no adapter recorded where anything is;
 * - it does not name the file the edit would apply to, or the bytes it was read from;
 * - the node carries no recorded range for `checked`, which is what an adapter asked only for
 *   source *locations* supplies;
 * - the range holds something other than a plain boolean `checked`.
 *
 * The last one is the interesting refusal. The edit's `expected` text is checked at apply time as
 * well, so a mismatch there is already caught — but being caught by the applier means the range was
 * built, shipped in the report, and refused on someone's machine. Refusing to build it is the same
 * outcome, arrived at where the reason is legible.
 */
export function removeCheckedAttributeRemediation(
  doc: UiDocument,
  node: UiNode,
  options: { readonly ruleId: string; readonly label: string },
): Remediation | undefined {
  if (!doc.capabilities?.includes("source-range")) return undefined;

  const file = doc.metadata?.file;
  const fileChecksum = doc.metadata?.sourceChecksum;
  if (typeof file !== "string" || file === "") return undefined;
  if (typeof fileChecksum !== "string" || !SHA256_HEX.test(fileChecksum)) return undefined;

  const edit = removeAttributeEdit(node, "checked");
  if (!edit || !REMOVABLE_CHECKED.test(edit.expected)) return undefined;

  const named = options.label ? `"${options.label}"` : "this checkbox";
  return Object.freeze({
    // Unique within a file: `node.id` is the node's path through the document, and a remediation is
    // grouped and applied per file.
    id: `${options.ruleId}:remove-checked:${node.id}`,
    origin: "rule",
    safety: "safe",
    title: "Remove the pre-checked default",
    description: `Delete the \`checked\` attribute from ${named}, so the box starts unchecked.`,
    rationale:
      "The edit deletes one boolean attribute and the whitespace before it, at a range the parser " +
      "recorded and against the exact text that range holds. It changes no wording, no label, no " +
      "order, and no other markup, and the resulting element is one the author could have written. " +
      "It does not decide whether consent should be collected here — only that it must not be " +
      "collected in advance.",
    file,
    fileChecksum,
    edits: [edit] as unknown as Remediation["edits"],
  });
}

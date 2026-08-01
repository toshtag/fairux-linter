/**
 * The capability vocabulary: what an input can supply, stated independently of what any rule does
 * with it.
 *
 * A rule declares the capabilities it needs; an input either has them or does not. Keeping the two
 * apart is the point — "this rule found nothing" and "this input could not answer that question"
 * look identical in a findings list, and only one of them is a result.
 */

import type { BuiltinCapabilityId, CapabilityId, Runtime, UiDocument } from "./types.js";

export interface CapabilityDefinition {
  readonly id: BuiltinCapabilityId;
  readonly title: string;
  /** What an input must be able to supply for this capability to be available. */
  readonly description: string;
}

/**
 * The built-in capabilities, in the order every FairUX surface reports them.
 *
 * The order is part of the contract: coverage output is deterministic, and a diff of two scans
 * should show what changed rather than how a set happened to iterate.
 */
export const BUILTIN_CAPABILITIES: readonly CapabilityDefinition[] = Object.freeze([
  Object.freeze({
    id: "structure",
    title: "Element structure",
    description: "The element tree: tags, roles, nesting, and containment.",
  }),
  Object.freeze({
    id: "text",
    title: "Text content",
    description: "Text owned by a node and by its subtree, normalized for matching.",
  }),
  Object.freeze({
    id: "attributes",
    title: "Attributes",
    description: "Element attributes as the input carries them, including boolean presence.",
  }),
  Object.freeze({
    id: "source-location",
    title: "Source location",
    description: "A file, line, and column for a node, so a finding can point back at source.",
  }),
  Object.freeze({
    id: "dom-state",
    title: "Live element state",
    description:
      "Element state after script has run — a checkbox as the user left it, rather than as it was authored.",
  }),
  Object.freeze({
    id: "style-hints",
    title: "Authored style hints",
    description:
      "Class names and inline style declarations as authored. Hints about intended appearance, not layout.",
  }),
  Object.freeze({
    id: "computed-style",
    title: "Computed style",
    description: "Style resolved by a rendering engine — the values actually in effect.",
  }),
  Object.freeze({
    id: "viewport",
    title: "Rendered geometry",
    description: "Position, size, and visibility of an element within a rendered viewport.",
  }),
  Object.freeze({
    id: "interaction",
    title: "Interaction",
    description: "State reached by driving the page: hover, focus, and what a click leads to.",
  }),
  Object.freeze({
    id: "journey",
    title: "Journey",
    description: "More than one page or step, so a flow can be followed across navigations.",
  }),
  Object.freeze({
    id: "form",
    title: "Form behavior",
    description: "Validation in effect, what a field will accept, and what submission does.",
  }),
  Object.freeze({
    id: "network",
    title: "Network",
    description: "The requests a page makes, and what they carry.",
  }),
]);

export const BUILTIN_CAPABILITY_IDS: readonly BuiltinCapabilityId[] = Object.freeze(
  BUILTIN_CAPABILITIES.map((capability) => capability.id),
);

const BUILTIN_CAPABILITY_RANK = new Map<string, number>(
  BUILTIN_CAPABILITIES.map((capability, index) => [capability.id, index]),
);

export function isBuiltinCapabilityId(value: string): value is BuiltinCapabilityId {
  return BUILTIN_CAPABILITY_RANK.has(value);
}

/**
 * What an input of each runtime can supply, as produced by this repository's own adapter for it.
 *
 * This table is a claim about four packages that do not import it, so each adapter checks its own
 * row against a document it actually parsed. Written down here rather than in the adapters because
 * `scan()` has to answer the question for a document it did not build — including one from an
 * adapter outside this repository, which is what `UiDocument.capabilities` is for.
 *
 * The absences are as deliberate as the entries. A live DOM has no source lines. A Figma document
 * has no class names or inline styles, so nothing in it backs `style-hints`. Nothing today supplies
 * `computed-style`, `viewport`, `interaction`, `journey`, `form`, or `network` — a scan reports them
 * as unavailable instead of running rules that need them and calling the silence a pass.
 */
export const RUNTIME_CAPABILITIES: Readonly<Record<Runtime, readonly CapabilityId[]>> =
  Object.freeze({
    html: Object.freeze<CapabilityId[]>([
      "structure",
      "text",
      "attributes",
      "source-location",
      "style-hints",
    ]),
    dom: Object.freeze<CapabilityId[]>([
      "structure",
      "text",
      "attributes",
      "dom-state",
      "style-hints",
    ]),
    ast: Object.freeze<CapabilityId[]>([
      "structure",
      "text",
      "attributes",
      "source-location",
      "style-hints",
    ]),
    figma: Object.freeze<CapabilityId[]>(["structure", "text", "attributes"]),
  });

/**
 * The capabilities a scan of this document has.
 *
 * An adapter that supplies more or less than its runtime's baseline says so on the document; the
 * baseline answers for everything else. A document that declares an empty list is taken at its
 * word — that is a real answer, not a missing one.
 */
export function resolveDocumentCapabilities(
  doc: Pick<UiDocument, "runtime" | "capabilities">,
): readonly CapabilityId[] {
  const declared = doc.capabilities;
  return sortCapabilityIds(declared ?? RUNTIME_CAPABILITIES[doc.runtime] ?? []);
}

/**
 * Which of `wanted` the scan does not have, in vocabulary order.
 *
 * One helper for both readings of the question — whether a rule can run at all, and what it was
 * missing — so the answer a scan acts on is the answer it reports.
 */
export function missingCapabilities(
  wanted: Iterable<CapabilityId> | undefined,
  available: ReadonlySet<CapabilityId>,
): readonly CapabilityId[] {
  if (!wanted) return Object.freeze([]);
  return sortCapabilityIds([...wanted].filter((capability) => !available.has(capability)));
}

/**
 * Built-in capabilities in vocabulary order, then namespaced ones lexicographically.
 *
 * Deduplicating here as well, because a caller assembling a set from several rules' declarations
 * would otherwise have to remember to.
 */
export function sortCapabilityIds(ids: Iterable<CapabilityId>): readonly CapabilityId[] {
  const unique = [...new Set(ids)];
  unique.sort((left, right) => {
    const leftRank = BUILTIN_CAPABILITY_RANK.get(left);
    const rightRank = BUILTIN_CAPABILITY_RANK.get(right);
    if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
    if (leftRank !== undefined) return -1;
    if (rightRank !== undefined) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return Object.freeze(unique);
}

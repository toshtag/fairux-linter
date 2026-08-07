import type { DocumentComment } from "./suppression-directive.js";
import type { CapabilityId, PageContextSignal, Runtime, UiDocument, UiNode } from "./types.js";

export interface CreateUiDocumentArgs {
  root: UiNode;
  runtime: Runtime;
  metadata?: UiDocument["metadata"];
  pageContexts?: readonly PageContextSignal[];
  /** Adapter-collected comments, for inline suppression directives. Absent where lines are not. */
  comments?: readonly DocumentComment[];
  /** What this document can answer for, when it differs from its runtime's baseline. */
  capabilities?: readonly CapabilityId[];
}

/**
 * Assemble a `UiDocument` from an already-built `UiNode` tree.
 *
 * Indexes the tree once so `all()`/`findAll()`/`getNode()` are cheap. Every adapter builds the node
 * tree its own way and hands it here — which is what keeps the `UiDocument` contract identical
 * across runtimes rather than each one growing its own shape.
 */
export function createUiDocument(args: CreateUiDocumentArgs): UiDocument {
  const index = new Map<string, UiNode>();
  const list: UiNode[] = [];

  const visit = (node: UiNode): void => {
    index.set(node.id, node);
    list.push(node);
    for (const child of node.children) visit(child);
  };
  visit(args.root);

  return {
    root: args.root,
    runtime: args.runtime,
    metadata: args.metadata,
    pageContexts: args.pageContexts ?? [],
    // Absent rather than empty when an adapter has none: `comments: []` would read as "this input
    // has no comments", where the truth for a live DOM or a Figma file is "there are no lines to
    // attach one to".
    ...(args.comments ? { comments: args.comments } : {}),
    // Passed through only when the adapter said something. An empty array is one of the things it
    // can say — "this document backs nothing" — so it survives, and only an absent one falls back to
    // the runtime baseline.
    ...(args.capabilities ? { capabilities: args.capabilities } : {}),
    all: () => list,
    findAll: (predicate) => list.filter(predicate),
    getNode: (id) => index.get(id),
  };
}

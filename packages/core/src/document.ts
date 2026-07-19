import type { PageContextSignal, Runtime, UiDocument, UiNode } from "./types.js";

export interface CreateUiDocumentArgs {
  root: UiNode;
  runtime: Runtime;
  metadata?: UiDocument["metadata"];
  pageContexts?: PageContextSignal[];
}

/**
 * Assemble a `UiDocument` from an already-built `UiNode` tree.
 *
 * Indexes the tree once so `all()`/`findAll()`/`getNode()` are cheap. Adapters
 * (HTML today, DOM/AST later) build the node tree then hand it here — keeping the
 * `UiDocument` contract identical across runtimes.
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
    all: () => list,
    findAll: (predicate) => list.filter(predicate),
    getNode: (id) => index.get(id),
  };
}

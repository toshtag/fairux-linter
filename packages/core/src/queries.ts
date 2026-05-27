import type { NodeQueries, UiDocument, UiNode } from "./types.js";

export function createNodeQueries(doc: UiDocument): NodeQueries {
  const ancestors = (node: UiNode): UiNode[] => {
    const out: UiNode[] = [];
    let current = node.parentId ? doc.getNode(node.parentId) : undefined;
    // Guard against malformed parentId chains (cycles / dangling ids).
    const seen = new Set<string>([node.id]);
    while (current && !seen.has(current.id)) {
      out.push(current);
      seen.add(current.id);
      current = current.parentId ? doc.getNode(current.parentId) : undefined;
    }
    return out;
  };

  const descendants = (node: UiNode): UiNode[] => {
    const out: UiNode[] = [];
    const stack = [...node.children];
    while (stack.length > 0) {
      const next = stack.pop();
      if (!next) continue;
      out.push(next);
      stack.push(...next.children);
    }
    return out;
  };

  const closest = (node: UiNode, predicate: (n: UiNode) => boolean): UiNode | undefined => {
    if (predicate(node)) return node;
    return ancestors(node).find(predicate);
  };

  const nearbyText = (node: UiNode, levels = 1): string => {
    const chain = ancestors(node);
    // Climb `levels` up; fall back to the highest available ancestor (or the node itself).
    const target = chain[Math.min(levels, chain.length) - 1] ?? node;
    return target.normalizedText;
  };

  return { ancestors, descendants, closest, nearbyText };
}

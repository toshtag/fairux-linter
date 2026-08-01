/**
 * Minimal structural view over parse5's tree. We intentionally don't import parse5's full
 * node types here — a small structural shape keeps the walker readable and resilient to
 * parse5's internal type churn. The single `as unknown as P5Node` cast lives in parse.ts.
 */
export interface P5Attr {
  name: string;
  value: string;
}

export interface P5Location {
  startLine: number;
  startCol: number;
  startOffset?: number;
}

export interface P5Node {
  nodeName: string;
  tagName?: string;
  value?: string;
  /** A comment's body. parse5 uses `data` here and `value` for text — they are different fields. */
  data?: string;
  attrs?: P5Attr[];
  childNodes?: P5Node[];
  /** <template> holds its children under `content` rather than `childNodes`. */
  content?: { childNodes?: P5Node[] };
  sourceCodeLocation?: P5Location | null;
}

/** Elements carry a `tagName`; text/comment/document/doctype nodes do not. */
export function isElementNode(node: P5Node): boolean {
  return typeof node.tagName === "string";
}

export function isTextNode(node: P5Node): boolean {
  return node.nodeName === "#text";
}

/**
 * parse5 keeps a comment's body in `data`, **not** in `value`.
 *
 * `value` is the text node's field. Reading `value` for a comment returns `undefined`, and the
 * collection below silently found nothing — which is exactly how an inline directive would have
 * looked like it did not work.
 */
export function isCommentNode(node: P5Node): boolean {
  return node.nodeName === "#comment";
}

export function getChildNodes(node: P5Node): P5Node[] {
  if (node.tagName === "template" && node.content?.childNodes) {
    return node.content.childNodes;
  }
  return node.childNodes ?? [];
}

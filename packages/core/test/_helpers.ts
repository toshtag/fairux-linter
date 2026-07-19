import type {
  AccessibilityInfo,
  PageContextSignal,
  Runtime,
  SourceLocation,
  UiDocument,
  UiNode,
} from "../src/index.js";
import { createUiDocument, normalizeText } from "../src/index.js";

/** Lightweight spec for hand-building node trees in tests. */
export interface NodeSpec {
  tag: string;
  attributes?: Record<string, string | true>;
  text?: string;
  role?: string;
  accessibility?: AccessibilityInfo;
  source?: SourceLocation;
  children?: NodeSpec[];
}

function build(spec: NodeSpec, path: number[], parentId?: string): UiNode {
  const id = path.join(".");
  const node: UiNode = {
    id,
    parentId,
    tag: spec.tag,
    role: spec.role,
    attributes: spec.attributes ?? {},
    directText: spec.text ?? "",
    subtreeText: "",
    normalizedText: "",
    accessibility: spec.accessibility,
    children: [],
    locator: { type: "path", value: path },
    source: spec.source,
  };
  node.children = (spec.children ?? []).map((child, i) => build(child, [...path, i], id));
  const childText = node.children.map((c) => c.subtreeText).join(" ");
  node.subtreeText = [node.directText, childText].filter(Boolean).join(" ");
  node.normalizedText = normalizeText(node.subtreeText);
  return node;
}

export function makeNode(spec: NodeSpec): UiNode {
  return build(spec, [0]);
}

export interface MakeDocOptions {
  runtime?: Runtime;
  pageContexts?: PageContextSignal[];
  file?: string;
}

export function makeDoc(root: NodeSpec, opts: MakeDocOptions = {}): UiDocument {
  return createUiDocument({
    root: build(root, [0]),
    runtime: opts.runtime ?? "html",
    metadata: opts.file ? { file: opts.file } : undefined,
    pageContexts: opts.pageContexts,
  });
}

/** Fetch a node by id, throwing if absent — keeps tests free of `!` assertions. */
export function get(doc: UiDocument, id: string): UiNode {
  const node = doc.getNode(id);
  if (!node) throw new Error(`No node with id "${id}"`);
  return node;
}

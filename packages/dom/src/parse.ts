import {
  type AccessibilityInfo,
  buildSelector,
  createUiDocument,
  detectPageContexts,
  InputTooLargeError,
  type Locale,
  MAX_NODE_COUNT,
  MAX_TREE_DEPTH,
  normalizeText,
  type UiDocument,
  type UiNode,
} from "@fairux/core";

export interface ParseDomOptions {
  /** Recorded in `metadata.url`. */
  url?: string;
  /** Limit scanning to a subtree (a modal/banner). Defaults to `document.documentElement`. */
  root?: Element;
}

// HTML boolean attributes — read as DOM *properties* so user state (e.g. a clicked checkbox)
// is reflected, not just the original attribute. Per ADR P3-T1 §4b.
const BOOLEAN_PROPS = new Set([
  "checked",
  "disabled",
  "readonly",
  "required",
  "selected",
  "multiple",
  "open",
  "hidden",
]);

const ALT_TAGS = new Set(["img", "area", "input"]);

interface BuildState {
  htmlIds: Map<string, UiNode>;
  all: UiNode[];
  containsShadow: boolean;
  nodeCount: number;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function readAttributes(el: Element): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (const attr of Array.from(el.attributes)) {
    out[attr.name] = attr.value;
  }
  // Override the known boolean set from live properties, so a checkbox the user toggled reads
  // its current state. Presence as `true`; falsey → drop the key (treat as absent).
  for (const prop of BOOLEAN_PROPS) {
    const value = (el as unknown as Record<string, unknown>)[prop];
    if (typeof value === "boolean") {
      if (value) out[prop] = true;
      else delete out[prop];
    }
  }
  return out;
}

/** Best-effort accessible name: aria-label > aria-labelledby (resolved) > alt. Matches HTML adapter. */
function explicitName(
  tag: string,
  attributes: Record<string, string | true>,
  byId: Map<string, UiNode>,
): AccessibilityInfo | undefined {
  const ariaLabel = attributes["aria-label"];
  if (typeof ariaLabel === "string" && ariaLabel) {
    return { name: ariaLabel, nameSource: "aria-label" };
  }
  const labelledby = attributes["aria-labelledby"];
  if (typeof labelledby === "string" && labelledby) {
    const names = labelledby
      .split(/\s+/)
      .map((ref) => byId.get(ref)?.subtreeText.trim())
      .filter((v): v is string => Boolean(v));
    if (names.length > 0) return { name: names.join(" "), nameSource: "aria-labelledby" };
  }
  if (ALT_TAGS.has(tag)) {
    const alt = attributes.alt;
    const isImageInput = tag !== "input" || (attributes.type as string)?.toLowerCase() === "image";
    if (typeof alt === "string" && alt && isImageInput) return { name: alt, nameSource: "alt" };
  }
  return undefined;
}

/** Children to traverse: element children, plus an OPEN shadow root's children inlined. */
function childElementsOf(el: Element, state: BuildState): Element[] {
  const children = Array.from(el.children);
  const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
  if (shadow) {
    // Open shadow root: inline its element children as if regular children (ADR P3-T1 §7).
    state.containsShadow = true;
    return [...Array.from(shadow.children), ...children];
  }
  return children;
}

/** Direct text owned by an element (its immediate text-node children only). */
function directTextOf(el: Element): string {
  let raw = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3 /* TEXT_NODE */) raw += node.nodeValue ?? "";
  }
  return collapse(raw);
}

function buildElement(
  el: Element,
  path: number[],
  parentId: string | undefined,
  parentSelector: string | undefined,
  state: BuildState,
  depth: number,
): UiNode {
  if (depth > MAX_TREE_DEPTH) {
    throw new InputTooLargeError(MAX_TREE_DEPTH, depth, "depth");
  }
  state.nodeCount += 1;
  if (state.nodeCount > MAX_NODE_COUNT) {
    throw new InputTooLargeError(MAX_NODE_COUNT, state.nodeCount, "nodes");
  }

  const id = path.join(".");
  const tag = el.tagName.toLowerCase();
  const attributes = readAttributes(el);
  const htmlId = typeof attributes.id === "string" ? attributes.id : undefined;
  const role = typeof attributes.role === "string" ? attributes.role : undefined;
  const nthChild = (path.at(-1) ?? 0) + 1;
  const selector = buildSelector(parentSelector, tag, nthChild, htmlId);

  const node: UiNode = {
    id,
    parentId,
    tag,
    role,
    attributes,
    directText: directTextOf(el),
    subtreeText: "",
    normalizedText: "",
    children: [],
    locator: { type: "css", value: selector },
    // No `source`: a live DOM has no source line/column (ADR P3-T1 §4a). Left undefined.
  };

  state.all.push(node);
  if (htmlId) state.htmlIds.set(htmlId, node);

  const childEls = childElementsOf(el, state);
  node.children = childEls.map((child, i) =>
    buildElement(child, [...path, i], id, selector, state, depth + 1),
  );

  const childText = node.children.map((c) => c.subtreeText).join(" ");
  node.subtreeText = [node.directText, childText].filter(Boolean).join(" ");
  node.normalizedText = normalizeText(node.subtreeText);
  return node;
}

/** Second pass: resolve accessibility names now that all ids are indexed (for aria-labelledby). */
function resolveAccessibility(state: BuildState): void {
  for (const node of state.all) {
    const info = explicitName(node.tag, node.attributes, state.htmlIds);
    if (info) node.accessibility = info;
  }
}

function detectLocale(root: Element): Locale | "unknown" {
  const lang = root.getAttribute?.("lang")?.toLowerCase() ?? "";
  if (lang.startsWith("ja")) return "ja";
  if (lang.startsWith("en")) return "en";
  return "unknown";
}

/** Parse a live DOM `Document` into a runtime-agnostic `UiDocument` (snapshot; see ADR P3-T1). */
export function parseDocument(doc: Document, options: ParseDomOptions = {}): UiDocument {
  const rootEl = options.root ?? doc.documentElement;
  const state: BuildState = {
    htmlIds: new Map(),
    all: [],
    containsShadow: false,
    nodeCount: 0,
  };

  const root = buildElement(rootEl, [0], undefined, undefined, state, 1);
  resolveAccessibility(state);

  const titleRaw = doc.title?.trim() || undefined;
  const pageContexts = detectPageContexts(
    root.normalizedText,
    titleRaw ? normalizeText(titleRaw) : undefined,
  );

  return createUiDocument({
    root,
    runtime: "dom",
    metadata: {
      url: options.url,
      title: titleRaw,
      locale: detectLocale(rootEl),
      ...(state.containsShadow ? { containsShadow: true } : {}),
    },
    pageContexts,
  });
}

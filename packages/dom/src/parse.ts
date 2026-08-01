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
  RUNTIME_CAPABILITIES,
  type UiDocument,
  type UiNode,
} from "@fairux/core";

export interface ParseDomOptions {
  /** Recorded in `metadata.url`. */
  url?: string;
  /** Limit scanning to a subtree (a modal/banner). Defaults to `document.documentElement`. */
  root?: Element;
  /**
   * Read what the rendering engine resolved for each element: {@link COLLECTED_STYLE_PROPERTIES} and
   * the element's box.
   *
   * Off by default, and the default is not timidity. `getComputedStyle` and `getBoundingClientRect`
   * each force layout, and a page can hold thousands of elements — a caller that does not need the
   * values should not pay for them. A document that did not collect them does not claim
   * `computed-style` or `viewport`, so a rule needing either is skipped rather than handed an absent
   * value it could read as a default.
   */
  visualFacts?: boolean;
}

/**
 * The resolved properties this adapter reads, in this order.
 *
 * Fixed rather than complete. A full CSSOM snapshot is hundreds of properties per element, differs
 * between engines, and would make two scans of one page incomparable; this list is what a prominence
 * or visibility judgement actually needs, and adding to it is a deliberate change with a test behind
 * it.
 */
export const COLLECTED_STYLE_PROPERTIES: readonly string[] = Object.freeze([
  "display",
  "visibility",
  "opacity",
  "color",
  "background-color",
  "font-size",
  "font-weight",
]);

// HTML boolean attributes — read as DOM *properties* so user state (e.g. a clicked checkbox)
// is reflected, not just the original attribute. This is where a live DOM is more truthful than
// static HTML, and rules benefit without knowing which adapter produced the node.
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
  /** Elements in `all` order, kept only to read layout once the tree is built. */
  elements: Element[];
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
    // Open shadow root: inline its element children as if they were regular children, so rules
    // see one tree. Closed roots are untouchable by design and are skipped silently.
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
    // No `source`: a live DOM has no source line or column. Left undefined rather than faked —
    // reporters and rules already treat `source` as optional.
  };

  state.all.push(node);
  state.elements.push(el);
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

/**
 * Read layout for every element, in one pass after the tree is built.
 *
 * One pass, and nothing writes to the DOM between the reads: interleaving reads with writes forces a
 * reflow per element, which is the difference between a scan a user waits through and one they do
 * not. Both calls are reads.
 */
function collectVisualFacts(state: BuildState, view: Window | null): void {
  if (!view) return;
  const viewportWidth = view.innerWidth ?? 0;
  const viewportHeight = view.innerHeight ?? 0;

  for (let index = 0; index < state.all.length; index += 1) {
    const node = state.all[index] as UiNode;
    const element = state.elements[index] as Element;
    const computed = view.getComputedStyle?.(element);
    const rect = element.getBoundingClientRect?.();

    const computedStyle: Record<string, string> = {};
    if (computed) {
      for (const property of COLLECTED_STYLE_PROPERTIES) {
        const value = computed.getPropertyValue(property);
        // Empty rather than absent is what a headless engine returns for a property it does not
        // implement. Recording it would claim a resolved value of "".
        if (value) computedStyle[property] = value;
      }
    }

    // Integers: sub-pixel values move with zoom, device pixel ratio, and font rendering, and a
    // report that changed between two scans of an unchanged page would be reporting the browser.
    const box = rect
      ? {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      : undefined;

    node.visual = {
      ...(Object.keys(computedStyle).length > 0 ? { computedStyle } : {}),
      ...(box ? { box } : {}),
      ...(box ? { inViewport: intersectsViewport(box, viewportWidth, viewportHeight) } : {}),
    };
  }
}

function intersectsViewport(
  box: { x: number; y: number; width: number; height: number },
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  // Any overlap counts. An element half off the bottom of the screen is on the page; one scrolled
  // past is not where the user is looking, and "partly visible" is not a third answer this needs.
  return (
    box.width > 0 &&
    box.height > 0 &&
    box.x < viewportWidth &&
    box.y < viewportHeight &&
    box.x + box.width > 0 &&
    box.y + box.height > 0
  );
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

/**
 * Parse a live DOM `Document` into a runtime-agnostic `UiDocument`.
 *
 * This is a point-in-time snapshot: the tree is walked once and later mutations are not reflected.
 * Call it again to rescan. No MutationObserver, so scans stay deterministic and fingerprints stay
 * stable.
 */
export function parseDocument(doc: Document, options: ParseDomOptions = {}): UiDocument {
  const rootEl = options.root ?? doc.documentElement;
  const state: BuildState = {
    htmlIds: new Map(),
    all: [],
    containsShadow: false,
    nodeCount: 0,
    elements: [],
  };

  const root = buildElement(rootEl, [0], undefined, undefined, state, 1);
  resolveAccessibility(state);
  if (options.visualFacts) {
    collectVisualFacts(state, doc.defaultView ?? null);
  }

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
    // Claimed only when they were actually read. Declaring the capability on every DOM document and
    // leaving the values absent would be the one failure coverage exists to prevent: a rule would
    // run, see nothing, and report the silence as a result.
    ...(options.visualFacts
      ? { capabilities: [...RUNTIME_CAPABILITIES.dom, "computed-style", "viewport"] }
      : {}),
  });
}

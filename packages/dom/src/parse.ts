import {
  type AccessibilityInfo,
  buildSelector,
  createUiDocument,
  detectPageContexts,
  type FormConstraint,
  InputTooLargeError,
  joinCssLocator,
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
  /**
   * Read what a live form knows: whether each control participates in constraint validation, which
   * constraints it currently fails, and which form owns it.
   *
   * Off by default, like {@link visualFacts}, and claimed the same way — a document that did not read
   * these does not declare `form`, so a rule needing it is skipped rather than handed absent values.
   */
  formFacts?: boolean;
}

/**
 * Constraint flags, in the order they are recorded. `valid` is deliberately absent: it is the
 * conjunction of the others, and storing a derived value invites the two to disagree.
 */
export const FORM_CONSTRAINTS: readonly FormConstraint[] = Object.freeze([
  "valueMissing",
  "typeMismatch",
  "patternMismatch",
  "tooLong",
  "tooShort",
  "rangeUnderflow",
  "rangeOverflow",
  "stepMismatch",
  "badInput",
  "customError",
]);

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

/**
 * One document or one open shadow root: the scope an `id` is unique within and a selector resolves
 * within. A tree with no shadow root has exactly one.
 */
interface TreeScope {
  /** `id` → node, for `aria-labelledby`. Never shared with another scope. */
  readonly htmlIds: Map<string, UiNode>;
}

interface BuildState {
  all: UiNode[];
  /** The scope each node in `all` was built in, so names resolve where the ids actually are. */
  scopes: TreeScope[];
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

/** A child to traverse, and what it is a child *of*. */
interface ChildElement {
  readonly el: Element;
  /** Its 1-based position among its siblings **in its own root**, for `:nth-child`. */
  readonly nthChild: number;
  /**
   * True when this child lives in the host's open shadow root rather than beside it.
   *
   * A shadow child starts a new selector scope: its `:nth-child` counts from 1 inside the root, and
   * the selector reaching it has to be resolved against that root rather than against the document.
   */
  readonly inShadowRoot: boolean;
}

/**
 * Children to traverse: element children, plus an OPEN shadow root's children inlined.
 *
 * The two groups are kept distinct rather than concatenated. They used to be one list, so a host
 * with two shadow children and two light children numbered its light children 3 and 4 — indexes no
 * selector resolved against either root would ever match, and `:nth-child(3)` in the light DOM
 * matches a real, different element. Closed roots are untouchable by design and are skipped
 * silently.
 */
function childElementsOf(el: Element, state: BuildState): ChildElement[] {
  const light = Array.from(el.children).map((child, index) => ({
    el: child,
    nthChild: index + 1,
    inShadowRoot: false,
  }));
  const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
  if (!shadow) return light;
  state.containsShadow = true;
  const inShadow = Array.from(shadow.children).map((child, index) => ({
    el: child,
    nthChild: index + 1,
    inShadowRoot: true,
  }));
  // Shadow first, as before: what a host renders comes from its shadow root, and the slotted light
  // children follow. Only the order of traversal, never the numbering.
  return [...inShadow, ...light];
}

/** Direct text owned by an element (its immediate text-node children only). */
function directTextOf(el: Element): string {
  let raw = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3 /* TEXT_NODE */) raw += node.nodeValue ?? "";
  }
  return collapse(raw);
}

/**
 * Where a node sits, for the two things that are per-root rather than per-tree.
 *
 * A consumer resolves `[...ancestorSegments, selector]`: the last entry is the selector inside the
 * current root, and every earlier one reaches the host of the root after it.
 */
interface BuildPosition {
  readonly path: number[];
  readonly parentId: string | undefined;
  /** The selector of the parent **within the current root**, absent at a root's own first element. */
  readonly parentSelector: string | undefined;
  /** Completed segments, one per root already crossed. */
  readonly ancestorSegments: readonly string[];
  readonly nthChild: number;
  readonly scope: TreeScope;
}

function buildElement(
  el: Element,
  position: BuildPosition,
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

  const id = position.path.join(".");
  const tag = el.tagName.toLowerCase();
  const attributes = readAttributes(el);
  const htmlId = typeof attributes.id === "string" ? attributes.id : undefined;
  const role = typeof attributes.role === "string" ? attributes.role : undefined;
  const selector = buildSelector(position.parentSelector, tag, position.nthChild, htmlId);

  const node: UiNode = {
    id,
    parentId: position.parentId,
    tag,
    role,
    attributes,
    directText: directTextOf(el),
    subtreeText: "",
    normalizedText: "",
    children: [],
    // One segment per root crossed, joined. A tree with no shadow root produces exactly the flat
    // selector it always did, so a consumer written for that form is unaffected.
    locator: { type: "css", value: joinCssLocator([...position.ancestorSegments, selector]) },
    // No `source`: a live DOM has no source line or column. Left undefined rather than faked —
    // reporters and rules already treat `source` as optional.
  };

  state.all.push(node);
  state.elements.push(el);
  state.scopes.push(position.scope);
  // Scoped to the root it is in. An `id` inside a shadow root is invisible from the document, so an
  // `aria-labelledby` out here must not resolve to it — and one in there must not reach out.
  if (htmlId) position.scope.htmlIds.set(htmlId, node);

  const childEls = childElementsOf(el, state);
  // One scope for the whole shadow root, created once here rather than per child: its children
  // share an id namespace with each other and with nothing outside. Absent unless this element
  // actually has an open shadow root, so an ordinary element allocates nothing.
  const shadowScope: TreeScope | undefined = childEls.some((child) => child.inShadowRoot)
    ? { htmlIds: new Map() }
    : undefined;
  node.children = childEls.map((child, i) => {
    // A shadow child begins a new root: this element's selector becomes the last completed segment,
    // and the child starts a fresh `:nth-child` path resolved against `host.shadowRoot`.
    return buildElement(
      child.el,
      {
        path: [...position.path, i],
        parentId: id,
        parentSelector: child.inShadowRoot ? undefined : selector,
        ancestorSegments: child.inShadowRoot
          ? [...position.ancestorSegments, selector]
          : position.ancestorSegments,
        nthChild: child.nthChild,
        scope: child.inShadowRoot && shadowScope ? shadowScope : position.scope,
      },
      state,
      depth + 1,
    );
  });

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

/**
 * Read constraint validation for every control, after the tree is built.
 *
 * The point of this is the answer markup cannot give. A `required` input inside a `novalidate` form
 * still carries the attribute and does not participate in validation; only the engine knows, and
 * `willValidate` is where it says so.
 */
function collectFormFacts(state: BuildState): void {
  const nodeByElement = new Map<Element, UiNode>();
  for (let index = 0; index < state.all.length; index += 1) {
    nodeByElement.set(state.elements[index] as Element, state.all[index] as UiNode);
  }

  for (let index = 0; index < state.all.length; index += 1) {
    const node = state.all[index] as UiNode;
    const element = state.elements[index] as ValidatableElement;
    if (typeof element.willValidate !== "boolean" || !element.validity) continue;

    // A control barred from validation is not failing anything *in effect*, which is what this
    // capability is named for. The engine still computes the flags for a disabled `required` input,
    // and reporting them would say a field is blocking submission when it cannot. Nothing is lost
    // that a reader cannot recover: the authored `required` is still in `attributes`, beside a
    // `willValidate` of false — which is the interesting pair, and the one markup cannot show.
    const validity = element.validity;
    const failedConstraints = element.willValidate
      ? FORM_CONSTRAINTS.filter((constraint) => validity[constraint] === true)
      : [];
    // The owning form, resolved by the engine rather than by ancestry: a control tied to a form with
    // the `form` attribute lives outside it in the tree, and walking parents would miss it.
    const formNode = element.form ? nodeByElement.get(element.form) : undefined;

    node.form = {
      willValidate: element.willValidate,
      failedConstraints,
      ...(formNode ? { formNodeId: formNode.id } : {}),
    };
  }
}

/** The shape this adapter reads off a control. Narrower than `HTMLInputElement`, and enough. */
interface ValidatableElement extends Element {
  readonly willValidate?: boolean;
  readonly validity?: Record<string, boolean>;
  readonly form?: Element | null;
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

/**
 * Second pass: resolve accessibility names now that all ids are indexed (for `aria-labelledby`).
 *
 * Each node is resolved against **its own** root's ids. `aria-labelledby` does not cross a shadow
 * boundary in any browser, so a flat index across the whole tree — which is what this used to
 * consult — could name a button after a label in a different root that no user agent would ever
 * associate with it.
 */
function resolveAccessibility(state: BuildState): void {
  for (let index = 0; index < state.all.length; index += 1) {
    const node = state.all[index] as UiNode;
    const scope = state.scopes[index] as TreeScope;
    const info = explicitName(node.tag, node.attributes, scope.htmlIds);
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
  // One scope per document or open shadow root. Each root creates its own as the walk enters it.
  const documentScope: TreeScope = { htmlIds: new Map() };
  const state: BuildState = {
    all: [],
    scopes: [],
    containsShadow: false,
    nodeCount: 0,
    elements: [],
  };

  const root = buildElement(
    rootEl,
    {
      path: [0],
      parentId: undefined,
      parentSelector: undefined,
      ancestorSegments: [],
      nthChild: 1,
      scope: documentScope,
    },
    state,
    1,
  );
  resolveAccessibility(state);
  if (options.visualFacts) {
    collectVisualFacts(state, doc.defaultView ?? null);
  }
  if (options.formFacts) {
    collectFormFacts(state);
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
    ...(options.visualFacts || options.formFacts
      ? {
          capabilities: [
            ...RUNTIME_CAPABILITIES.dom,
            ...(options.visualFacts ? (["computed-style", "viewport"] as const) : []),
            ...(options.formFacts ? (["form"] as const) : []),
          ],
        }
      : {}),
  });
}

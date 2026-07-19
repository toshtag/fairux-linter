import type { Locale, SourceLocation, UiDocument, UiNode } from "@fairux/core";
import { buildSelector, createUiDocument, detectPageContexts, normalizeText } from "@fairux/core";
import { parse } from "parse5";
import { explicitName } from "./accessible-name.js";
import { getChildNodes, isElementNode, isTextNode, type P5Location, type P5Node } from "./p5.js";

export interface ParseHtmlOptions {
  /** Recorded into node/finding source locations and the document metadata. */
  file?: string;
}

// HTML boolean attributes: presence implies `true` regardless of the literal value.
const BOOLEAN_ATTRS = new Set([
  "checked",
  "disabled",
  "readonly",
  "required",
  "selected",
  "multiple",
  "autofocus",
  "hidden",
  "open",
  "novalidate",
  "ismap",
  "reversed",
  "loop",
  "muted",
  "controls",
  "autoplay",
  "playsinline",
  "default",
  "async",
  "defer",
]);

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function mapAttrs(attrs: P5Node["attrs"]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (const { name, value } of attrs ?? []) {
    out[name] = BOOLEAN_ATTRS.has(name) ? true : value;
  }
  return out;
}

function toSource(
  loc: P5Location | null | undefined,
  file: string | undefined,
): SourceLocation | undefined {
  if (!loc) return file ? { file } : undefined;
  return { file, startLine: loc.startLine, startColumn: loc.startCol };
}

interface BuildState {
  file?: string;
  htmlIds: Map<string, UiNode>;
  all: UiNode[];
}

function buildElement(
  el: P5Node,
  path: number[],
  parentId: string | undefined,
  parentSelector: string | undefined,
  state: BuildState,
): UiNode {
  const id = path.join(".");
  const tag = (el.tagName ?? el.nodeName).toLowerCase();
  const attributes = mapAttrs(el.attrs);
  const htmlId = typeof attributes.id === "string" ? attributes.id : undefined;
  const role = typeof attributes.role === "string" ? attributes.role : undefined;
  const nthChild = (path.at(-1) ?? 0) + 1;
  const selector = buildSelector(parentSelector, tag, nthChild, htmlId);

  let directRaw = "";
  const childElements: P5Node[] = [];
  for (const child of getChildNodes(el)) {
    if (isTextNode(child)) directRaw += child.value ?? "";
    else if (isElementNode(child)) childElements.push(child);
  }

  const node: UiNode = {
    id,
    parentId,
    tag,
    role,
    attributes,
    directText: collapse(directRaw),
    subtreeText: "",
    normalizedText: "",
    accessibility: explicitName(tag, attributes),
    children: [],
    locator: { type: "css", value: selector },
    source: toSource(el.sourceCodeLocation, state.file),
  };

  state.all.push(node);
  if (htmlId) state.htmlIds.set(htmlId, node);

  node.children = childElements.map((child, i) =>
    buildElement(child, [...path, i], id, selector, state),
  );

  const childText = node.children.map((c) => c.subtreeText).join(" ");
  node.subtreeText = [node.directText, childText].filter(Boolean).join(" ");
  node.normalizedText = normalizeText(node.subtreeText);
  return node;
}

/** Second pass: resolve `aria-labelledby` references now that all ids are known. */
function resolveLabelledBy(state: BuildState): void {
  for (const node of state.all) {
    if (node.accessibility?.name) continue;
    const labelledby = node.attributes["aria-labelledby"];
    if (typeof labelledby !== "string") continue;
    const names = labelledby
      .split(/\s+/)
      .map((ref) => state.htmlIds.get(ref)?.subtreeText.trim())
      .filter((value): value is string => Boolean(value));
    if (names.length > 0) {
      node.accessibility = { name: names.join(" "), nameSource: "aria-labelledby" };
    }
  }
}

function findRootElement(document: P5Node): P5Node | undefined {
  return (document.childNodes ?? []).find(isElementNode);
}

function emptyRoot(file: string | undefined): UiNode {
  return {
    id: "0",
    tag: "html",
    attributes: {},
    directText: "",
    subtreeText: "",
    normalizedText: "",
    children: [],
    locator: { type: "css", value: "html" },
    source: file ? { file } : undefined,
  };
}

function extractTitle(nodes: UiNode[]): string | undefined {
  const title = nodes.find((n) => n.tag === "title")?.subtreeText.trim();
  return title ? title : undefined;
}

function extractLocale(root: UiNode): Locale | "unknown" {
  const lang = typeof root.attributes.lang === "string" ? root.attributes.lang.toLowerCase() : "";
  if (lang.startsWith("ja")) return "ja";
  if (lang.startsWith("en")) return "en";
  return "unknown";
}

/** Parse static HTML into a runtime-agnostic `UiDocument`. */
export function parseHtml(html: string, options: ParseHtmlOptions = {}): UiDocument {
  const document = parse(html, { sourceCodeLocationInfo: true }) as unknown as P5Node;
  const rootElement = findRootElement(document);

  if (!rootElement) {
    return createUiDocument({
      root: emptyRoot(options.file),
      runtime: "html",
      metadata: { file: options.file },
      pageContexts: [{ context: "unknown", confidence: "low" }],
    });
  }

  const state: BuildState = { file: options.file, htmlIds: new Map(), all: [] };
  const root = buildElement(rootElement, [0], undefined, undefined, state);
  resolveLabelledBy(state);

  const title = extractTitle(state.all);
  const pageContexts = detectPageContexts(
    root.normalizedText,
    title ? normalizeText(title) : undefined,
  );

  return createUiDocument({
    root,
    runtime: "html",
    metadata: { file: options.file, title, locale: extractLocale(root) },
    pageContexts,
  });
}

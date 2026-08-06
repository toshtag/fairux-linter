import type {
  CapabilityId,
  DocumentComment,
  Locale,
  SourceLocation,
  SourceSpan,
  UiDocument,
  UiNode,
} from "@fairux/core";
import {
  buildSelector,
  createUiDocument,
  detectPageContexts,
  InputTooLargeError,
  MAX_NODE_COUNT,
  MAX_TREE_DEPTH,
  normalizeText,
  RUNTIME_CAPABILITIES,
} from "@fairux/core";
import { parse } from "parse5";
import { explicitName } from "./accessible-name.js";
import {
  getChildNodes,
  isCommentNode,
  isElementNode,
  isTextNode,
  type P5Location,
  type P5Node,
} from "./p5.js";

export interface ParseHtmlOptions {
  /**
   * Lowercase hex SHA-256 of `html`, recorded on the document.
   *
   * Passed in rather than computed: this package parses, and a hash belongs with whoever read the
   * bytes. A rule proposing a remediation copies it forward so applying can refuse a file that
   * changed since the scan.
   */
  sourceChecksum?: string;
  /** Recorded into node/finding source locations and the document metadata. */
  file?: string;
  /**
   * Record a source range for every attribute of every element, and claim `source-range`.
   *
   * Off by default because it is the one part of the model whose size scales with the markup rather
   * than with the tree: a range and its text per attribute, retained for as long as the document is.
   * parse5 computes the positions either way — what this option decides is whether they are kept.
   *
   * On when the caller can act on an edit. The CLI turns it on because it can apply one; an SDK
   * consumer scanning for findings alone does not pay for a fix it has nowhere to put.
   */
  sourceRanges?: boolean;
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
  // The end comes straight from parse5, which has had it all along. It was dropped because nothing
  // consumed it, and the two surfaces that draw a range then had to guess: the VS Code extension
  // underlined to the end of the start line, marking one line of a four-line element and dragging
  // across whatever else shared that line.
  return {
    file,
    startLine: loc.startLine,
    startColumn: loc.startCol,
    ...(typeof loc.endLine === "number" && typeof loc.endCol === "number"
      ? { endLine: loc.endLine, endColumn: loc.endCol }
      : {}),
  };
}

/** What this adapter supplies once it has been asked to keep attribute ranges. */
const SOURCE_RANGE_CAPABILITIES: readonly CapabilityId[] = Object.freeze([
  ...RUNTIME_CAPABILITIES.html,
  "source-range",
]);

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

/**
 * One attribute's range, extended backwards over the whitespace that separates it from what
 * precedes it.
 *
 * parse5 reports the attribute itself — `checked`, not ` checked`. Removing exactly that leaves
 * `<input type="checkbox" >`, so the range a rule needs is the wider one, and computing it here is
 * the only place with the source text to do it in.
 */
function attributeSpan(html: string, loc: P5Location): SourceSpan | undefined {
  const { startOffset, endOffset, startLine, startCol, endLine, endCol } = loc;
  if (
    startOffset === undefined ||
    endOffset === undefined ||
    endLine === undefined ||
    endCol === undefined
  ) {
    return undefined;
  }

  let start = startOffset;
  while (start > 0 && isWhitespace(html.charAt(start - 1))) start -= 1;
  const skipped = html.slice(start, startOffset);
  const newlines = skipped.split("\n").length - 1;

  return Object.freeze({
    startLine: startLine - newlines,
    // Only the same-line case can subtract; whitespace carrying a newline puts the start on an
    // earlier line, where the column has to be measured from that line's beginning.
    startColumn:
      newlines === 0 ? startCol - skipped.length : start - html.lastIndexOf("\n", start - 1),
    endLine,
    endColumn: endCol,
    text: html.slice(start, endOffset),
  });
}

function attributeRanges(
  el: P5Node,
  html: string,
): Readonly<Record<string, SourceSpan>> | undefined {
  const locations = el.sourceCodeLocation?.attrs;
  if (!locations) return undefined;
  const ranges: Record<string, SourceSpan> = {};
  for (const { name } of el.attrs ?? []) {
    // Keyed by the name the attributes record uses, so `node.attributeRanges[name]` answers for
    // every `name` a rule read off `node.attributes` — or answers not at all, never wrongly.
    const loc = locations[name] ?? locations[name.toLowerCase()];
    const span = loc ? attributeSpan(html, loc) : undefined;
    if (span) ranges[name] = span;
  }
  return Object.keys(ranges).length > 0 ? Object.freeze(ranges) : undefined;
}

interface BuildState {
  file?: string;
  html: string;
  sourceRanges: boolean;
  htmlIds: Map<string, UiNode>;
  all: UiNode[];
  depth: number;
}

function buildElement(
  el: P5Node,
  path: number[],
  parentId: string | undefined,
  parentSelector: string | undefined,
  state: BuildState,
): UiNode {
  if (state.all.length >= MAX_NODE_COUNT) {
    throw new InputTooLargeError(MAX_NODE_COUNT, state.all.length + 1, "nodes");
  }
  if (state.depth >= MAX_TREE_DEPTH) {
    throw new InputTooLargeError(MAX_TREE_DEPTH, state.depth + 1, "depth");
  }
  state.depth++;
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
    ...(state.sourceRanges ? { attributeRanges: attributeRanges(el, state.html) } : {}),
  };

  state.all.push(node);
  if (htmlId) state.htmlIds.set(htmlId, node);

  node.children = childElements.map((child, i) =>
    buildElement(child, [...path, i], id, selector, state),
  );

  state.depth--;
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
      node.accessibility = {
        name: names.join(" "),
        nameSource: "aria-labelledby",
      };
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

/**
 * Every comment in the document, with the line it starts on.
 *
 * Walked from the parse5 tree rather than scanned out of the source text: a `<!--` inside a `<script>`
 * or an attribute value is not a comment, and a regular expression over the source cannot tell the
 * difference. The tree already knows.
 *
 * Comments are not part of the normalized model — no rule sees them — so this is collected beside it
 * and handed to the engine for one purpose: `fairux-disable-next-line`.
 */
function collectComments(node: P5Node, into: DocumentComment[]): DocumentComment[] {
  if (isCommentNode(node)) {
    const startLine = node.sourceCodeLocation?.startLine;
    // A comment with no location cannot be matched to a line, and a directive that silently applied
    // to the wrong line would be worse than one that does not apply at all.
    if (typeof startLine === "number" && typeof node.data === "string") {
      into.push({ text: node.data, startLine });
    }
  }
  for (const child of getChildNodes(node)) collectComments(child, into);
  return into;
}

/** Parse static HTML into a runtime-agnostic `UiDocument`. */
export function parseHtml(html: string, options: ParseHtmlOptions = {}): UiDocument {
  const document = parse(html, {
    sourceCodeLocationInfo: true,
  }) as unknown as P5Node;
  const rootElement = findRootElement(document);

  // Claimed from the option, not from what the tree happened to contain. A document of one
  // attribute-less element supplies ranges just as much as a crowded one — it simply has none to
  // report, and a capability that appeared and disappeared with the markup would be unusable.
  const capabilities = options.sourceRanges ? SOURCE_RANGE_CAPABILITIES : undefined;

  if (!rootElement) {
    return createUiDocument({
      root: emptyRoot(options.file),
      runtime: "html",
      metadata: {
        file: options.file,
        ...(options.sourceChecksum ? { sourceChecksum: options.sourceChecksum } : {}),
      },
      pageContexts: [{ context: "unknown", confidence: "low" }],
      ...(capabilities ? { capabilities } : {}),
    });
  }

  const state: BuildState = {
    file: options.file,
    html,
    sourceRanges: options.sourceRanges === true,
    htmlIds: new Map(),
    all: [],
    depth: 0,
  };
  const root = buildElement(rootElement, [0], undefined, undefined, state);
  resolveLabelledBy(state);

  const title = extractTitle(state.all);
  const pageContexts = detectPageContexts(
    root.normalizedText,
    title ? normalizeText(title) : undefined,
  );

  // From the whole document, not from `rootElement`: a directive above `<html>` is still a comment
  // in the file, and dropping it would make the same comment work or not depending on where in the
  // document it sits.
  const comments = collectComments(document, []);

  return createUiDocument({
    root,
    runtime: "html",
    metadata: {
      file: options.file,
      title,
      locale: extractLocale(root),
      ...(options.sourceChecksum ? { sourceChecksum: options.sourceChecksum } : {}),
    },
    pageContexts,
    ...(capabilities ? { capabilities } : {}),
    ...(comments.length > 0 ? { comments } : {}),
  });
}

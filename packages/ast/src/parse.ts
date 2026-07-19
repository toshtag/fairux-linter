import {
  createUiDocument,
  detectPageContexts,
  InputTooLargeError,
  MAX_NODE_COUNT,
  MAX_TREE_DEPTH,
  normalizeText,
  type UiDocument,
  type UiNode,
} from "@fairux/core";
import ts from "typescript";

export interface ParseSourceOptions {
  /** Recorded into node/finding source locations and document metadata. */
  file?: string;
}

// Boolean shorthand JSX attributes (`<input checked />`) imply `true`, like HTML.
const BOOLEAN_ATTRS = new Set([
  "checked",
  "disabled",
  "readonly",
  "required",
  "selected",
  "multiple",
  "open",
  "hidden",
]);

/** A JSX element node in either form. */
type JsxElementLike = ts.JsxElement | ts.JsxSelfClosingElement;

interface BuildState {
  file?: string;
  source: ts.SourceFile;
  all: UiNode[];
  ids: Map<string, UiNode>;
  depth: number;
}

function tagNameOf(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string {
  return opening.tagName.getText(opening.getSourceFile());
}

/** Capitalized tag = a component (`<Foo>`); lowercase = an intrinsic element (`<div>`). */
function isComponentTag(name: string): boolean {
  return /^[A-Z]/.test(name) || name.includes(".");
}

function lineColOf(
  node: ts.Node,
  source: ts.SourceFile,
): { startLine: number; startColumn: number } {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { startLine: line + 1, startColumn: character + 1 }; // 1-based
}

interface AttrResult {
  attributes: Record<string, string | true>;
  /** Names whose values are expressions we can't evaluate — recorded, never asserted as values. */
  dynamic: string[];
}

function readAttributes(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement): AttrResult {
  const attributes: Record<string, string | true> = {};
  const dynamic: string[] = [];

  for (const prop of opening.attributes.properties) {
    if (ts.isJsxSpreadAttribute(prop)) {
      // {...spread}: the whole attribute set is partly unknown. Record the fact, assert nothing.
      dynamic.push("...spread");
      continue;
    }
    if (!ts.isJsxAttribute(prop)) continue;
    const rawName = prop.name.getText(prop.getSourceFile());
    // JSX uses className/htmlFor; normalize to the DOM-ish names rules expect.
    const name = rawName === "className" ? "class" : rawName === "htmlFor" ? "for" : rawName;

    const init = prop.initializer;
    if (init === undefined) {
      // Boolean shorthand: <input checked />
      attributes[name] = true;
      continue;
    }
    if (ts.isStringLiteral(init)) {
      attributes[name] = init.text;
      continue;
    }
    if (init && ts.isJsxExpression(init)) {
      const expr = init.expression;
      // A string-literal expression (checked={"x"} / aria-label={"Close"}) is still static.
      if (expr && ts.isStringLiteral(expr)) {
        attributes[name] = expr.text;
        continue;
      }
      if (expr && expr.kind === ts.SyntaxKind.TrueKeyword) {
        if (BOOLEAN_ATTRS.has(name)) attributes[name] = true;
        else attributes[name] = "true";
        continue;
      }
      // Any other expression (checked={isOn}, className={cx(...)}): UNKNOWN. Do NOT assert a value.
      dynamic.push(name);
      continue;
    }
    dynamic.push(name);
  }

  return { attributes, dynamic };
}

/** Static text owned directly by a JSX element: literal JSX text + string-literal `{"..."}`. */
function directTextOf(el: ts.JsxElement): string {
  let raw = "";
  for (const child of el.children) {
    if (ts.isJsxText(child)) {
      raw += child.text;
    } else if (
      ts.isJsxExpression(child) &&
      child.expression &&
      ts.isStringLiteral(child.expression)
    ) {
      raw += child.expression.text;
    }
    // Dynamic expression children ({label}, {n} left) contribute NOTHING — no guessing (ADR §4).
  }
  return raw.replace(/\s+/g, " ").trim();
}

function childElementsOf(el: ts.JsxElement): JsxElementLike[] {
  return el.children.filter(
    (c): c is JsxElementLike => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c),
  );
}

function openingOf(el: JsxElementLike): ts.JsxOpeningElement | ts.JsxSelfClosingElement {
  return ts.isJsxElement(el) ? el.openingElement : el;
}

function strAttr(attributes: Record<string, string | true>, name: string): string | undefined {
  const v = attributes[name];
  return typeof v === "string" ? v : undefined;
}

function buildElement(
  el: JsxElementLike,
  path: number[],
  parentId: string | undefined,
  state: BuildState,
): UiNode {
  if (state.all.length >= MAX_NODE_COUNT) {
    throw new InputTooLargeError(MAX_NODE_COUNT, state.all.length, "nodes");
  }
  if (state.depth >= MAX_TREE_DEPTH) {
    throw new InputTooLargeError(MAX_TREE_DEPTH, state.depth, "depth");
  }
  state.depth++;
  const opening = openingOf(el);
  const rawTag = tagNameOf(opening);
  const component = isComponentTag(rawTag);
  const tag = rawTag.toLowerCase();
  const { attributes, dynamic } = readAttributes(opening);
  if (component) attributes["data-fairux-component"] = rawTag;
  if (dynamic.length > 0) attributes["data-fairux-dynamic"] = dynamic.join(" ");

  const id = path.join(".");
  const htmlId = strAttr(attributes, "id");
  const role = strAttr(attributes, "role");

  const directText = ts.isJsxElement(el) ? directTextOf(el) : "";
  const accessibility = explicitName(tag, attributes);

  const node: UiNode = {
    id,
    parentId,
    tag,
    role,
    attributes,
    directText,
    subtreeText: "",
    normalizedText: "",
    accessibility,
    children: [],
    locator: {
      type: "ast",
      file: state.file ?? "",
      ...lineColOf(opening, state.source),
    },
    source: { file: state.file, ...lineColOf(opening, state.source) },
  };

  state.all.push(node);
  if (htmlId) state.ids.set(htmlId, node);

  const kids = ts.isJsxElement(el) ? childElementsOf(el) : [];
  node.children = kids.map((child, i) => buildElement(child, [...path, i], id, state));

  state.depth--;
  const childText = node.children.map((c) => c.subtreeText).join(" ");
  node.subtreeText = [node.directText, childText].filter(Boolean).join(" ");
  node.normalizedText = normalizeText(node.subtreeText);
  return node;
}

const ALT_TAGS = new Set(["img", "area", "input"]);

/** Best-effort accessible name from static attributes (aria-label / alt). Matches other adapters. */
function explicitName(
  tag: string,
  attributes: Record<string, string | true>,
): UiNode["accessibility"] {
  const ariaLabel = strAttr(attributes, "aria-label");
  if (ariaLabel) return { name: ariaLabel, nameSource: "aria-label" };
  if (ALT_TAGS.has(tag)) {
    const alt = strAttr(attributes, "alt");
    const isImageInput = tag !== "input" || strAttr(attributes, "type")?.toLowerCase() === "image";
    if (alt && isImageInput) return { name: alt, nameSource: "alt" };
  }
  return undefined;
}

/** Find the top-level JSX elements in the file (collecting the outermost JSX of each tree). */
function findRootJsx(source: ts.SourceFile): JsxElementLike[] {
  const roots: JsxElementLike[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      roots.push(node);
      return; // don't descend; children are walked by buildElement
    }
    if (ts.isJsxFragment(node)) {
      // A fragment isn't an element; collect its element children as roots.
      for (const child of node.children) {
        if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) roots.push(child);
        else ts.forEachChild(child, visit);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return roots;
}

function syntheticRoot(roots: UiNode[]): UiNode {
  // Wrap multiple top-level JSX trees under a synthetic <fragment> so UiDocument has one root.
  const childText = roots.map((c) => c.subtreeText).join(" ");
  return {
    id: "root",
    tag: "fragment",
    attributes: {},
    directText: "",
    subtreeText: childText,
    normalizedText: normalizeText(childText),
    children: roots,
    locator: { type: "path", value: [] },
  };
}

/** Parse JSX/TSX source into a runtime-agnostic `UiDocument` (`runtime: "ast"`). */
export function parseSource(code: string, options: ParseSourceOptions = {}): UiDocument {
  const source = ts.createSourceFile(
    options.file ?? "input.tsx",
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
  const state: BuildState = {
    file: options.file,
    source,
    all: [],
    ids: new Map(),
    depth: 0,
  };

  const jsxRoots = findRootJsx(source);
  const builtRoots = jsxRoots.map((el, i) => buildElement(el, [i], "root", state));

  let root: UiNode;
  if (builtRoots.length === 1) {
    const only = builtRoots[0] as UiNode;
    only.parentId = undefined;
    root = only;
  } else {
    root = syntheticRoot(builtRoots);
    for (const child of builtRoots) child.parentId = "root";
  }

  const title = options.file;
  const pageContexts = detectPageContexts(
    root.normalizedText,
    title ? normalizeText(title) : undefined,
  );

  return createUiDocument({
    root,
    runtime: "ast",
    metadata: { file: options.file },
    pageContexts,
  });
}

import {
  createUiDocument,
  type DocumentComment,
  detectPageContexts,
  InputTooLargeError,
  MAX_NODE_COUNT,
  MAX_TREE_DEPTH,
  normalizeText,
  type UiDocument,
  type UiNode,
} from "@fairux/core";
import * as ts from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";

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

const VIRTUAL_CWD = "/fairux-ast";
const VIRTUAL_FILE = `${VIRTUAL_CWD}/input.tsx`;

function withSourceFile<T>(code: string, build: (source: ts.SourceFile) => T): T {
  const api = new API({
    cwd: VIRTUAL_CWD,
    fs: createVirtualFileSystem({ [VIRTUAL_FILE]: code }),
  });
  try {
    const snapshot = api.updateSnapshot({ openFiles: [VIRTUAL_FILE] });
    const project = snapshot.getDefaultProjectForFile(VIRTUAL_FILE);
    const source = project?.program.getSourceFile(VIRTUAL_FILE);
    if (!source) {
      throw new Error("Unable to parse TSX source with the TypeScript API.");
    }
    return build(source);
  } finally {
    api.close();
  }
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

/**
 * A node's position, both ends, for `source` — not for the locator.
 *
 * An `ast` locator names a start and nothing else, and its shape is checked field by field, so the
 * end belongs only where a consumer draws a range. `node.getEnd()` is exclusive already and needs
 * the same 1-based shift as the start.
 *
 * Reported for the same reason the HTML adapter reports one: a consumer drawing a range had to
 * invent an end, and the end of the start line is wrong for anything spanning more than one.
 */
function spanOf(
  node: ts.Node,
  source: ts.SourceFile,
): { startLine: number; startColumn: number; endLine: number; endColumn: number } {
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  return { ...lineColOf(node, source), endLine: end.line + 1, endColumn: end.character + 1 };
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
    throw new InputTooLargeError(MAX_NODE_COUNT, state.all.length + 1, "nodes");
  }
  if (state.depth >= MAX_TREE_DEPTH) {
    throw new InputTooLargeError(MAX_TREE_DEPTH, state.depth + 1, "depth");
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
    source: { file: state.file, ...spanOf(opening, state.source) },
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
/**
 * Every comment in the file, with the line it starts on.
 *
 * Collected from each node's **leading trivia** rather than from the tree, because a comment is not
 * a node: `{/* … *\/}` parses as a `JsxExpression` with no expression, and the comment inside it
 * never becomes one. Walking for comment nodes finds nothing at all.
 *
 * Every node is asked, and positions are deduplicated, because one comment is leading trivia of
 * several nodes at once — a token, its parent, and its parent's parent all share a full start.
 *
 * Only the body is kept, without delimiters, so the directive grammar is the one the HTML adapter
 * feeds and does not have to know which language a comment came from.
 */
function collectComments(source: ts.SourceFile): DocumentComment[] {
  const text = source.getFullText();
  const seen = new Set<number>();
  const comments: DocumentComment[] = [];

  const collectAt = (fullStart: number, trailing = false): void => {
    // Leading and trailing are TypeScript's own distinction, and it is positional rather than
    // semantic: `getLeadingCommentRanges` returns nothing unless the position is 0 or follows a line
    // break, so a comment sitting after `{` on the same line is only reachable as *trailing* trivia.
    // That is exactly the `{/* … *\/}` form, which is the one JSX users write.
    const ranges = trailing
      ? ts.getTrailingCommentRanges(text, fullStart)
      : ts.getLeadingCommentRanges(text, fullStart);
    for (const range of ranges ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      const raw = text.slice(range.pos, range.end);
      const body =
        range.kind === ts.SyntaxKind.SingleLineCommentTrivia
          ? raw.replace(/^\/\//, "")
          : raw.replace(/^\/\*/, "").replace(/\*\/$/, "");
      comments.push({
        text: body,
        // TypeScript counts lines from 0; evidence `source.startLine` counts from 1.
        startLine: source.getLineAndCharacterOfPosition(range.pos).line + 1,
      });
    }
  };

  // `node.forEachChild`, the method — this build of the compiler's unstable AST API exposes the
  // walk on the node rather than as a free function, which is also how `findRootJsx` below walks.
  const visit = (node: ts.Node): void => {
    collectAt(node.getFullStart());
    // `{/* … *\/}` is the form JSX users actually write, and `forEachChild` never reaches it: the
    // comment is leading trivia of the closing brace, and the walk visits nodes rather than tokens.
    // A `JsxExpression` with no expression is exactly a braced comment, so the position just inside
    // its opening brace is asked directly.
    if (node.kind === ts.SyntaxKind.JsxExpression) collectAt(node.getStart(source) + 1, true);
    node.forEachChild(visit);
  };
  collectAt(source.getFullStart());
  source.forEachChild(visit);
  // The end-of-file token's trivia holds a comment on the last line, which no other node owns.
  collectAt(source.endOfFileToken.getFullStart());

  comments.sort((a, b) => a.startLine - b.startLine);
  return comments;
}

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
        else child.forEachChild(visit);
      }
      return;
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
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
  return withSourceFile(code, (source) => {
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

    const comments = collectComments(source);

    return createUiDocument({
      root,
      runtime: "ast",
      metadata: { file: options.file },
      pageContexts,
      ...(comments.length > 0 ? { comments } : {}),
    });
  });
}

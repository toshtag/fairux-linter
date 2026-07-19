import {
  createUiDocument,
  detectPageContexts,
  InputTooLargeError,
  type Locale,
  MAX_INPUT_BYTES,
  MAX_NODE_COUNT,
  MAX_TREE_DEPTH,
  normalizeText,
  type UiDocument,
  type UiNode,
} from "@fairux/core";

export interface ParseFigmaOptions {
  file?: string;
  locale?: Locale;
}

/**
 * Figma REST API node types per https://developers.figma.com/docs/rest-api/file-node-types/
 * Note: BUTTON, CHECKBOX, INPUT, RADIO, TOGGLE do NOT exist as REST node types.
 * Real buttons/checkboxes are COMPONENT/INSTANCE nodes with componentPropertyDefinitions
 * or are inferred from node name conventions.
 */
interface FigmaComponentPropertyDefinitions {
  [key: string]: {
    type: "BOOLEAN" | "TEXT" | "INSTANCE_SWAP" | "VARIANT";
    defaultValue?: string | boolean;
  };
}

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];
  characters?: string;
  style?: Record<string, unknown>;
  fills?: unknown[];
  componentPropertyDefinitions?: FigmaComponentPropertyDefinitions;
  componentProperties?: Record<string, { type: string; value: string | boolean }>;
  mainComponent?: { name: string; id: string };
}

interface FigmaFile {
  document?: FigmaNode;
  name?: string;
  lastModified?: string;
}

interface ParseContext {
  nodeCount: number;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function componentPropertyBaseName(name: string): string {
  return name
    .replace(/#[^#]+$/u, "")
    .trim()
    .toLowerCase();
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

const TEXT_NODE_TYPES = new Set(["TEXT", "STICKY", "SHAPE_WITH_TEXT"]);

/**
 * Infer semantic HTML tag from a Figma node using real REST API types.
 * COMPONENT/INSTANCE nodes are inferred from their name (e.g. "Button/Buy" → button)
 * and conservative componentPropertyDefinitions (e.g. { "Checked": { type: "BOOLEAN" } }).
 * Confidence is inherently low for name-based inference.
 */
function figmaTypeToTag(node: FigmaNode): string {
  // Direct type mappings for real Figma REST API node types
  switch (node.type) {
    case "FRAME":
    case "GROUP":
    case "SECTION":
    case "CANVAS":
    case "DOCUMENT":
    case "COMPONENT":
    case "COMPONENT_SET":
    case "INSTANCE":
      // Infer from component name / properties for COMPONENT and INSTANCE
      if (node.type === "COMPONENT" || node.type === "INSTANCE") {
        const inferred = inferTagFromComponent(node);
        if (inferred) return inferred;
      }
      return "div";
    case "TEXT":
    case "STICKY":
      return "span";
    case "RECTANGLE":
    case "ELLIPSE":
    case "LINE":
    case "VECTOR":
    case "STAR":
    case "POLYGON":
      return "img";
    default:
      return "div";
  }
}

/**
 * Conservatively infer an HTML tag from a COMPONENT/INSTANCE node's name and
 * componentPropertyDefinitions. Returns null if no confident inference can be made.
 *
 * Heuristics (low confidence):
 * - Name contains "button" → "button"
 * - Name contains "checkbox" or has a BOOLEAN property exactly named "checked" → "input" with type=checkbox
 * - Name contains "radio" → "input" with type=radio
 * - Name contains "toggle" or "switch" → "input" with type=checkbox
 * - Name contains "input" or "text field" → "input" with type=text
 */
function inferTagFromComponent(node: FigmaNode): string | null {
  const nameLower = node.name.toLowerCase();

  // Name-based inference should take priority over ambiguous boolean properties
  // Clear component names like "Button/..." should be buttons regardless of boolean props
  if (nameLower.includes("button") || nameLower.includes("btn")) return "button";

  if (nameLower.includes("checkbox") || nameLower.includes("check box")) return "input";
  if (nameLower.includes("radio")) return "input";
  if (nameLower.includes("toggle") || nameLower.includes("switch")) return "input";
  if (nameLower.includes("input") || nameLower.includes("text field")) return "input";

  // A BOOLEAN property exactly named "Checked" is strong enough to infer checkbox semantics.
  // Generic state flags such as Enabled/Selected/On/Toggled are too broad for conservative mapping.
  const propDefs = node.componentPropertyDefinitions;
  if (propDefs) {
    for (const [propName, propDef] of Object.entries(propDefs)) {
      if (propDef.type === "BOOLEAN" && componentPropertyBaseName(propName) === "checked") {
        return "input";
      }
    }
  }

  const props = node.componentProperties;
  if (props) {
    for (const [propName, propDef] of Object.entries(props)) {
      if (propDef.type === "BOOLEAN" && componentPropertyBaseName(propName) === "checked") {
        return "input";
      }
    }
  }

  return null;
}

/**
 * Infer input type attribute from component name/properties.
 * Only meaningful when inferTagFromComponent returned "input".
 */
function inferInputType(node: FigmaNode): string {
  const nameLower = node.name.toLowerCase();
  if (nameLower.includes("checkbox") || nameLower.includes("check box")) return "checkbox";
  if (nameLower.includes("radio")) return "radio";
  if (nameLower.includes("toggle") || nameLower.includes("switch")) return "checkbox";

  const propDefs = node.componentPropertyDefinitions;
  if (propDefs) {
    for (const [propName, propDef] of Object.entries(propDefs)) {
      if (propDef.type === "BOOLEAN") {
        const propLower = componentPropertyBaseName(propName);
        if (propLower === "checked") return "checkbox";
        if (propLower === "selected" && nameLower.includes("radio")) return "radio";
      }
    }
  }
  const props = node.componentProperties;
  if (props) {
    for (const [propName, propDef] of Object.entries(props)) {
      if (propDef.type === "BOOLEAN") {
        const propLower = componentPropertyBaseName(propName);
        if (propLower === "checked") return "checkbox";
        if (propLower === "selected" && nameLower.includes("radio")) return "radio";
      }
    }
  }

  return "text";
}

function booleanPropertyValue(node: FigmaNode, name: string): boolean | undefined {
  const expected = name.toLowerCase();
  for (const [propName, prop] of Object.entries(node.componentProperties ?? {})) {
    if (componentPropertyBaseName(propName) === expected && prop.type === "BOOLEAN") {
      return typeof prop.value === "boolean" ? prop.value : undefined;
    }
  }
  for (const [propName, prop] of Object.entries(node.componentPropertyDefinitions ?? {})) {
    if (componentPropertyBaseName(propName) === expected && prop.type === "BOOLEAN") {
      return typeof prop.defaultValue === "boolean" ? prop.defaultValue : undefined;
    }
  }
  return undefined;
}

function figmaAttrs(node: FigmaNode): Record<string, string | true> {
  const attrs: Record<string, string | true> = {};
  if (node.visible === false) attrs.hidden = true;
  if (node.name) attrs["data-figma-name"] = node.name;
  if (node.characters) attrs.value = node.characters;

  // Infer input type for COMPONENT/INSTANCE nodes that resolved to <input>
  if (node.type === "COMPONENT" || node.type === "INSTANCE") {
    const tag = figmaTypeToTag(node);
    if (tag === "input") {
      attrs.type = inferInputType(node);
      const checked =
        attrs.type === "radio"
          ? booleanPropertyValue(node, "selected") === true ||
            booleanPropertyValue(node, "checked") === true
          : attrs.type === "checkbox" && booleanPropertyValue(node, "checked") === true;
      if (checked) {
        attrs.checked = true;
      }
    }
  }

  return attrs;
}

function convertNode(
  node: FigmaNode,
  parentId: string | undefined,
  depth: number,
  ctx: ParseContext,
): UiNode {
  if (ctx.nodeCount >= MAX_NODE_COUNT) {
    throw new InputTooLargeError(MAX_NODE_COUNT, ctx.nodeCount + 1, "nodes");
  }
  if (depth > MAX_TREE_DEPTH) {
    throw new InputTooLargeError(MAX_TREE_DEPTH, depth, "depth");
  }
  ctx.nodeCount++;

  const id = node.id;
  const tag = figmaTypeToTag(node);
  const directText = TEXT_NODE_TYPES.has(node.type) ? (node.characters ?? "") : "";
  const children: UiNode[] = [];
  let subtreeText = directText;

  for (const child of node.children ?? []) {
    const converted = convertNode(child, id, depth + 1, ctx);
    children.push(converted);
    subtreeText += ` ${converted.subtreeText}`;
  }

  const normalizedText = normalizeText(subtreeText);
  const uiNode: UiNode = {
    id,
    parentId,
    tag,
    attributes: figmaAttrs(node),
    directText: collapse(directText),
    subtreeText: collapse(subtreeText),
    normalizedText,
    children,
    locator: { type: "figma", nodeId: id },
  };

  if (TEXT_NODE_TYPES.has(node.type) && node.characters) {
    uiNode.accessibility = {
      name: collapse(node.characters),
      nameSource: "text",
    };
  }

  return uiNode;
}

/**
 * Parse a Figma REST API JSON response into a UiDocument.
 *
 * EXPERIMENTAL: This adapter infers semantic HTML tags from Figma node types,
 * component names, and componentPropertyDefinitions. Inference is conservative
 * and low-confidence — real Figma files use COMPONENT/INSTANCE nodes (not
 * BUTTON/CHECKBOX types), so tag mapping is heuristic.
 *
 * Throws InputTooLargeError when node count or tree depth exceeds limits
 * (does NOT silently truncate).
 */
export function parseFigma(json: string, options: ParseFigmaOptions = {}): UiDocument {
  const actualBytes = utf8ByteLength(json);
  if (actualBytes > MAX_INPUT_BYTES) {
    throw new InputTooLargeError(MAX_INPUT_BYTES, actualBytes, "bytes");
  }

  const data = JSON.parse(json) as FigmaFile;
  const root = data.document;
  if (!root) {
    throw new Error("Figma JSON has no document node");
  }

  const file = options.file ?? "figma";
  const uiRoot = convertNode(root, undefined, 0, { nodeCount: 0 });

  const doc = createUiDocument({
    root: uiRoot,
    runtime: "figma",
    metadata: {
      file,
      title: data.name,
      locale: options.locale ?? "unknown",
    },
  });

  doc.pageContexts = detectPageContexts(uiRoot.normalizedText, data.name);
  return doc;
}

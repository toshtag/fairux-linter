import { createNodeQueries } from "./queries.js";
import type { UiDocument, UiNode, UiSemantics } from "./types.js";

const BUTTON_INPUT_TYPES = new Set(["button", "submit", "reset", "image"]);
const INPUT_TAGS = new Set(["input", "textarea", "select"]);

function attrString(node: UiNode, name: string): string | undefined {
  const value = node.attributes[name];
  return typeof value === "string" ? value : undefined;
}

export function createUiSemantics(doc: UiDocument): UiSemantics {
  const queries = createNodeQueries(doc);

  const isButtonLike = (node: UiNode): boolean => {
    if (node.tag === "button") return true;
    if (node.role === "button") return true;
    if (node.tag === "input") {
      const type = attrString(node, "type")?.toLowerCase();
      return type !== undefined && BUTTON_INPUT_TYPES.has(type);
    }
    return false;
  };

  const isLinkLike = (node: UiNode): boolean => {
    if (node.tag === "a" && "href" in node.attributes) return true;
    return node.role === "link";
  };

  const isInput = (node: UiNode): boolean => INPUT_TAGS.has(node.tag);

  const getControlLabel = (node: UiNode): string => {
    const direct = node.accessibility?.name ?? node.subtreeText.trim();
    if (direct) return direct;

    const htmlId = attrString(node, "id");
    if (htmlId) {
      const labelFor = doc.findAll((n) => n.tag === "label" && attrString(n, "for") === htmlId)[0];
      if (labelFor) return labelFor.subtreeText.trim();
    }

    const wrappingLabel = queries.closest(node, (n) => n.tag === "label");
    if (wrappingLabel && wrappingLabel.id !== node.id) return wrappingLabel.subtreeText.trim();

    return attrString(node, "value") ?? "";
  };

  return { isButtonLike, isLinkLike, isInput, getControlLabel };
}

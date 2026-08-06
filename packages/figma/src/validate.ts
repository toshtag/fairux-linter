/**
 * What this adapter requires of a Figma REST payload, checked rather than assumed.
 *
 * `JSON.parse(json) as FigmaFile` is a claim, not a check. Every field below was read straight off
 * the parsed value: `node.name.toLowerCase()` threw on a node with no name, a `children` that was an
 * object walked into nothing, a `componentProperties` entry whose `value` was a string was compared
 * against `true` and quietly answered no, and two nodes sharing an `id` produced two findings
 * pointing at one `{ type: "figma", nodeId }` locator — which is also part of the fingerprint, so
 * they collided.
 *
 * Only the consumed shape is validated. A Figma file carries hundreds of fields this adapter never
 * reads; requiring them would refuse real exports for no gain, and inventing them would be worse.
 * Unknown fields are ignored, so a payload from a later API version stays readable.
 *
 * The traversal is bounded by the same `MAX_NODE_COUNT` and `MAX_TREE_DEPTH` the conversion is —
 * validation happens inside it, so a payload cannot be made expensive to reject.
 */

/** A payload this adapter cannot read, with the path to the part that is wrong. */
export class FigmaParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FigmaParseError";
  }
}

/**
 * The consumed shape of a Figma node. Every field here is read by this adapter; nothing else is
 * declared, so a reader can tell what the adapter depends on from the type alone.
 *
 * `mainComponent` used to be declared here and is gone. It is a **Plugin API** property, not a REST
 * one — the REST file response gives an `INSTANCE` a `componentId` string referring to the file's
 * components table — and nothing read it. A field that is both wrong and unread is a claim about
 * the API that no code or test would ever contradict.
 */
export interface FigmaNode {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly visible?: boolean;
  readonly children?: readonly FigmaNode[];
  readonly characters?: string;
  readonly componentPropertyDefinitions?: Readonly<
    Record<string, { readonly type: string; readonly defaultValue?: string | boolean }>
  >;
  readonly componentProperties?: Readonly<
    Record<string, { readonly type: string; readonly value: string | boolean }>
  >;
}

/** The consumed shape of a Figma file response: the tree, and the file name used as a title. */
export interface FigmaFile {
  readonly document: FigmaNode;
  readonly name?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Parse the JSON and check the envelope. The tree is checked node by node as it is converted, so a
 * huge malformed payload is refused under the same limits a huge valid one is.
 */
export function parseFigmaFile(json: string): FigmaFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new FigmaParseError(`Figma JSON is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) {
    throw new FigmaParseError(
      `Figma JSON is not an object — found ${Array.isArray(parsed) ? "an array" : typeof parsed}`,
    );
  }
  if (parsed.document === undefined) {
    throw new FigmaParseError("Figma JSON has no document node");
  }
  if (parsed.name !== undefined && typeof parsed.name !== "string") {
    throw new FigmaParseError("Figma JSON has a name that is not a string");
  }
  assertFigmaNode(parsed.document, "document");
  return parsed as unknown as FigmaFile;
}

/**
 * Check one node's consumed fields. Its children are checked as the walk reaches them, not here, so
 * the depth and node-count limits apply to validation exactly as they apply to conversion.
 */
export function assertFigmaNode(value: unknown, path: string): asserts value is FigmaNode {
  if (!isRecord(value)) {
    throw new FigmaParseError(
      `Figma node at ${path} is not an object — found ${value === null ? "null" : typeof value}`,
    );
  }
  if (!nonEmptyString(value.id)) {
    throw new FigmaParseError(`Figma node at ${path} has no id`);
  }
  const at = `${path} (${value.id})`;
  if (!nonEmptyString(value.type)) {
    throw new FigmaParseError(`Figma node at ${at} has no type`);
  }
  if (!nonEmptyString(value.name)) {
    // Read by the tag inference and written into `data-figma-name`. A node without one used to
    // throw a `TypeError` from inside the inference, several frames away from the cause.
    throw new FigmaParseError(`Figma node at ${at} has no name`);
  }
  if (value.visible !== undefined && typeof value.visible !== "boolean") {
    throw new FigmaParseError(`Figma node at ${at} has a visible that is not a boolean`);
  }
  if (value.characters !== undefined && typeof value.characters !== "string") {
    throw new FigmaParseError(`Figma node at ${at} has characters that are not a string`);
  }
  if (value.children !== undefined && !Array.isArray(value.children)) {
    throw new FigmaParseError(`Figma node at ${at} has children that are not an array`);
  }
  assertPropertyRecord(value.componentPropertyDefinitions, "componentPropertyDefinitions", at, [
    "defaultValue",
  ]);
  assertPropertyRecord(value.componentProperties, "componentProperties", at, ["value"]);
}

/**
 * Both component-property maps, checked the one way.
 *
 * The inference reads `type` and compares `value`/`defaultValue` against `true`, so an entry whose
 * `type` is missing simply never matched and an entry whose value is the string `"true"` answered
 * "not checked" — a pre-checked consent control that reads as unchecked is a false negative in the
 * one direction this project cannot afford to be quiet about.
 */
function assertPropertyRecord(
  value: unknown,
  field: string,
  at: string,
  valueKeys: readonly string[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new FigmaParseError(`Figma node at ${at} has a ${field} that is not an object`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) {
      throw new FigmaParseError(
        `Figma node at ${at} has a ${field}["${key}"] that is not an object`,
      );
    }
    if (!nonEmptyString(entry.type)) {
      throw new FigmaParseError(`Figma node at ${at} has a ${field}["${key}"] with no type`);
    }
    for (const valueKey of valueKeys) {
      const held = entry[valueKey];
      if (held === undefined) continue;
      if (typeof held !== "string" && typeof held !== "boolean") {
        throw new FigmaParseError(
          `Figma node at ${at} has a ${field}["${key}"].${valueKey} that is neither a string nor a boolean`,
        );
      }
    }
  }
}

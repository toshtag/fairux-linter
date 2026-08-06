import { describe, expect, it } from "vitest";
import { FigmaParseError, parseFigma } from "../src/index.js";

/**
 * What the Figma adapter refuses, and why each refusal is not pedantry.
 *
 * `JSON.parse(json) as FigmaFile` is a claim, not a check, and every field it claimed was then read
 * straight off the parsed value. The failures were not uniform: some threw a `TypeError` several
 * frames from the cause, and some — the ones that matter — were silent. A `componentProperties`
 * entry whose `value` is the string `"true"` was compared against `true`, answered "not checked",
 * and produced a clean report for a pre-checked consent control. Two nodes sharing an `id` produced
 * two findings pointing at one `{ type: "figma", nodeId }` locator, which is also what the
 * fingerprint is built from.
 *
 * This adapter stays experimental and its tag inference stays heuristic. What is not heuristic is
 * whether the input is the shape it consumes.
 */

const node = (over: Record<string, unknown> = {}) => ({
  id: "1:1",
  name: "Frame",
  type: "FRAME",
  ...over,
});

const file = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "Design", document: node(), ...over });

const withDocument = (document: unknown) => JSON.stringify({ name: "Design", document });

describe("a payload that is not a Figma file", () => {
  it("refuses malformed JSON with an adapter error, not a raw SyntaxError", () => {
    expect(() => parseFigma("{ not json")).toThrow(FigmaParseError);
    expect(() => parseFigma("{ not json")).toThrow(/is not valid JSON/);
  });

  it("refuses a top-level value that is not an object", () => {
    for (const json of ["[]", '"design"', "42", "null"]) {
      expect(() => parseFigma(json), json).toThrow(/is not an object/);
    }
  });

  it("refuses a file with no document, and one whose name is not a string", () => {
    expect(() => parseFigma(JSON.stringify({ name: "Design" }))).toThrow(/no document node/);
    expect(() => parseFigma(file({ name: 7 }))).toThrow(/name that is not a string/);
  });
});

describe("a node that is not a node", () => {
  it("refuses a document that is not an object", () => {
    for (const document of [null, 42, "root", ["a"]]) {
      expect(() => parseFigma(withDocument(document)), JSON.stringify(document)).toThrow(
        /is not an object/,
      );
    }
  });

  it("refuses a node with no id, type, or name", () => {
    expect(() => parseFigma(withDocument(node({ id: undefined })))).toThrow(/has no id/);
    expect(() => parseFigma(withDocument(node({ id: "" })))).toThrow(/has no id/);
    expect(() => parseFigma(withDocument(node({ type: undefined })))).toThrow(/has no type/);
    // The one that used to throw a `TypeError` from inside `name.toLowerCase()`.
    expect(() => parseFigma(withDocument(node({ name: undefined })))).toThrow(/has no name/);
  });

  it("names the node that is wrong, by id and by path", () => {
    const json = withDocument(
      node({ children: [node({ id: "2:2", name: "Row" }), node({ id: "3:3", type: 7 })] }),
    );
    expect(() => parseFigma(json)).toThrow(/1:1\.children\[1\] \(3:3\)/);
  });

  it("refuses children that are not an array, and a child that is not an object", () => {
    expect(() => parseFigma(withDocument(node({ children: { first: node() } })))).toThrow(
      /children that are not an array/,
    );
    expect(() => parseFigma(withDocument(node({ children: [null] })))).toThrow(/is not an object/);
  });

  it("refuses a visible or characters of the wrong type", () => {
    expect(() => parseFigma(withDocument(node({ visible: "false" })))).toThrow(
      /visible that is not a boolean/,
    );
    expect(() => parseFigma(withDocument(node({ type: "TEXT", characters: 42 })))).toThrow(
      /characters that are not a string/,
    );
  });
});

describe("component property records", () => {
  const component = (props: Record<string, unknown>) =>
    withDocument(
      node({
        children: [
          { id: "2:2", name: "Checkbox/Marketing", type: "COMPONENT", componentProperties: props },
        ],
      }),
    );

  it("refuses a map that is not an object, and an entry that is not an object", () => {
    expect(() =>
      parseFigma(withDocument(node({ componentProperties: [{ type: "BOOLEAN" }] }))),
    ).toThrow(/componentProperties that is not an object/);
    expect(() => parseFigma(component({ "Checked#0:1": "true" }))).toThrow(
      /componentProperties\["Checked#0:1"\] that is not an object/,
    );
  });

  it("refuses an entry with no type, which silently matched nothing", () => {
    expect(() => parseFigma(component({ "Checked#0:1": { value: true } }))).toThrow(
      /componentProperties\["Checked#0:1"\] with no type/,
    );
  });

  it("refuses a value that is neither a string nor a boolean", () => {
    expect(() => parseFigma(component({ "Checked#0:1": { type: "BOOLEAN", value: 1 } }))).toThrow(
      /neither a string nor a boolean/,
    );
    expect(() =>
      parseFigma(
        withDocument(
          node({
            children: [
              {
                id: "2:2",
                name: "Checkbox",
                type: "COMPONENT",
                componentPropertyDefinitions: {
                  "Checked#0:1": { type: "BOOLEAN", defaultValue: 1 },
                },
              },
            ],
          }),
        ),
      ),
    ).toThrow(/neither a string nor a boolean/);
  });

  it("still reads a well-formed pre-checked component", () => {
    // The refusals above must not be passing because the inference stopped working.
    const doc = parseFigma(component({ "Checked#0:1": { type: "BOOLEAN", value: true } }));
    const input = doc.findAll((n) => n.tag === "input")[0];
    expect(input?.attributes.type).toBe("checkbox");
    expect(input?.attributes.checked).toBe(true);
  });
});

describe("node ids", () => {
  it("refuses the same id twice, anywhere in the tree", () => {
    // The id is the whole of the locator and part of the fingerprint built from it, so two nodes
    // sharing one produce two findings that point at the same place and cannot be told apart.
    const json = withDocument(
      node({
        children: [
          { id: "2:2", name: "A", type: "FRAME" },
          { id: "2:2", name: "B", type: "FRAME" },
        ],
      }),
    );
    expect(() => parseFigma(json)).toThrow(/node id "2:2" more than once/);
  });

  it("refuses a child that repeats its own ancestor's id", () => {
    const json = withDocument(node({ children: [{ id: "1:1", name: "Echo", type: "FRAME" }] }));
    expect(() => parseFigma(json)).toThrow(/more than once/);
  });
});

describe("what stays accepted", () => {
  it("ignores fields this adapter does not consume", () => {
    // A Figma file carries hundreds of them, and a payload from a later API version has more.
    const json = withDocument(
      node({
        absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
        fills: [{ type: "SOLID" }],
        strokes: [],
        componentId: "9:9",
        children: [{ id: "2:2", name: "Label", type: "TEXT", characters: "Hi", style: {} }],
      }),
    );
    expect(() => parseFigma(json)).not.toThrow();
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JourneyFileError, parseJourneyFile } from "../src/journey-file.js";

let dir: string;
let journeyPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fairux-journey-"));
  journeyPath = join(dir, "flow.json");
  writeFileSync(join(dir, "pricing.html"), "<main>Pricing</main>", "utf8");
  writeFileSync(join(dir, "checkout.html"), "<main>Checkout</main>", "utf8");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function parse(journey: unknown) {
  return parseJourneyFile(JSON.stringify(journey), journeyPath);
}

const TWO_STEPS = {
  steps: [
    { id: "pricing", order: 1, file: "pricing.html", url: "/pricing" },
    { id: "checkout", order: 2, file: "checkout.html" },
  ],
};

describe("reading a journey file", () => {
  it("resolves each step's file against the journey file, not the working directory", () => {
    // A flow is a set of documents that sit together. Resolving from the shell's cwd would make the
    // same journey file work or not depending on where it was run from.
    const parsed = parse(TWO_STEPS);
    expect(parsed.steps.map((step) => step.path)).toEqual([
      resolve(dir, "pricing.html"),
      resolve(dir, "checkout.html"),
    ]);
    expect(parsed.steps.map((step) => step.reportPath)).toEqual(["pricing.html", "checkout.html"]);
    expect(parsed.steps[0]?.url).toBe("/pricing");
  });

  it("keeps the order the file gave, and leaves ordering to the engine", () => {
    const parsed = parse({ steps: [...TWO_STEPS.steps].reverse() });
    expect(parsed.steps.map((step) => step.id)).toEqual(["checkout", "pricing"]);
    expect(parsed.steps.map((step) => step.order)).toEqual([2, 1]);
  });

  it("reads a transition, and refuses a kind that is not one", () => {
    const withTransition = parse({
      steps: [{ ...TWO_STEPS.steps[0], transition: { kind: "navigation", note: "clicked" } }],
    });
    expect(withTransition.steps[0]?.transition).toEqual({ kind: "navigation", note: "clicked" });
    expect(() =>
      parse({ steps: [{ ...TWO_STEPS.steps[0], transition: { kind: "teleport" } }] }),
    ).toThrow(JourneyFileError);
  });
});

describe("what a journey file may not say", () => {
  it("refuses a URL where a file belongs, and says why", () => {
    // The whole boundary in one refusal: this CLI does not fetch. A journey naming an address would
    // be a request to go and get it, and the message has to say that rather than "not found".
    expect(() =>
      parse({ steps: [{ id: "a", order: 1, file: "https://example.com/pricing" }] }),
    ).toThrow(/does not fetch anything or launch a browser/);
  });

  it("refuses a step naming a file that is not there, before anything is scanned", () => {
    expect(() => parse({ steps: [{ id: "a", order: 1, file: "missing.html" }] })).toThrow(
      /does not exist/,
    );
  });

  it("refuses an unknown field rather than ignoring it", () => {
    // A silently ignored `waitFor` or `selector` would read as a supported instruction that simply
    // did nothing, which is the worst of both answers.
    expect(() => parse({ steps: [{ ...TWO_STEPS.steps[0], selector: "#continue" }] })).toThrow(
      /unknown field "selector"/,
    );
    expect(() => parse({ steps: TWO_STEPS.steps, browser: "chromium" })).toThrow(
      /unknown field "browser"/,
    );
  });

  it("refuses an empty journey, an absent id, and a non-integer order", () => {
    expect(() => parse({ steps: [] })).toThrow(/at least one step/);
    expect(() => parse({ steps: [{ order: 1, file: "pricing.html" }] })).toThrow(/id is required/);
    expect(() => parse({ steps: [{ id: "a", order: 1.5, file: "pricing.html" }] })).toThrow(
      /order must be an integer/,
    );
  });

  it("refuses something that is not JSON, or not an object", () => {
    expect(() => parseJourneyFile("{", journeyPath)).toThrow(/not valid JSON/);
    expect(() => parseJourneyFile("[]", journeyPath)).toThrow(/must be a JSON object/);
  });

  it("leaves duplicate ids and orders to the engine, which already refuses them", () => {
    // Not re-checked here on purpose: two copies of that rule would be two places for it to drift,
    // and the engine's is the one a journey from any other source also passes through.
    const duplicates = parse({
      steps: [
        { id: "same", order: 1, file: "pricing.html" },
        { id: "same", order: 1, file: "checkout.html" },
      ],
    });
    expect(duplicates.steps).toHaveLength(2);
  });
});

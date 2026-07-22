import { describe, expect, it } from "vitest";
import type { PageContextSignal, Rule, RulePack, UiDocument, UiNode } from "../src/index.js";
import { createScanner, ScannerPolicyError } from "../src/index.js";
import { makeDoc } from "./_helpers.js";

const doc = makeDoc({
  tag: "main",
  text: "Checkout",
  children: [{ tag: "button", text: "Buy now" }],
});

function observedContextsRule(id = "example/observed-contexts"): Rule {
  return {
    meta: {
      id,
      title: "Observed contexts",
      category: "obstruction",
      defaultSeverity: "info",
      defaultConfidence: "low",
      defaultEnabled: true,
      tags: [],
      version: "1.0.0",
      maturity: "stable",
      requiredCapabilities: ["structure", "text"],
      evidenceRequirements: ["presence"],
    },
    evaluate(document, ctx) {
      return [
        ctx.createFinding({
          evidence: [{ locator: document.root.locator, text: document.root.subtreeText }],
          description: JSON.stringify(ctx.getPageContexts()),
          whyItMatters: "Rule authors observe canonical page-context signals.",
          recommendation: "Keep page-context signals deterministic.",
        }),
      ];
    },
  };
}

function contextPack(rules: readonly Rule[] = [observedContextsRule()]): RulePack {
  return {
    meta: {
      id: "example/page-context-pack",
      version: "0.0.0-test.0",
      engineApiVersion: "1",
      title: "Page context pack",
      status: "stable",
    },
    taxonomy: {
      pageContexts: [
        { id: "example/a:b", title: "Colon context" },
        { id: "example/a/b", title: "Slash context" },
        { id: "example/checkout", title: "Checkout context" },
      ],
    },
    rules,
  };
}

function scanContexts(pageContexts: readonly PageContextSignal[]): readonly PageContextSignal[] {
  const scanner = createScanner({ rulePacks: [contextPack()] });
  const report = scanner.scan({ ...doc, pageContexts });
  return JSON.parse(report.findings[0]?.description ?? "[]") as PageContextSignal[];
}

class ClassBackedDocument implements UiDocument {
  readonly #nodes: readonly UiNode[];
  readonly root = doc.root;
  readonly runtime = "html";
  readonly metadata = { file: "class-backed.html" };
  readonly pageContexts: readonly PageContextSignal[];

  constructor(pageContexts: readonly PageContextSignal[]) {
    this.pageContexts = pageContexts;
    this.#nodes = [doc.root, ...doc.root.children];
  }

  all(): UiNode[] {
    return [...this.#nodes];
  }

  findAll(predicate: (node: UiNode) => boolean): UiNode[] {
    return this.#nodes.filter(predicate);
  }

  getNode(id: string): UiNode | undefined {
    return this.#nodes.find((node) => node.id === id);
  }
}

describe("scanner page-context boundary", () => {
  it("returns canonical page contexts regardless of input order", () => {
    const first = scanContexts([
      { context: "example/a:b", confidence: "low" },
      { context: "example/a/b", confidence: "medium" },
      { context: "checkout", confidence: "high" },
    ]);
    const second = scanContexts([
      { context: "checkout", confidence: "high" },
      { context: "example/a/b", confidence: "medium" },
      { context: "example/a:b", confidence: "low" },
    ]);

    expect(first).toEqual(second);
    expect(first.map((signal) => signal.context)).toEqual([
      "checkout",
      "example/a/b",
      "example/a:b",
    ]);
  });

  it("deduplicates contexts, keeps highest confidence, and keeps first equal-confidence signal", () => {
    const evidence = [{ locator: doc.root.locator, text: "first" }];
    const contexts = scanContexts([
      { context: "example/checkout", confidence: "low" },
      { context: "example/checkout", confidence: "high" },
      { context: "example/a:b", confidence: "medium", evidence },
      { context: "example/a:b", confidence: "medium" },
    ]);

    expect(contexts).toEqual([
      { context: "example/a:b", confidence: "medium", evidence },
      { context: "example/checkout", confidence: "high" },
    ]);
  });

  it("rejects undeclared external page contexts and accepts built-in contexts", () => {
    const scanner = createScanner({ rulePacks: [contextPack()] });

    expect(() =>
      scanner.scan({
        ...doc,
        pageContexts: [{ context: "other/undeclared", confidence: "high" }],
      }),
    ).toThrow(ScannerPolicyError);
    expect(() =>
      scanner.scan({
        ...doc,
        pageContexts: [{ context: "checkout", confidence: "high" }],
      }),
    ).not.toThrow();
  });

  it("exposes immutable page-context arrays, signals, and evidence to rules", () => {
    const scanner = createScanner({ rulePacks: [contextPack()] });
    const report = scanner.scan({
      ...doc,
      pageContexts: [
        {
          context: "example/a:b",
          confidence: "medium",
          evidence: [{ locator: doc.root.locator, text: "frozen" }],
        },
      ],
    });
    const contexts = JSON.parse(report.findings[0]?.description ?? "[]") as PageContextSignal[];

    expect(contexts).toEqual([
      {
        context: "example/a:b",
        confidence: "medium",
        evidence: [{ locator: doc.root.locator, text: "frozen" }],
      },
    ]);
  });

  it("prevents one rule from mutating page contexts seen by later rules", () => {
    const mutatingRule: Rule = {
      ...observedContextsRule("example/mutating-rule"),
      evaluate(_document, ctx) {
        const contexts = ctx.getPageContexts() as PageContextSignal[];
        expect(Object.isFrozen(contexts)).toBe(true);
        expect(Object.isFrozen(contexts[0])).toBe(true);
        expect(Object.isFrozen(contexts[0]?.evidence)).toBe(true);
        expect(Object.isFrozen(contexts[0]?.evidence?.[0])).toBe(true);
        expect(() => contexts.push({ context: "marketing", confidence: "high" })).toThrow(
          TypeError,
        );
        expect(() => {
          (contexts[0] as { confidence: string }).confidence = "low";
        }).toThrow(TypeError);
        return [];
      },
    };
    const observerRule = observedContextsRule("example/observer-rule");
    const scanner = createScanner({ rulePacks: [contextPack([mutatingRule, observerRule])] });

    const report = scanner.scan({
      ...doc,
      pageContexts: [
        {
          context: "example/a:b",
          confidence: "medium",
          evidence: [{ locator: doc.root.locator, text: "still frozen" }],
        },
      ],
    });

    expect(JSON.parse(report.findings[0]?.description ?? "[]")).toEqual([
      {
        context: "example/a:b",
        confidence: "medium",
        evidence: [{ locator: doc.root.locator, text: "still frozen" }],
      },
    ]);
  });

  it("preserves class-backed UiDocument methods without enumerating unrelated properties", () => {
    const observingRule: Rule = {
      ...observedContextsRule("example/class-backed-observer"),
      evaluate(document, ctx) {
        expect(document.all().map((node) => node.tag)).toEqual(["main", "button"]);
        expect(document.findAll((node) => node.tag === "button")).toHaveLength(1);
        expect(document.getNode(document.root.id)).toBe(document.root);
        return observedContextsRule("example/class-backed-observer").evaluate(document, ctx);
      },
    };
    const scanner = createScanner({ rulePacks: [contextPack([observingRule])] });
    const sourceDocument = new ClassBackedDocument([
      { context: "example/checkout", confidence: "high" },
    ]);
    Object.defineProperty(sourceDocument, "unrelated", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("unrelated getter must not be read");
      },
    });

    const report = scanner.scan(sourceDocument);

    expect(JSON.parse(report.findings[0]?.description ?? "[]")).toEqual([
      { context: "example/checkout", confidence: "high" },
    ]);
    expect(sourceDocument.pageContexts).toEqual([
      { context: "example/checkout", confidence: "high" },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import type { AiObservation, AiPayload, AiProvider } from "../src/index.js";
import { buildAiPayload, runAiAugmentation } from "../src/index.js";
import { makeDoc } from "./_helpers.js";

const doc = makeDoc(
  {
    tag: "main",
    attributes: {
      "data-user-id": "u-4821",
      href: "https://analytics.example.com/t?uid=4821",
      class: "checkout",
    },
    children: [{ tag: "button", text: "Start free trial" }],
  },
  {
    file: "/home/someone/private/checkout.html",
    pageContexts: [{ context: "checkout", confidence: "high" }],
  },
);

const observation = (over: Partial<AiObservation> = {}): AiObservation =>
  ({
    id: "o1",
    summary: "The trial CTA does not mention renewal.",
    detail: "The button says Start free trial and no nearby text mentions billing.",
    provenance: {
      provider: "example",
      model: "example-1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      inputChecksum: "a".repeat(64),
    },
    ...over,
  }) as AiObservation;

const provider = (observe: AiProvider["observe"]): AiProvider => ({ name: "example", observe });

const payload = buildAiPayload(doc);

describe("what a provider is allowed to receive", () => {
  it("sends text, tag names, and page contexts, and nothing else", () => {
    expect(Object.keys(payload).sort()).toEqual(["pageContexts", "tags", "text"]);
    expect(payload.text).toContain("start free trial");
    expect(payload.tags).toEqual(["main", "button"]);
    expect(payload.pageContexts).toEqual(["checkout"]);
  });

  it("sends no attribute, however useful it might have been", () => {
    // Attributes carry ids, tracking parameters, and whatever else a page put in them. The payload
    // is assembled from an allowlist, so a field added to the model later does not appear here
    // until someone adds it here.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("u-4821");
    expect(serialized).not.toContain("analytics.example.com");
    expect(serialized).not.toContain("data-user-id");
  });

  it("sends no file path", () => {
    expect(JSON.stringify(payload)).not.toContain("/home/someone/private");
  });

  it("does not grow when the model does", () => {
    // The proof that it is an allowlist: a node gains a field, and the payload is unchanged.
    const withExtra = makeDoc({
      tag: "main",
      children: [{ tag: "button", text: "Start free trial" }],
    });
    for (const node of withExtra.all()) {
      (node as unknown as Record<string, unknown>).secretlyAdded = "must not travel";
    }
    expect(JSON.stringify(buildAiPayload(withExtra))).not.toContain("must not travel");
  });
});

describe("a provider that misbehaves", () => {
  const run = (p: AiProvider, timeoutMs = 50) =>
    runAiAugmentation(payload, { provider: p, timeoutMs });

  it("cannot break a scan by throwing", async () => {
    const result = await run(provider(() => Promise.reject(new Error("boom"))));
    expect(result.observations).toEqual([]);
    expect(result.failures[0]?.code).toBe("provider-error");
    expect(result.advisory).toBe(true);
  });

  it("cannot hold a scan open", async () => {
    const started = Date.now();
    const result = await run(
      provider(() => new Promise<never>(() => {})),
      20,
    );
    expect(result.failures[0]?.code).toBe("timeout");
    // Bounded by the budget, not by the provider's patience.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("is refused when it answers with something that is not a list", async () => {
    const result = await run(provider(() => Promise.resolve("nope" as never)));
    expect(result.failures[0]?.code).toBe("invalid-output");
  });

  it("is refused when an observation cannot be attributed", async () => {
    const noProvenance = { ...observation(), provenance: undefined } as unknown as AiObservation;
    const result = await run(provider(() => Promise.resolve([noProvenance])));
    expect(result.failures[0]?.message).toContain("provenance");
  });

  it("is refused when an observation dresses itself as a finding", async () => {
    // The one shape that would let an observation be mistaken for a deterministic result. A consumer
    // that saw a fingerprint on one would have every reason to treat it as one.
    for (const field of ["fingerprint", "ruleId", "severity"]) {
      const disguised = { ...observation(), [field]: "x" } as unknown as AiObservation;
      const result = await run(provider(() => Promise.resolve([disguised])));
      expect(result.failures[0]?.message).toContain(field);
      expect(result.observations).toEqual([]);
    }
  });
});

describe("a provider that behaves", () => {
  it("returns its observations, still marked advisory", async () => {
    const result = await runAiAugmentation(payload, {
      provider: provider(() => Promise.resolve([observation()])),
      timeoutMs: 50,
    });
    expect(result.observations).toHaveLength(1);
    expect(result.failures).toEqual([]);
    expect(result.advisory).toBe(true);
  });

  it("receives the payload and nothing else", async () => {
    let received: AiPayload | undefined;
    await runAiAugmentation(payload, {
      provider: provider((given) => {
        received = given;
        return Promise.resolve([]);
      }),
      timeoutMs: 50,
    });
    expect(received).toEqual(payload);
  });
});

describe("what an observation can never become", () => {
  it("carries no field a build could fail on", () => {
    const entry = observation();
    expect(entry).not.toHaveProperty("fingerprint");
    expect(entry).not.toHaveProperty("severity");
    expect(entry).not.toHaveProperty("ruleId");
    // `statedConfidence` is a string, deliberately not the `Confidence` union: it is the provider's
    // claim about itself and must not be comparable with a rule's.
    expect(typeof observation({ statedConfidence: "high" }).statedConfidence).toBe("string");
  });
});

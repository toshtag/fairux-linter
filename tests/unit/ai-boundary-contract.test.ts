import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shouldFailOn } from "../../apps/cli/src/scan-file.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function sourcesIn(relative: string): { readonly file: string; readonly text: string }[] {
  const dir = join(ROOT, relative);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
    .map((name) => ({ file: `${relative}/${name}`, text: readFileSync(join(dir, name), "utf8") }));
}

const report = {
  kind: "single" as const,
  schemaVersion: "0.1" as const,
  toolVersion: "test",
  generatedAt: "2026-01-01T00:00:00.000Z",
  input: { runtime: "html" as const },
  summary: { total: 0, bySeverity: { info: 0, low: 0, medium: 0, high: 0 } },
  findings: [],
  aiAugmentation: {
    observations: [
      {
        id: "o1",
        summary: "This looks like a dark pattern to me.",
        detail: "d",
        provenance: {
          provider: "example",
          model: "example-1",
          generatedAt: "2026-01-01T00:00:00.000Z",
          inputChecksum: "a".repeat(64),
        },
      },
    ],
    failures: [],
    advisory: true as const,
  },
};

/**
 * An AI signal must not be able to fail a build.
 *
 * The engine is deterministic and its findings are what baselines, fingerprints, SARIF, and
 * `--fail-on` are built on. An observation nobody can reproduce failing someone's pipeline is the
 * outcome that would make the whole feature untrustworthy, so the exit-code path cannot see one.
 */
describe("AI output and the exit code", () => {
  it("does not fail a report whose only signal is an AI observation", () => {
    for (const threshold of ["info", "low", "medium", "high"] as const) {
      expect(shouldFailOn(report, threshold)).toBe(false);
    }
  });

  it("keeps AI output out of the CLI's decision path", () => {
    // The static half: the exit code is decided in two functions, and neither may reach an
    // augmentation even by accident.
    //
    // This used to ban the name from the whole of `scan-file.ts`, which was a cheap proxy that
    // held only while the file had no honest use for it. It does now — `buildBatchReport` copies a
    // sub-report's `aiAugmentation` into the batch envelope, because a batch that dropped what a
    // single report carries is the defect that change fixes. So the guard names the thing it
    // protects instead: the deciding functions, and nowhere else in the file.
    const scanFile = sourcesIn("apps/cli/src").find((s) => s.file.endsWith("scan-file.ts"));
    const text = scanFile?.text ?? "";
    expect(text, "scan-file.ts is not where it was").not.toBe("");

    const AI = /aiAugmentation|AiObservation|AiAugmentation/;
    for (const name of ["shouldFailOn", "shouldFailOnJourney"]) {
      const start = text.indexOf(`export function ${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      const body = text.slice(start, text.indexOf("\n}", start));
      expect(body, `${name} can reach an AI augmentation`).not.toMatch(AI);
    }

    // And the name appears only where the envelope is assembled. A read anywhere else in this file
    // is a new path to the exit code that nobody argued for.
    const envelopeStart = text.indexOf("function buildBatchReport(");
    const envelopeEnd = text.indexOf("\n}", envelopeStart);
    for (const match of text.matchAll(new RegExp(AI.source, "g"))) {
      const at = match.index ?? -1;
      expect(
        at > envelopeStart && at < envelopeEnd,
        `${match[0]} at offset ${at} is outside buildBatchReport`,
      ).toBe(true);
    }
  });

  it("has no CLI flag that would make an AI signal blocking", () => {
    const index = sourcesIn("apps/cli/src").find((s) => s.file.endsWith("index.ts"));
    expect(index?.text).not.toMatch(/--fail-on-ai|--ai-blocking|--fail-on-observation/);
  });
});

/**
 * The engine stays AI-free.
 *
 * `CONTRIBUTING.md` says detection is deterministic with no AI in the engine. The contract file is
 * the one place that names a provider at all, and it calls nothing: a provider arrives as an
 * argument. This is what stops that from quietly changing.
 */
describe("the engine and the network", () => {
  it("makes no network call from anywhere in core or rules", () => {
    for (const relative of ["packages/core/src", "packages/rules/src"]) {
      for (const source of sourcesIn(relative)) {
        expect(source.text, `${source.file} must not fetch`).not.toMatch(
          /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/,
        );
      }
    }
  });

  it("keeps the provider an argument rather than a dependency", () => {
    const contract = sourcesIn("packages/core/src").find((s) =>
      s.file.endsWith("ai-augmentation.ts"),
    );
    expect(contract).toBeDefined();
    // No import of anything: the file's only imports are types from this package.
    const imports = [...(contract?.text.matchAll(/^import .* from "([^"]+)";$/gm) ?? [])].map(
      (match) => match[1],
    );
    expect(imports).toEqual(["./types.js"]);
  });

  it("names no provider's vocabulary in the types", () => {
    const contract = sourcesIn("packages/core/src").find((s) =>
      s.file.endsWith("ai-augmentation.ts"),
    );
    // Provider-neutral means swapping one for another is configuration, not code. A vendor name in
    // the contract is the first step to the opposite.
    expect(contract?.text.toLowerCase()).not.toMatch(
      /openai|anthropic|claude|gemini|gpt-|mistral|llama/,
    );
  });
});

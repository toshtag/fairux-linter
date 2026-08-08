import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = join(ROOT, "tests/fixtures/holdout-harness");
const RUNNER = join(ROOT, "scripts/evaluate-holdout.mjs");

/**
 * The evaluator against a package, rather than against its own contract.
 *
 * `holdout-contract.test.ts` drives the arithmetic and the refusals with data. What it cannot show
 * is the property the whole design rests on: **the holdout is read-only evidence.** An evaluator
 * that normalised a sample, rewrote a seal, or appended anything to `corpus/` would pass every
 * assertion in that file and destroy the only thing a holdout has, which is that nobody here tuned
 * against it.
 *
 * So this runs the real script and looks at the filesystem afterwards.
 */

/** Every file under a directory, as path → digest. */
function digestTree(root: string): Map<string, string> {
  const digests = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else
        digests.set(
          relative(root, full),
          createHash("sha256").update(readFileSync(full)).digest("hex"),
        );
    }
  };
  walk(root);
  return digests;
}

const run = (args: string[]) =>
  spawnSync("node", [RUNNER, ...args], { cwd: ROOT, encoding: "utf8" });

describe("the evaluator refuses before it scores", () => {
  it("refuses the harness fixture for coverage, naming every rule it is short on", () => {
    // The fixture covers all six strata and two rules. That is deliberately far below the per-rule
    // minimum, and the refusal is what this asserts: a package that cannot bear a claim must not
    // produce one, because a caveat is the part that does not travel with a quoted number.
    const result = run(["--package", FIXTURE]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refused at the coverage stage");
    expect(result.stdout).toBe("");
    for (const ruleId of ["scarcity/scarcity-phrase", "obstruction/confirmshaming"]) {
      expect(result.stderr, ruleId).toContain(`${ruleId}: 0 positive sample(s)`);
    }
    expect(result.stderr).toContain("0 declared near miss(es)");
  });

  it("refuses a package whose page moved after it was sealed", () => {
    withCopy((dir) => {
      const page = join(dir, "pages/consent-banner-en.html");
      writeFileSync(page, `${readFileSync(page, "utf8")}<!-- one more comment -->`, "utf8");
      const result = run(["--package", dir]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("refused at the seal stage");
      expect(result.stderr).toContain("does not match its seal");
    });
  });

  it("refuses a package whose label moved after it was sealed", () => {
    // The edit that leaves no trace in the pages, and the one the third condition is about: a
    // holdout relabelled after a disappointing result.
    withCopy((dir) => {
      const path = join(dir, "holdout.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.samples[0].expected = [];
      writeFileSync(path, JSON.stringify(manifest, null, 2), "utf8");
      const result = run(["--package", dir]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("does not match its seal");
    });
  });

  it("refuses a sample path that reaches outside the package, before opening it", () => {
    withCopy((dir) => {
      const path = join(dir, "holdout.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.samples[0].file = "../../../etc/passwd";
      writeFileSync(path, JSON.stringify(manifest, null, 2), "utf8");
      const result = run(["--package", dir]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("refused at the manifest stage");
      expect(result.stderr).toContain("relative path inside the package");
    });
  });
});

describe("the holdout is read-only evidence", () => {
  it("writes nothing into the package, and nothing into the corpus", () => {
    const packageBefore = digestTree(FIXTURE);
    const corpusBefore = digestTree(join(ROOT, "corpus"));

    // Both the paths that touch a package: the refusal, and the digest a preparer asks for.
    run(["--package", FIXTURE]);
    run(["--package", FIXTURE, "--seal"]);

    expect(digestTree(FIXTURE)).toEqual(packageBefore);
    expect(digestTree(join(ROOT, "corpus"))).toEqual(corpusBefore);
  });

  it("prints the seal rather than writing it, so nothing can quietly re-seal a package", () => {
    const result = run(["--package", FIXTURE, "--seal"]);
    expect(result.status ?? 0).toBe(0);
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
    // The digest it prints is the one the package already carries, which is what says `--seal` and
    // the check below are computing the same thing.
    const manifest = JSON.parse(readFileSync(join(FIXTURE, "holdout.json"), "utf8"));
    expect(result.stdout.trim()).toBe(manifest.seal.digest);
    expect(result.stderr).toContain("Nothing here wrote to your package");
  });

  it("refuses to write a run into the package it evaluated", () => {
    withCopy((dir) => {
      const result = run(["--package", dir, "--json", join(dir, "run.json")]);
      // Refused for coverage first, which is the point: the containment check never has to be the
      // last line of defence, and the fixture cannot reach it. Driven directly below.
      expect(result.status).toBe(1);
      expect(digestTree(dir).has("run.json")).toBe(false);
    });
  });
});

describe("what a scored package reports", () => {
  /**
   * The scoring, driven past the coverage gate.
   *
   * The gate is fail-closed against the real rule set, so no fixture small enough to live here can
   * pass it — nine positives and nine declared near misses for each of eleven rules, across three
   * adapters, is what an external holdout has to be. Calling `evaluate` directly is not a way around
   * the gate; it is the only way to exercise the arithmetic on real pages, and the gate itself is
   * asserted above.
   */
  interface Interval {
    point: number;
    lower: number;
    upper: number;
    trials: number;
  }
  interface Result {
    evidenceClass: string;
    p7Eligible: boolean;
    minimumSamplesPerRule: number;
    totals: { samples: number; precision: Interval | null; recall: Interval | null };
    byRule: { ruleId: string; precision: Interval | null }[];
    byStratum: { locale: string; runtime: string; samples: number }[];
  }
  let result: Result;
  let markdown: string;

  beforeEach(async () => {
    // @ts-expect-error — the runner is plain JS, like every other script here.
    const runner = await import("../../scripts/evaluate-holdout.mjs");
    const manifest = JSON.parse(readFileSync(join(FIXTURE, "holdout.json"), "utf8"));
    result = runner.evaluate(FIXTURE, manifest, runner.readSamples(FIXTURE, manifest)) as Result;
    markdown = runner.renderMarkdown(result) as string;
  });

  it("says the fixture is not evidence, as a value and as a sentence", () => {
    // Both, deliberately. The value is what a maintainer's tooling can branch on; the sentence is
    // what somebody reading a pasted report sees. A synthetic package must never be quotable.
    expect(result.evidenceClass).toBe("harness-fixture");
    expect(result.p7Eligible).toBe(false);
    expect(markdown).toContain("not evidence about detection quality");
    expect(markdown).toContain("cannot bear on P7");
  });

  it("reports every stratum the package covers, rather than pooling them", () => {
    expect(result.byStratum.map((row) => `${row.locale}/${row.runtime}`).sort()).toEqual([
      "en/ast",
      "en/figma",
      "en/html",
      "ja/ast",
      "ja/figma",
      "ja/html",
    ]);
  });

  it("never prints a rate without its denominator", () => {
    // "100% accuracy" with no count is the number this whole criterion exists to prevent.
    const rates = [
      result.totals.precision,
      result.totals.recall,
      ...result.byRule.map((row) => row.precision),
    ];
    for (const rate of rates) {
      if (rate === null) continue;
      expect(rate.trials).toBeGreaterThan(0);
      expect(rate.lower).toBeLessThanOrEqual(rate.point);
      expect(rate.upper).toBeGreaterThanOrEqual(rate.point);
    }
    // And a rule nothing exercised reports a dash rather than a rate of zero.
    expect(markdown).toContain("— (nothing to measure)");
  });

  it("keeps a label the engine disagreed with, rather than the label matching the output", () => {
    // `pages/SignupForm.tsx` uses React's `defaultChecked` and the rule stays silent — issue #335.
    // The label says what the page should produce, which is the rule that makes a holdout worth
    // having. This asserts the disagreement is *reported*, not which way it went: when #335 is
    // fixed the miss becomes a true positive and this still holds.
    const scored = result as unknown as {
      samples: { id: string; truePositives: unknown[]; falseNegatives: unknown[] }[];
    };
    const signup = scored.samples.find((entry) => entry.id === "signup-form-en");
    expect(signup).toBeDefined();
    expect(
      (signup?.truePositives.length ?? 0) + (signup?.falseNegatives.length ?? 0),
      "the sample is labelled, so it must be scored one way or the other",
    ).toBeGreaterThan(0);
  });

  it("records the minimum it would have enforced, so a reader can see what the number rests on", () => {
    expect(result.minimumSamplesPerRule).toBeGreaterThan(1);
    expect(markdown).toContain(`Minimum per rule, each way: ${result.minimumSamplesPerRule}`);
  });
});

let temporary: string | undefined;

/** A throwaway copy of the fixture, so a case can break a package without breaking the fixture. */
function withCopy(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "fairux-holdout-"));
  temporary = dir;
  const copy = (from: string, to: string) => {
    for (const entry of readdirSync(from)) {
      const source = join(from, entry);
      const target = join(to, entry);
      if (statSync(source).isDirectory()) {
        mkdirSync(target, { recursive: true });
        copy(source, target);
      } else writeFileSync(target, readFileSync(source));
    }
  };
  copy(FIXTURE, dir);
  body(dir);
}

afterEach(() => {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  temporary = undefined;
});

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DOC = readFileSync(join(ROOT, "docs/reference/platforms.md"), "utf8");

/** The floors, as the document states them. Everything below is compared against these. */
const ENGINES_RANGE = "^22.18.0 || >=24.11.0";
const FLOORS = ["22.18.0", "24.11.0"];

function manifestsWithEngines(): { readonly path: string; readonly node: string }[] {
  const roots = ["packages", "apps"];
  const found: { path: string; node: string }[] = [];
  for (const root of roots) {
    for (const name of readdirSync(join(ROOT, root))) {
      const path = join(root, name, "package.json");
      let manifest: { engines?: { node?: string }; private?: boolean };
      try {
        manifest = JSON.parse(readFileSync(join(ROOT, path), "utf8"));
      } catch {
        continue;
      }
      if (manifest.engines?.node) found.push({ path, node: manifest.engines.node });
    }
  }
  return found;
}

/**
 * A documented floor nobody tests, or a tested floor nobody documents.
 *
 * The Node versions live in three places — `engines`, the CI matrices, and this document — and
 * nothing noticed when they disagreed. That is the version of this failure a consumer finds first,
 * because their install is the thing that breaks.
 */
describe("the Node floors agree everywhere they appear", () => {
  it("is the same range in every published manifest", () => {
    const manifests = manifestsWithEngines();
    expect(manifests.length).toBeGreaterThan(0);
    for (const manifest of manifests) {
      expect(manifest.node, `${manifest.path} declares a different range`).toBe(ENGINES_RANGE);
    }
  });

  it("is the same pair in every CI matrix", () => {
    const workflows = readdirSync(join(ROOT, ".github/workflows")).filter((name) =>
      name.endsWith(".yml"),
    );
    let matrices = 0;
    for (const name of workflows) {
      const text = readFileSync(join(ROOT, ".github/workflows", name), "utf8");
      for (const match of text.matchAll(/node-version:\s*\[([^\]]+)\]/g)) {
        matrices += 1;
        const versions = (match[1] ?? "").split(",").map((entry) => entry.trim());
        expect(versions, `${name} tests a different pair`).toEqual(FLOORS);
      }
    }
    // A test that found no matrix would pass silently while proving nothing.
    expect(matrices).toBeGreaterThanOrEqual(5);
  });

  it("is the same pair in the document", () => {
    for (const floor of FLOORS) expect(DOC).toContain(floor);
    expect(DOC).toContain(ENGINES_RANGE);
  });
});

/**
 * The document's first claim about each floor is "the whole suite". Nothing checked it.
 *
 * Every assertion above compares version *strings* — that `engines`, `.node-version`, the CI
 * matrices, and this page all say `22.18.0` and `24.11.0`. None of them asks what runs on those
 * versions. So `24.11.0` appeared in five matrices, every one of which packed a tarball or
 * rehearsed a release, while the suite ran in exactly one place pinned to `22.18.0` — and the page
 * said "the whole suite" of both.
 *
 * This reads the workflows for a job that runs the suite whole, resolves the Node version its
 * `setup-node` step asks for through the job's own matrix, and requires both floors to appear.
 */
function floorsRunningTheWholeSuite(): string[] {
  const dir = join(ROOT, ".github/workflows");
  const found = new Set<string>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".yml"))) {
    const workflow = parse(readFileSync(join(dir, file), "utf8")) as {
      jobs?: Record<
        string,
        {
          strategy?: { matrix?: Record<string, unknown> };
          steps?: Array<{ run?: string; uses?: string; with?: Record<string, unknown> }>;
        }
      >;
    };
    for (const job of Object.values(workflow.jobs ?? {})) {
      // `--shard` is a quarter of the suite. Whether four of them add up to the whole is a
      // question about a matrix, and a claim this page makes should not rest on that arithmetic.
      const runsWholeSuite = (job.steps ?? []).some(
        (step) => step.run?.includes("pnpm test:built") && !step.run.includes("--shard"),
      );
      if (!runsWholeSuite) continue;

      const asked = (job.steps ?? []).find((step) => step.uses?.startsWith("actions/setup-node@"))
        ?.with?.["node-version"];
      if (typeof asked !== "string") continue;

      const viaMatrix = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(asked);
      if (!viaMatrix) {
        found.add(asked);
        continue;
      }
      const values = job.strategy?.matrix?.[viaMatrix[1] as string];
      if (Array.isArray(values)) for (const value of values) found.add(String(value));
    }
  }
  return [...found].sort();
}

describe("the whole suite runs on every floor the document claims", () => {
  it("finds a job that runs the suite whole, on each floor", () => {
    expect(floorsRunningTheWholeSuite()).toEqual([...FLOORS].sort());
  });
});

describe("what the platforms document must keep saying", () => {
  it("says macOS is untested rather than implying it works", () => {
    expect(DOC).toContain("macOS is not in CI");
    expect(DOC).toContain('"not tested" is the accurate word for it');
  });

  it("says why Windows is tested", () => {
    // Because it broke. A platform in CI for a reason is one somebody will keep there.
    expect(DOC).toContain("Windows is tested because it broke");
  });

  it("records both registry canaries and that neither is required", () => {
    expect(DOC).toContain("registry-consumer-smoke.yml");
    expect(DOC).toContain("registry-cli-smoke.yml");
    expect(DOC).toContain("neither is a required check");
  });

  it("says the CLI canary fails today, and why", () => {
    expect(DOC).toContain("`fairux` does not exist on the registry yet");
  });
});

describe("the canaries the document describes", () => {
  it("are scheduled, and read-only", () => {
    for (const name of ["registry-consumer-smoke.yml", "registry-cli-smoke.yml"]) {
      const text = readFileSync(join(ROOT, ".github/workflows", name), "utf8");
      expect(text, `${name} should run on a schedule`).toMatch(
        /schedule:\s*\n\s*(#[^\n]*\n\s*)*-\s*cron:/,
      );
      expect(text, `${name} should not request write permission`).not.toMatch(
        /contents:\s*write|id-token:\s*write/,
      );
    }
  });
});

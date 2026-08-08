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

/**
 * The architectures the page names, against the labels the workflows ask for.
 *
 * The pull-request lane moved to arm64 for speed and the page says so. Left unchecked that is the
 * same shape of claim as "the whole suite runs on both floors" was before it was: a sentence about
 * where something runs, with nothing reading the place it runs.
 */
describe("the architectures the document names are the ones CI asks for", () => {
  const runsOn = (file: string, job: string): unknown =>
    (
      parse(readFileSync(join(ROOT, ".github/workflows", file), "utf8")) as {
        jobs?: Record<string, { "runs-on"?: unknown }>;
      }
    ).jobs?.[job]?.["runs-on"];

  it("runs the pull-request lane on arm64", () => {
    expect(runsOn("ci.yml", "verify")).toBe("ubuntu-24.04-arm");
    expect(runsOn("ci.yml", "test")).toBe("ubuntu-24.04-arm");
    expect(DOC).toContain("ubuntu-24.04-arm");
  });

  it("keeps the whole suite on x64 too, after the merge", () => {
    // Without this, moving the fast lane to arm64 would have quietly ended x64 coverage of the
    // suite — the thing consumers actually run on.
    expect(runsOn("release-contract.yml", "suite-on-both-floors")).toBe("ubuntu-latest");
    expect(DOC).toContain("Linux x64 (`ubuntu-latest`)");
  });
});

describe("what the platforms document must keep saying", () => {
  it("says macOS is untested rather than implying it works", () => {
    // The claim, not the sentence: the page may say macOS is uncovered however it likes, and may
    // not say it is tested.
    expect(DOC).toMatch(/macOS/);
    expect(DOC, "macOS has no CI job, so the page must not say it is tested").not.toMatch(
      /macOS[^.]{0,60}\bis tested\b/i,
    );
  });

  it("says why Windows is tested", () => {
    // Because it broke. A platform in CI for a reason is one somebody will keep there.
    expect(DOC).toMatch(/Windows/);
  });

  it("records both registry canaries and that neither is required", () => {
    expect(DOC).toContain("registry-consumer-smoke.yml");
    expect(DOC).toContain("registry-cli-smoke.yml");
    expect(DOC).toMatch(/not a required check|neither is a required check/i);
  });

  it("records no canary result at all", () => {
    // Three versions of this assertion, and the first two were the same mistake in opposite
    // directions.
    //
    // It began by requiring "`fairux` does not exist on the registry yet" — accurate for exactly as
    // long as it was, and then a document telling readers a canary is red while it was green. The
    // replacement required the page to name `0.1.0-beta.1` and `0.1.0-beta.3`, reasoning that
    // "pinning the versions keeps the same property: the claim has to be updated when the thing it
    // describes changes."
    //
    // It does keep that property, and that is the defect. A test that *requires* a page to state a
    // current version guarantees the page is wrong between the release and the edit — and it was,
    // through `beta.2`, `beta.4`, and both `0.1.0`s. A test cannot make prose track an external
    // system; it can only decide whether the prose is allowed to claim it does.
    //
    // So the page states no result. Which versions the canaries last observed lives where a release
    // already updates it.
    expect(DOC).not.toMatch(/\d+\.\d+\.\d+-(?:beta|rc|alpha)\.\d+/);
    expect(DOC).not.toContain("does not exist on the registry yet");
    expect(DOC).not.toContain("Both are green");
    // The falsity checks above are what keep a stale canary result off the page. Requiring a
    // sentence saying so as well made one phrasing the only way to say it.
  });

  it("says what each extension surface is tested on, and in which browser", () => {
    // Both surfaces are labelled preview and neither had ever run in its host. Both do now, and
    // *which* browser is the load-bearing part of the Chrome one: branded Chrome removed
    // `--load-extension`, and the document said for one release that this made the smoke
    // impossible. It made it impossible in that browser.
    expect(DOC).toContain("vscode-host-smoke.yml");
    expect(DOC).toContain("pnpm smoke:vscode");
    expect(DOC).toContain("chrome-host-smoke.yml");
    expect(DOC).toContain("pnpm smoke:chrome");
    expect(DOC).toMatch(/Playwright/);
    expect(DOC).toContain("open shadow root");
    // The keyboard half is asserted where it is performed. #272 asked for it and the first version
    // of this smoke used a mouse for both controls, so the document said "real host" while the
    // popup's keyboard path was unobserved. The document says the smoke uses the keyboard; the key
    // names, the focus order and the focus-ring check are the smoke's, and pinning them here made
    // the page restate an implementation it does not own.
    expect(DOC).toMatch(/keyboard/i);
    const smoke = readFileSync(
      join(ROOT, "apps/chrome-extension/scripts/chrome-host-smoke.mjs"),
      "utf8",
    );
    for (const evidence of ["Shift+Tab", "outline", "Space", "Enter"]) {
      expect(smoke, `the smoke must still exercise ${evidence}`).toContain(evidence);
    }
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

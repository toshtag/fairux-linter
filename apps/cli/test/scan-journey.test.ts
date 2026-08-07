import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_SPAWN_TIMEOUT_MS } from "./cli-process-budget.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");
const flowPack = resolve(here, "../../../tests/fixtures/journey-rule-pack/flow-pack.mjs");

const PRICING = "<main><h1>Pricing</h1><p>Just $19.00 a month.</p></main>";
const CHECKOUT =
  '<main><h1>Checkout</h1><p>Total: $29.00</p><label><input type="checkbox" checked> Email me offers</label></main>';

const FLOW = {
  steps: [
    { id: "pricing", order: 1, file: "pricing.html", url: "/pricing", actionLabel: "Continue" },
    {
      id: "checkout",
      order: 2,
      file: "checkout.html",
      url: "/checkout",
      transition: { kind: "navigation" },
    },
  ],
};

function withFlow<T>(run: (dir: string) => T, journey: unknown = FLOW): T {
  const dir = mkdtempSync(join(tmpdir(), "fairux-scan-journey-"));
  try {
    writeFileSync(join(dir, "pricing.html"), PRICING, "utf8");
    writeFileSync(join(dir, "checkout.html"), CHECKOUT, "utf8");
    writeFileSync(join(dir, "flow.json"), JSON.stringify(journey), "utf8");
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function cli(args: string[], dir: string, withPack = true) {
  return spawnSync(
    "node",
    [
      cliBin,
      "scan-journey",
      join(dir, "flow.json"),
      ...args,
      ...(withPack ? ["--rule-pack", flowPack] : []),
    ],
    { encoding: "utf8", cwd: dir, timeout: CLI_SPAWN_TIMEOUT_MS },
  );
}

describe("fairux scan-journey", () => {
  it("reports the flow's own findings and each step's, as two layers", () => {
    withFlow((dir) => {
      const report = JSON.parse(cli(["--format", "json"], dir).stdout);
      expect(report.kind).toBe("journey");
      expect(report.summary.total).toBe(1);
      expect(report.findings[0].ruleId).toBe("fixtures/price-changed-across-steps");
      expect(report.stepSummary.total).toBeGreaterThan(0);
      // Disjoint by construction: the cross-step finding is in neither step's own report.
      const inSteps = report.steps.flatMap((step: { report: { findings: { ruleId: string }[] } }) =>
        step.report.findings.map((finding) => finding.ruleId),
      );
      expect(inSteps).not.toContain("fixtures/price-changed-across-steps");
    });
  });

  it("scans in `order`, whatever order the file listed", () => {
    withFlow(
      (dir) => {
        const report = JSON.parse(cli(["--format", "json"], dir).stdout);
        expect(report.steps.map((step: { id: string }) => step.id)).toEqual([
          "pricing",
          "checkout",
        ]);
      },
      { steps: [...FLOW.steps].reverse() },
    );
  });

  it("renders Markdown with the two layers named and never summed silently", () => {
    withFlow((dir) => {
      const out = cli([], dir).stdout;
      expect(out).toContain("**Across the flow:** 1");
      expect(out).toContain("**Within steps:**");
      expect(out).toContain("**Total:**");
      expect(out).toContain("## Step 1: `pricing` — /pricing");
    });
  });

  it("says nothing was checked across the flow when no journey rule is loaded", () => {
    withFlow((dir) => {
      const out = cli([], dir, false).stdout;
      expect(out).toContain("**Nothing was checked here.**");
    });
  });
});

describe("what scan-journey will not do", () => {
  it("is a command, not a flag on `scan`", () => {
    withFlow((dir) => {
      const help = spawnSync("node", [cliBin, "scan", "--help"], {
        encoding: "utf8",
        cwd: dir,
        timeout: CLI_SPAWN_TIMEOUT_MS,
      });
      expect(help.stdout).not.toMatch(/--journey/);
      const root = spawnSync("node", [cliBin, "--help"], {
        encoding: "utf8",
        cwd: dir,
        timeout: CLI_SPAWN_TIMEOUT_MS,
      });
      expect(root.stdout).toContain("scan-journey");
    });
  });

  it("refuses SARIF and HTML with the reason, not with a list of what is left", () => {
    withFlow((dir) => {
      const sarif = cli(["--format", "sarif"], dir);
      expect(sarif.status).toBe(2);
      expect(sarif.stderr).toContain("no physical location of its own");

      const html = cli(["--format", "html"], dir);
      expect(html.status).toBe(2);
      expect(html.stderr).toContain("coverage panel per step");
    });
  });

  it("refuses a journey file that names a URL, and does not fetch it", () => {
    withFlow(
      (dir) => {
        const result = cli([], dir);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("does not fetch anything or launch a browser");
        expect(result.stdout).toBe("");
      },
      { steps: [{ id: "a", order: 1, file: "https://example.com/pricing" }] },
    );
  });

  it("prints nothing at all when one step is missing, rather than a partial flow", () => {
    withFlow(
      (dir) => {
        const result = cli([], dir);
        expect(result.status).toBe(1);
        // Half a flow rendered as a whole one would say a path was checked when its first page was.
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("does not exist");
      },
      {
        steps: [
          { id: "pricing", order: 1, file: "pricing.html" },
          { id: "gone", order: 2, file: "gone.html" },
        ],
      },
    );
  });

  it("offers no risk index, because how a journey scores is not decided", () => {
    withFlow((dir) => {
      const help = spawnSync("node", [cliBin, "scan-journey", "--help"], {
        encoding: "utf8",
        cwd: dir,
        timeout: CLI_SPAWN_TIMEOUT_MS,
      });
      expect(help.stdout).not.toMatch(/--risk-index/);
    });
  });
});

describe("--fail-on across both layers", () => {
  it("fails on a finding that exists only across steps", () => {
    withFlow((dir) => {
      // Without the journey rule the steps alone carry nothing `high`, so this can only be the
      // cross-step finding — which is the half a threshold written against steps would have missed.
      expect(cli(["--fail-on", "high"], dir).status).toBe(1);
    });
  });

  it("fails on a finding that exists only within a step", () => {
    withFlow(
      (dir) => {
        const result = cli(["--fail-on", "medium"], dir, false);
        expect(result.status).toBe(1);
      },
      {
        steps: [
          { id: "checkout", order: 1, file: "checkout.html" },
          { id: "pricing", order: 2, file: "pricing.html" },
        ],
      },
    );
  });

  it("passes when nothing reaches the threshold, and reports either way", () => {
    const dir = mkdtempSync(join(tmpdir(), "fairux-scan-journey-clean-"));
    try {
      writeFileSync(
        join(dir, "a.html"),
        "<main><h1>About</h1><p>We make things.</p></main>",
        "utf8",
      );
      writeFileSync(join(dir, "b.html"), "<main><h1>Contact</h1><p>Say hello.</p></main>", "utf8");
      writeFileSync(
        join(dir, "flow.json"),
        JSON.stringify({
          steps: [
            { id: "about", order: 1, file: "a.html" },
            { id: "contact", order: 2, file: "b.html" },
          ],
        }),
        "utf8",
      );
      const result = cli(["--fail-on", "info"], dir, false);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("# FairUX Journey Report");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a severity that is not one", () => {
    withFlow((dir) => {
      const result = cli(["--fail-on", "critical"], dir);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("unknown --fail-on severity");
    });
  });
});

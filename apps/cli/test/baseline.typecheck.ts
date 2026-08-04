import type { FairUxBatchReport, FairUxReport } from "@fairux/core";
import { applyBaseline, createBaseline } from "../src/baseline.js";

/**
 * Compile-time assertions about `applyBaseline`'s report shapes. There is nothing here to run.
 *
 * The file is named `.typecheck.ts` rather than `.test.ts` on purpose: Vitest collects
 * `**\/*.{test,spec}.ts` and so never sees it, while `apps/cli/tsconfig.json` includes `test` and so
 * `pnpm typecheck` does. The calls below are rejections — they must not be on a path anything
 * executes, or a future runtime guard would make them throw and the failure would be read as a
 * regression in the guard rather than as the type contract holding.
 *
 * Remove the `NoInfer<T>` from `applyBaseline` and the two directives become unused, which is a
 * type error. That is how this file fails.
 */

const single = {
  schemaVersion: "0.1",
  toolVersion: "test",
  input: { runtime: "html", file: "a.html" },
  summary: { total: 0, bySeverity: { info: 0, low: 0, medium: 0, high: 0 } },
  findings: [],
} as unknown as FairUxReport;

const batch = {
  schemaVersion: "0.1",
  toolVersion: "test",
  inputs: [{ file: "a.html" }],
  reports: [single],
  summary: { total: 0, bySeverity: { info: 0, low: 0, medium: 0, high: 0 } },
} as unknown as FairUxBatchReport;

const baseline = createBaseline(single, { toolVersion: "test" });

export function baselineLivenessReportShapes(): void {
  applyBaseline(single, baseline);
  applyBaseline(batch, baseline);
  applyBaseline(single, baseline, single);
  applyBaseline(batch, baseline, batch);

  // The liveness report is compared fingerprint to fingerprint against the report being subtracted
  // from, so one of the other shape answers a question that was never asked.
  // @ts-expect-error liveness report must be a single report, matching the first argument
  applyBaseline(single, baseline, batch);
  // @ts-expect-error liveness report must be a batch report, matching the first argument
  applyBaseline(batch, baseline, single);
}

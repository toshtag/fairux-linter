import type { FairUxBatchReport, FairUxReport, RiskIndexReport } from "@fairux/core";
import { computeRiskIndex } from "@fairux/core";
import { toRiskIndexView } from "@fairux/report";
import { fairuxRiskIndexModel, RISK_INDEX_MODELS } from "@fairux/rules";
import { writeArtifact } from "./artifact-write.js";

/**
 * `fairux scan --risk-index <file>`.
 *
 * The index is a **second artifact**, written where the caller asked for it. It never touches
 * stdout: a report that silently grew a number would put one in every pipeline that parses today's
 * output, and the whole point of the flag is that a score arrives only when someone asked.
 *
 * It is computed from the report that was actually emitted — after suppressions and after a
 * baseline — so the number describes what the scan reported rather than what it found before its
 * accepted risk was subtracted.
 *
 * The model lives here rather than in the engine because weights are policy. `@fairux/core` on its
 * own answers `unsupported`, which is why the CLI names the model explicitly.
 */
export function buildRiskIndex(
  report: FairUxReport | FairUxBatchReport,
  toolVersion: string,
  modelVersion?: string,
): RiskIndexReport {
  const model = modelVersion ? findRiskIndexModel(modelVersion) : fairuxRiskIndexModel;
  if (!model) throw new UnknownRiskIndexModelError(modelVersion ?? "");
  return computeRiskIndex(report, { model, toolVersion });
}

/** The versions `--risk-index-model` accepts, in the order a reader should meet them. */
export const RISK_INDEX_MODEL_VERSIONS: readonly string[] = RISK_INDEX_MODELS.map(
  (model) => model.version,
);

/**
 * The default is `fairux-risk/1`, and stays there.
 *
 * Two scores are comparable when their `modelVersion` matches and not otherwise, so moving the
 * default changes what every number written before it meant. That is a maintainer's decision, not a
 * consequence of a second model existing — the flag is how the second one is reached until then.
 */
export const DEFAULT_RISK_INDEX_MODEL_VERSION = fairuxRiskIndexModel.version;

export class UnknownRiskIndexModelError extends Error {
  constructor(public readonly requested: string) {
    super(
      `unknown risk index model "${requested}" (use ${RISK_INDEX_MODEL_VERSIONS.join(" or ")})`,
    );
    this.name = "UnknownRiskIndexModelError";
  }
}

function findRiskIndexModel(version: string) {
  return RISK_INDEX_MODELS.find((model) => model.version === version);
}

export function writeRiskIndex(filePath: string, index: RiskIndexReport): void {
  writeArtifact(filePath, `${JSON.stringify(index, null, 2)}\n`);
}

/**
 * The one line a reader sees on stderr.
 *
 * Through the shared view, like every other surface: a CLI that read `score` directly could print a
 * number for an unscored report, which is the failure the view exists to make impossible.
 *
 * It says what the number is not, in the same breath as the number. That sentence is the one thing
 * most likely to be dropped when a score is quoted, so it travels with it here rather than living
 * only in the file.
 */
export function describeRiskIndex(index: RiskIndexReport, filePath: string): string {
  const view = toRiskIndexView(index);
  const head =
    view.score === null
      ? `fairux: no risk index — ${view.reason ?? view.statusLabel}`
      : `fairux: risk index ${view.score} (confidence ${view.confidence}, model ${view.modelVersion})`;
  return (
    `${head}, written to "${filePath}"\n` +
    "fairux: a risk index is not a safety, legal, or compliance verdict, and it does not affect " +
    "this command's exit code\n"
  );
}

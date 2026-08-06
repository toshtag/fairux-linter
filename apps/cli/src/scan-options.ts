import { sanitizeForTerminal } from "./load-config.js";
import { RISK_INDEX_MODEL_VERSIONS } from "./risk-index.js";

/**
 * Whether a `scan` invocation is coherent, decided in one place and before anything happens.
 *
 * The checks used to be spread through the action body and stopped at the ones with an obvious
 * wrong answer — an unknown format, an unknown severity. The ones that mattered more were the flags
 * a run *accepts* and then ignores: `--risk-index-model` without `--risk-index` changed nothing and
 * said nothing, and `--write-baseline` returned before the suppression, baseline, risk index, fix,
 * and `--fail-on` branches, so a command line carrying all of them exited 0 having acted on one.
 *
 * Every entry below is read off the control flow it describes rather than assumed:
 *
 * - `emit()` returns immediately when `--write-baseline` is set, so everything downstream of that
 *   branch — the two subtractions, the index, the fix plan, the threshold, and the rendered report
 *   `--format` selects — is dead for that run.
 * - the index is built only `if (options.riskIndex)`, and `--risk-index-model` is an argument to
 *   that call, so without it the flag names a model nothing scores with.
 * - `resolveEffectiveConfig()` returns on `explicitPath` before it consults `ignoreConfig`, so
 *   `--ignore-config` beside `--config` asks for a discovery pass that was never going to run.
 * - the fix plan is written `if (options.fixWrite)` and described either way, so `--fix-dry-run`
 *   beside `--fix-write` is a request to change nothing on a command line that writes.
 *
 * No conflict is resolved by picking a winner. A user who wrote two contradictory things meant one
 * of them and this cannot know which, so the run is refused with both named. Exit 2, not 1: the
 * invocation is wrong, and 1 is what a finding uses.
 */

/** Formats `scan` renders. The command's help text and this validator read the same list. */
export const VALID_FORMATS = ["json", "markdown", "sarif", "html"] as const;
/** Severities `--fail-on` accepts, most severe first, as the help text lists them. */
export const VALID_FAIL_ON = ["high", "medium", "low", "info"] as const;

/** `a`, `a or b`, `a, b, or c` — the forms the refusals in this CLI already use. */
function orList(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  const last = values[values.length - 1] as string;
  const rest = values.slice(0, -1);
  return rest.length === 1 ? `${rest[0]} or ${last}` : `${rest.join(", ")}, or ${last}`;
}

/**
 * What a `scan` invocation asked for, in the shape this file needs to judge it.
 *
 * `formatExplicit` is separate from `format` because Commander supplies a default, and refusing a
 * default nobody typed would make `--write-baseline` unusable. It comes from the option's value
 * source, which is the only thing that can tell the two apart.
 */
export interface ScanOptionState {
  readonly format: string;
  readonly formatExplicit: boolean;
  readonly failOn?: string;
  readonly baseline?: string;
  readonly writeBaseline?: string;
  readonly suppress?: string;
  readonly riskIndex?: string;
  readonly riskIndexModel?: string;
  readonly fixDryRun?: boolean;
  readonly fixWrite?: boolean;
  readonly config?: string;
  readonly ignoreConfig?: boolean;
  /** The target is `-`. Kept here so the one refusal that depends on it lives with the others. */
  readonly isStdin: boolean;
}

/** Which flags a state actually carries, named the way the user typed them. */
function present(state: ScanOptionState): ReadonlySet<string> {
  const flags = new Set<string>();
  if (state.formatExplicit) flags.add("--format");
  if (state.failOn !== undefined) flags.add("--fail-on");
  if (state.baseline !== undefined) flags.add("--baseline");
  if (state.writeBaseline !== undefined) flags.add("--write-baseline");
  if (state.suppress !== undefined) flags.add("--suppress");
  if (state.riskIndex !== undefined) flags.add("--risk-index");
  if (state.riskIndexModel !== undefined) flags.add("--risk-index-model");
  if (state.fixDryRun) flags.add("--fix-dry-run");
  if (state.fixWrite) flags.add("--fix-write");
  if (state.config !== undefined) flags.add("--config");
  if (state.ignoreConfig) flags.add("--ignore-config");
  return flags;
}

/**
 * A flag that makes other flags do nothing, and the sentence explaining why.
 *
 * `ignored` is ordered, so a command line carrying several of them names them all in one message,
 * in a fixed order, rather than one refusal per rerun.
 */
interface IneffectiveRule {
  readonly when: string;
  readonly ignored: readonly string[];
  readonly because: string;
}

const INEFFECTIVE: readonly IneffectiveRule[] = [
  {
    when: "--write-baseline",
    ignored: [
      "--format",
      "--suppress",
      "--baseline",
      "--risk-index",
      "--risk-index-model",
      "--fix-dry-run",
      "--fix-write",
      "--fail-on",
    ],
    because:
      "--write-baseline records the scan instead of reporting it, so it emits no report and " +
      "applies no filter, index, remediation, or threshold",
  },
  {
    when: "--config",
    ignored: ["--ignore-config"],
    because: "--config names the config to load, and leaves no discovery pass to skip",
  },
];

/**
 * The single reason this invocation is refused, or `undefined` if it is coherent.
 *
 * Value errors come first: a flag whose argument is not a thing is wrong on its own terms, and
 * saying so is more useful than reporting what it conflicts with. Contradictions come next, then
 * flags a run would accept and ignore.
 *
 * Returns the sentence without the `fairux: ` prefix. Every user-supplied value it quotes is
 * sanitised here, so a value carrying an escape sequence cannot reach the terminal intact.
 */
export function validateScanOptions(state: ScanOptionState): string | undefined {
  if (!(VALID_FORMATS as readonly string[]).includes(state.format)) {
    return `unknown format "${sanitizeForTerminal(state.format)}" (use ${orList(VALID_FORMATS)})`;
  }
  if (state.failOn !== undefined && !(VALID_FAIL_ON as readonly string[]).includes(state.failOn)) {
    return (
      `unknown --fail-on severity "${sanitizeForTerminal(state.failOn)}" ` +
      `(use ${orList(VALID_FAIL_ON)})`
    );
  }
  if (
    state.riskIndexModel !== undefined &&
    !RISK_INDEX_MODEL_VERSIONS.includes(state.riskIndexModel)
  ) {
    // Refused before the scan, like an unknown format: the invocation names a model that does not
    // exist, rather than the run failing after the work is done.
    return (
      `unknown risk index model "${sanitizeForTerminal(state.riskIndexModel)}" ` +
      `(use ${orList(RISK_INDEX_MODEL_VERSIONS)})`
    );
  }

  if (state.fixDryRun && state.fixWrite) {
    return (
      "--fix-dry-run and --fix-write ask for opposite things — one changes nothing and the other " +
      "writes. Pass exactly one"
    );
  }

  if (state.isStdin && (state.fixDryRun || state.fixWrite)) {
    // A scan of stdin has no file to fix. The report labels the source `stdin.html` so a reader has
    // something to look at, and a remediation carries that label — which the fix planner then reads
    // as a path. A file of that name in the working directory would be planned against and
    // rewritten: a file nobody scanned, edited from bytes that came from somewhere else.
    //
    // Refused here rather than made to work: piping a fix back out is a feature with its own
    // design, and this is the write-safety hole it would otherwise leave open.
    return (
      "--fix-dry-run and --fix-write need a filesystem input — stdin has no source path to fix, " +
      "and the label a piped scan reports is not one"
    );
  }

  const flags = present(state);
  for (const rule of INEFFECTIVE) {
    if (!flags.has(rule.when)) continue;
    const ignored = rule.ignored.filter((flag) => flags.has(flag));
    if (ignored.length === 0) continue;
    return `${rule.when} ignores ${ignored.join(", ")} — ${rule.because}. Remove one`;
  }

  // The one ineffective flag whose trigger is an *absence*, so it does not fit the table above.
  if (state.riskIndexModel !== undefined && state.riskIndex === undefined) {
    return (
      "--risk-index-model has no effect without --risk-index — no index is computed at all, so " +
      "the model named here scores nothing"
    );
  }

  return undefined;
}

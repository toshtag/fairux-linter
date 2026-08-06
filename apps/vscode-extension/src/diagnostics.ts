import { parseSource } from "@fairux/ast";
import { type ConfigDiagnostic, discoverConfig, parseJsonConfig } from "@fairux/config-node";
import { createScanner, type FairUxReport, type FairuxConfig, type Severity } from "@fairux/core";
import { parseHtml } from "@fairux/html";
import { fairuxBuiltinRulePack } from "@fairux/rules";
import { type ConfigNotification, sanitizeConfigNotification } from "./config-notifications.js";

/** Mirrors `vscode.DiagnosticSeverity` numeric values (Error=0 … Hint=3) without importing vscode. */
export enum DiagSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

/** A plain, vscode-free diagnostic. extension.ts converts these into `vscode.Diagnostic`s. */
export interface FairuxDiagnostic {
  /** 0-based, half-open range suitable for a `vscode.Range`. */
  range: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  severity: DiagSeverity;
  message: string;
  code: string;
  source: "FairUX";
  helpUri?: string;
}

const SEVERITY_TO_DIAG: Record<Severity, DiagSeverity> = {
  high: DiagSeverity.Error,
  medium: DiagSeverity.Warning,
  low: DiagSeverity.Information,
  info: DiagSeverity.Hint,
};

/** VS Code language ids that should be parsed as JSX/TSX (AST adapter); else HTML. */
const AST_LANGUAGES = new Set(["javascript", "javascriptreact", "typescript", "typescriptreact"]);

export function isSupportedLanguage(languageId: string): boolean {
  return languageId === "html" || AST_LANGUAGES.has(languageId);
}

function lineLength(lines: string[], line0: number): number {
  return lines[line0]?.length ?? 0;
}

/**
 * Where the squiggle stops.
 *
 * The adapter's own end when it reported one, converted 1-based-to-0-based and left exclusive,
 * which is what a `vscode.Range` end already is. Marking to the end of the start line — what this
 * did for every finding — is wrong in both directions: a `<div>` opening on line 4 and closing on
 * line 9 was marked on line 4 alone, and a finding on an element with other markup after it on the
 * same line dragged the squiggle across code it has nothing to do with.
 *
 * The old behaviour is kept as the fallback rather than deleted, because an adapter is still allowed
 * to report a start and no end — an absent end means "unknown", and a zero-length range at the start
 * column would be a squiggle a reader cannot see.
 */
function endOf(
  source: { endLine?: number; endColumn?: number },
  lines: string[],
  startLine0: number,
): { endLine: number; endColumn: number } {
  if (source.endLine != null && source.endColumn != null) {
    return { endLine: source.endLine - 1, endColumn: source.endColumn - 1 };
  }
  return { endLine: startLine0, endColumn: lineLength(lines, startLine0) };
}

/**
 * Discover and load a fairux.config.json using the SAME security model as the CLI:
 * only JSON is auto-discovered (never executable), symlink/size checks, boundary-aware
 * upward search. Returns the validated config and any diagnostics for user notification.
 */
export function discoverConfigForDocument(docPath: string): {
  config?: FairuxConfig;
  notifications: ConfigNotification[];
} {
  const { configPath, contents, diagnostics } = discoverConfig(docPath);
  const notifications: ConfigNotification[] = diagnostics.map((d: ConfigDiagnostic) =>
    sanitizeConfigNotification({
      level: d.level,
      path: d.path,
      message: d.message,
    }),
  );

  if (configPath && contents !== undefined) {
    try {
      const config = parseJsonConfig(contents, configPath);
      return { config, notifications };
    } catch (err) {
      notifications.push(
        sanitizeConfigNotification({
          level: "error",
          path: configPath,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      return { notifications };
    }
  }
  return { notifications };
}

/**
 * The whole engine of the extension, factored out of the activation glue so it's unit-testable
 * under vitest without VS Code. Picks the adapter from the language id, scans, and maps findings
 * to plain diagnostics with 0-based ranges. Findings without a source location are dropped (they
 * can't be anchored) rather than mis-placed at line 0.
 *
 * If `config` is provided, rule overrides and includeExperimental are applied.
 */
export function computeDiagnostics(
  text: string,
  languageId: string,
  config?: FairuxConfig,
): FairuxDiagnostic[] {
  const doc = AST_LANGUAGES.has(languageId)
    ? parseSource(text, { file: `doc.${languageId}` })
    : parseHtml(text, { file: "doc.html" });
  const includeExperimental = config?.includeExperimental ?? false;
  const report: FairUxReport = createScanner({
    rulePacks: [fairuxBuiltinRulePack],
    ruleOverrides: config?.rules,
    includeExperimental,
  }).scan(doc);

  const lines = text.split(/\r?\n/);
  const diagnostics: FairuxDiagnostic[] = [];

  for (const finding of report.findings) {
    const source = finding.evidence[0]?.source;
    if (!source || source.startLine == null) continue; // can't anchor → skip (don't mis-place)
    const startLine = source.startLine - 1; // 1-based → 0-based
    const startColumn = (source.startColumn ?? 1) - 1;
    diagnostics.push({
      range: {
        startLine,
        startColumn,
        ...endOf(source, lines, startLine),
      },
      severity: SEVERITY_TO_DIAG[finding.severity],
      message: `${finding.title} — ${finding.description} (confidence: ${finding.confidence})\n${finding.recommendation}`,
      code: finding.ruleId,
      source: "FairUX",
      helpUri: finding.references?.[0],
    });
  }
  return diagnostics;
}

import { parseSource } from "@fairux/ast";
import { type FairUxReport, type Severity, scan } from "@fairux/core";
import { parseHtml } from "@fairux/html";
import { allRules, dictionary } from "@fairux/rules";

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
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
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
 * The whole engine of the extension, factored out of the activation glue so it's unit-testable
 * under vitest without VS Code. Picks the adapter from the language id, scans, and maps findings
 * to plain diagnostics with 0-based ranges. Findings without a source location are dropped (they
 * can't be anchored) rather than mis-placed at line 0.
 */
export function computeDiagnostics(text: string, languageId: string): FairuxDiagnostic[] {
  const doc = AST_LANGUAGES.has(languageId)
    ? parseSource(text, { file: `doc.${languageId}` })
    : parseHtml(text, { file: "doc.html" });
  const report: FairUxReport = scan(doc, allRules, { dictionary });

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
        endLine: startLine,
        endColumn: lineLength(lines, startLine), // highlight to end of the line
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

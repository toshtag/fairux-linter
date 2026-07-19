import * as vscode from "vscode";
import { computeDiagnostics, type FairuxDiagnostic, isSupportedLanguage } from "./diagnostics.js";

function toVscode(d: FairuxDiagnostic): vscode.Diagnostic {
  const range = new vscode.Range(
    d.range.startLine,
    d.range.startColumn,
    d.range.endLine,
    d.range.endColumn,
  );
  const diag = new vscode.Diagnostic(range, d.message, d.severity as number);
  diag.source = d.source;
  diag.code = d.helpUri ? { value: d.code, target: vscode.Uri.parse(d.helpUri) } : d.code;
  return diag;
}

function enabled(): boolean {
  return vscode.workspace.getConfiguration("fairux").get<boolean>("enable", true);
}

function debounceMs(): number {
  return vscode.workspace.getConfiguration("fairux").get<number>("debounceMs", 300);
}

export function activate(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection("fairux");
  context.subscriptions.push(collection);

  const refresh = (doc: vscode.TextDocument): void => {
    if (!enabled() || !isSupportedLanguage(doc.languageId)) {
      collection.delete(doc.uri);
      return;
    }
    try {
      const diags = computeDiagnostics(doc.getText(), doc.languageId).map(toVscode);
      collection.set(doc.uri, diags);
    } catch {
      collection.delete(doc.uri); // a parse error shouldn't surface as a FairUX diagnostic
    }
  };

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduleRefresh = (doc: vscode.TextDocument): void => {
    const key = doc.uri.toString();
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        refresh(doc);
      }, debounceMs()),
    );
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidSaveTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => scheduleRefresh(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri)),
  );

  for (const doc of vscode.workspace.textDocuments) refresh(doc);
}

export function deactivate(): void {
  // DiagnosticCollection is disposed via context.subscriptions.
}

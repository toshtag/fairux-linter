import { sanitizeSingleLineDisplay } from "@fairux/config-node";
import * as vscode from "vscode";
import {
  type ConfigNotification,
  ConfigNotificationTracker,
  formatConfigNotification,
  sanitizeConfigNotification,
} from "./config-notifications.js";
import {
  computeDiagnostics,
  discoverConfigForDocument,
  type FairuxDiagnostic,
  isSupportedLanguage,
} from "./diagnostics.js";

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

const shownConfigNotifications = new ConfigNotificationTracker();

function showConfigNotifications(
  notifications: ConfigNotification[],
  status: vscode.OutputChannel,
): void {
  for (const n of notifications) {
    const safe = sanitizeConfigNotification(n);
    if (!shownConfigNotifications.shouldShow(safe)) continue;
    status.appendLine(formatConfigNotification(safe));
    if (safe.level === "error") {
      void vscode.window.showErrorMessage(`FairUX config error: ${safe.message}`, "Dismiss");
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection("fairux");
  const status = vscode.window.createOutputChannel("FairUX");
  context.subscriptions.push(collection, status);

  const refresh = (doc: vscode.TextDocument): void => {
    if (!enabled() || !isSupportedLanguage(doc.languageId)) {
      collection.delete(doc.uri);
      return;
    }
    try {
      const { config, notifications } = discoverConfigForDocument(doc.uri.fsPath);

      // Check for config errors - fail-closed behavior
      const hasErrors = notifications.some((n) => n.level === "error");
      if (hasErrors) {
        // Clear diagnostics for this document when config has errors
        collection.delete(doc.uri);
        showConfigNotifications(notifications, status);
        return;
      }

      // Only show warnings, then proceed with scan
      const warnings = notifications.filter((n) => n.level === "warn");
      if (warnings.length > 0) {
        showConfigNotifications(warnings, status);
      }

      const diags = computeDiagnostics(doc.getText(), doc.languageId, config).map(toVscode);
      collection.set(doc.uri, diags);
    } catch (err) {
      status.appendLine(`[FairUX] Scan error: ${sanitizeSingleLineDisplay(err)}`);
      collection.delete(doc.uri);
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

  // Watch for fairux.config.json changes and refresh all open documents.
  const configWatcher = vscode.workspace.createFileSystemWatcher("**/fairux.config.json");
  context.subscriptions.push(configWatcher);
  const refreshAll = (): void => {
    for (const doc of vscode.workspace.textDocuments) {
      if (isSupportedLanguage(doc.languageId)) refresh(doc);
    }
  };
  const onConfigChanged = (): void => {
    shownConfigNotifications.reset();
    refreshAll();
  };
  context.subscriptions.push(
    configWatcher.onDidChange(onConfigChanged),
    configWatcher.onDidCreate(onConfigChanged),
    configWatcher.onDidDelete(onConfigChanged),
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidSaveTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => scheduleRefresh(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri)),
  );

  for (const doc of vscode.workspace.textDocuments) refresh(doc);

  context.subscriptions.push({
    dispose: () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      shownConfigNotifications.reset();
    },
  });
}

export function deactivate(): void {
  // DiagnosticCollection and OutputChannel are disposed via context.subscriptions.
  // Pending debounce timers are cleared to prevent accessing disposed resources.
}

"use strict";

/**
 * What only a real extension host can answer.
 *
 * `apps/vscode-extension/test/*.test.ts` runs under vitest and cannot import `src/extension.ts` at
 * all, because that file imports `vscode`, which exists nowhere but inside an extension host. So the
 * activation wiring was checked by reading the source: whether `activate()` runs, whether
 * `onDidChangeConfiguration` fires for `fairux.*`, and whether disposal releases what it claims were
 * all inferences from the text of the file.
 *
 * This suite runs inside the host. It is deliberately plain: no test framework, because a framework
 * here means another dependency in a place that has to load before anything can be asserted, and
 * the assertions are few enough to write out.
 */

const assert = require("node:assert/strict");
const vscode = require("vscode");

const EXTENSION_ID = "undefined_publisher.fairux-vscode";

/** Poll until a predicate holds, so a debounce is waited out rather than slept past. */
async function until(what, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const CONSENT_PAGE = [
  "<html><body>",
  "<h1>Cookie consent</h1>",
  '<label><input type="checkbox" checked> Email me marketing offers</label>',
  "</body></html>",
].join("\n");

async function openDocument(content, language) {
  const document = await vscode.workspace.openTextDocument({ content, language });
  await vscode.window.showTextDocument(document);
  return document;
}

const fairux = () => vscode.workspace.getConfiguration("fairux");

async function run() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `the extension is not installed as ${EXTENSION_ID}`);

  // 1. It activates at all, on the language it says it activates on. `activationEvents` is a
  //    manifest claim nothing outside a host can check.
  const document = await openDocument(CONSENT_PAGE, "html");
  await until("activation", () => extension.isActive);

  // 2. Diagnostics arrive, from the real engine, through the real collection.
  const diagnostics = await until("diagnostics", () => {
    const found = vscode.languages.getDiagnostics(document.uri);
    return found.length > 0 ? found : undefined;
  });
  const checked = diagnostics.find((entry) => entry.code === "consent/checked-checkbox");
  assert.ok(checked, "the pre-checked consent box produced no diagnostic");
  assert.equal(checked.source, "FairUX");
  assert.equal(checked.severity, vscode.DiagnosticSeverity.Error);

  // 3. The range covers the element and stops there. A `vscode.Range` silently swaps an inverted
  //    pair, so the only place a wrong end is visible is a real one.
  assert.equal(checked.range.start.line, 2);
  assert.equal(checked.range.end.line, 2);
  assert.ok(
    checked.range.end.character > checked.range.start.character,
    "the diagnostic range does not move forward",
  );
  const line = document.lineAt(2).text;
  assert.ok(
    checked.range.end.character < line.length,
    `the range runs to the end of the line (${checked.range.end.character} of ${line.length})`,
  );
  assert.equal(
    document.getText(checked.range),
    '<input type="checkbox" checked>',
    "the range does not cover the element the finding is about",
  );

  // 4. The settings lifecycle, which was the other thing only the host can answer:
  //    `onDidChangeConfiguration` firing for `fairux.*` and the collection actually clearing.
  await fairux().update("enable", false, vscode.ConfigurationTarget.Global);
  await until(
    "diagnostics to clear",
    () => vscode.languages.getDiagnostics(document.uri).length === 0,
  );

  await fairux().update("enable", true, vscode.ConfigurationTarget.Global);
  await until(
    "diagnostics to come back",
    () => vscode.languages.getDiagnostics(document.uri).length > 0,
  );
  await fairux().update("enable", undefined, vscode.ConfigurationTarget.Global);

  // 5. A language the extension does not claim gets nothing — the activation list is a boundary,
  //    not a formality.
  const plain = await openDocument("Only 2 left in stock!", "plaintext");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(
    vscode.languages.getDiagnostics(plain.uri).length,
    0,
    "a plaintext document received FairUX diagnostics",
  );
}

module.exports = { run };

/**
 * Audit the SDK's browser entry with the installed TypeScript parser.
 *
 * This replaces a hand-written scanner that ran in the privileged publish job. Its comment claimed
 * that code inside a template literal's `${}` was still reached; it was not — the scan skipped to
 * the closing backtick — so `` `${import("node:fs")}` `` and `` `${require("fs")}` `` were missed.
 * The lesson is not that the scanner needed another case: writing a JavaScript parser out of Node
 * built-ins, so that it could run where no `node_modules` exists, was the wrong trade. Each round
 * of fixes bought one syntax form and added a new place to be wrong.
 *
 * So the responsibility moves to where a real parser is already installed — the unprivileged
 * `prepare` job and PR CI — and uses the same `typescript/unstable` API the `@fairux/ast` package
 * parses with. An AST walker reaches template expressions the way it reaches everything else.
 *
 * The privileged publish job no longer claims anything about arbitrary JavaScript semantics. It
 * verifies the structural release contract — member identity, manifest, payload, digests — plus the
 * static module requests Node's own parser reports, and publishes the exact verified bytes without
 * executing them.
 */
import * as ts from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";

const VIRTUAL_CWD = "/fairux-browser-audit";
const VIRTUAL_FILE = `${VIRTUAL_CWD}/entry.js`;

/** Node builtin specifiers, in both the bare and `node:`-prefixed spellings. */
function builtinSet(builtinModules) {
  const names = builtinModules.map((name) => name.replace(/^node:/, ""));
  return new Set([...names, ...names.map((name) => `node:${name}`)]);
}

function withSourceFile(code, build) {
  const api = new API({
    cwd: VIRTUAL_CWD,
    fs: createVirtualFileSystem({ [VIRTUAL_FILE]: code }),
  });
  try {
    const snapshot = api.updateSnapshot({ openFiles: [VIRTUAL_FILE] });
    const source = snapshot
      .getDefaultProjectForFile(VIRTUAL_FILE)
      ?.program.getSourceFile(VIRTUAL_FILE);
    if (!source) throw new Error("the TypeScript API returned no source file");
    return build(source);
  } finally {
    api.close();
  }
}

/** The literal text of a module specifier, or null when it is not a plain string. */
function specifierText(node) {
  return node && ts.isStringLiteralLikeNode(node) ? node.text : null;
}

/**
 * @param {string} source  the browser entry's contents; never executed
 * @param {readonly string[]} builtinModules  from `node:module`
 * @returns {string[]} failures; empty means the entry is free of Node builtins and runtime loads
 */
export function auditBrowserModule(source, builtinModules) {
  const builtins = builtinSet(builtinModules);
  const failures = [];

  withSourceFile(source, (file) => {
    const visit = (node) => {
      // --- Static module requests: only a Node builtin is a problem ---------------------------
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = specifierText(node.moduleSpecifier);
        if (specifier !== null && builtins.has(specifier)) {
          failures.push(`browser entry statically imports the Node builtin ${specifier}`);
        }
      }
      if (ts.isImportEqualsDeclaration(node)) {
        failures.push("browser entry uses an import-equals declaration");
      }

      // --- Runtime module loads: refused regardless of specifier -------------------------------
      // The specifier is not extracted, so there is nothing left to obfuscate. `import.meta` is a
      // MetaProperty, not a call, and a `require` reached through a member expression is somebody
      // else's function.
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          failures.push("browser entry performs a dynamic import");
        } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
          failures.push("browser entry calls require()");
        }
      }

      node.forEachChild(visit);
    };
    file.forEachChild(visit);
  });

  return [...new Set(failures)];
}

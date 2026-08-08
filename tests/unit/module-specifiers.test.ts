import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { forbiddenReason } from "../../scripts/check-runtime-safety.mjs";
import { moduleSpecifiers } from "../../scripts/module-specifiers.mjs";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = join(ROOT, "tests/fixtures/runtime-safety");

/**
 * What the browser-safety check counts as loading a module.
 *
 * Two implementations failed here before this one, and the second failed twice. A line-by-line
 * regex missed `require("fs")`, a comment between the keyword and the specifier, and a dynamic
 * import split across lines. A hand-written lexer replaced it and missed three more: it blanked
 * whole template literals, so `` `${await import("node:fs")}` `` disappeared; it never decoded
 * escapes, so `require("\x66s")` was not `fs`; and it had no regex literals, so a `/foo import
 * "node:fs"/` was a violation.
 *
 * Each fix made the lexer a larger partial implementation of a grammar. These fixtures are the ones
 * that a partial implementation gets wrong — every form a specifier arrives by, and every place one
 * may appear without being a module load — and they are files rather than strings so the same cases
 * also pin the exit code of the real check.
 */

const fixtures = (kind: "refused" | "allowed") =>
  readdirSync(join(FIXTURES, kind))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => [name.replace(/\.ts$/, ""), join(FIXTURES, kind, name)] as const);

async function specifiersIn(file: string) {
  return await moduleSpecifiers({
    source: readFileSync(file, "utf8"),
    path: file,
  });
}

describe("what counts as loading a module", () => {
  it.each(fixtures("refused"))("refuses %s", async (_name, file) => {
    const forbidden = (await specifiersIn(file)).filter(
      (entry) => forbiddenReason(entry.specifier) !== undefined,
    );
    expect(forbidden).toHaveLength(1);
  });

  it.each(fixtures("allowed"))("does not refuse %s", async (_name, file) => {
    const forbidden = (await specifiersIn(file)).filter(
      (entry) => forbiddenReason(entry.specifier) !== undefined,
    );
    expect(forbidden).toEqual([]);
  });

  it("finds what a browser-safe file does load, and nothing it only mentions", async () => {
    // The other direction of the same claim: a check that found no specifiers anywhere would pass
    // every fixture above and be worthless.
    const found = await specifiersIn(join(FIXTURES, "allowed/browser-safe-import.ts"));
    expect(found.map((entry) => entry.specifier)).toEqual(["@fairux/core", "./neighbour.js"]);
  });

  it("reports the line the specifier is on, not the line the statement started", async () => {
    const found = await specifiersIn(join(FIXTURES, "refused/multiline-dynamic-import.ts"));
    expect(found).toEqual([expect.objectContaining({ specifier: "node:crypto", line: 3 })]);
  });

  it("decodes the specifier rather than repeating the source", async () => {
    // `require("\x66s")` loads `fs`. A scanner that reports the characters between the quotes
    // reports `\x66s`, which matches nothing forbidden and passes.
    const found = await specifiersIn(join(FIXTURES, "refused/escaped-specifier.ts"));
    expect(found.map((entry) => entry.specifier)).toEqual(["fs"]);
  });

  it("refuses to answer for a file it could not parse", async () => {
    // Fail-closed. A syntax error yields no specifiers, which is indistinguishable from a clean
    // file unless it is an error — and the whole class of defect being fixed here is a check that
    // returns green because it did not look.
    await expect(
      moduleSpecifiers({ source: "import { from 'node:fs'", path: "broken.ts" }),
    ).rejects.toThrow(/could not read a file/);
  });
});

describe("the check itself", () => {
  const check = async (target: string) =>
    await run("node", [join(ROOT, "scripts/check-runtime-safety.mjs"), target], { cwd: ROOT })
      .then(() => 0)
      .catch((failure: { code?: number }) => failure.code ?? 1);

  it("exits non-zero on the refused fixtures", async () => {
    expect(await check(join(FIXTURES, "refused"))).not.toBe(0);
  });

  it("exits zero on the allowed fixtures", async () => {
    expect(await check(join(FIXTURES, "allowed"))).toBe(0);
  });

  it("names the file, the line, and the reason", async () => {
    const failure = await run("node", [
      join(ROOT, "scripts/check-runtime-safety.mjs"),
      join(FIXTURES, "refused"),
    ]).catch((error: { stderr: string }) => error);
    const stderr = (failure as { stderr: string }).stderr;
    expect(stderr).toMatch(/escaped-specifier\.ts:1.*Node builtin.*fs/);
    expect(stderr).toMatch(/template-interpolation\.ts:1.*node: builtin.*node:util/);
    // Every refused fixture has to be in the report, not just the first one esbuild reached.
    expect(stderr.match(/\[(?:node: builtin|Node builtin)]/g)).toHaveLength(
      fixtures("refused").length,
    );
  });
});

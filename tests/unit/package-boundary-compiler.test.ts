import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Proves the workspace boundary is *enforced*, not merely configured.
 *
 * `tests/unit/package-boundary-contract.test.ts` asserts the `rootDir` settings exist. This runs
 * the repository-pinned compiler against a two-package fixture and asserts on the diagnostic code
 * itself. Asserting a non-zero exit would not be evidence: any unrelated type error also exits 1.
 *
 * It also fixes the boundary of the claim. `rootDir` does not decide what enters a program — it
 * constrains where emit-relevant files may live once TypeScript has resolved them. So the contract
 * covers TypeScript module references, and the plain `require()` case below records, by
 * measurement, that it does not cover a bare runtime call.
 */

const repoRoot = resolve(import.meta.dirname, "../..");
const fixture = resolve(repoRoot, "tests/fixtures/package-boundary");
const tsc = resolve(repoRoot, "node_modules/.bin/tsc");

let workdir: string;

beforeAll(() => {
  workdir = mkdtempSync(resolve(tmpdir(), "fairux-package-boundary-"));
  cpSync(fixture, workdir, { recursive: true });
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function compile(source: string): { output: string; status: number } {
  writeFileSync(resolve(workdir, "package-a/src/index.ts"), `${source}\n`);
  try {
    const output = execFileSync(
      tsc,
      ["-p", resolve(workdir, "package-a/tsconfig.json"), "--noEmit"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { output, status: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    return {
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
      status: failure.status ?? 1,
    };
  }
}

const FOREIGN = "../../package-b/src/index.js";

describe("package boundary — enforced by the pinned compiler", () => {
  it("uses the repository-pinned TypeScript, not a global one", () => {
    const version = execFileSync(tsc, ["--version"], { encoding: "utf8" }).trim();
    const pinned = JSON.parse(
      execFileSync("node", ["-p", "JSON.stringify(require('typescript/package.json'))"], {
        cwd: repoRoot,
        encoding: "utf8",
      }),
    ) as { version: string };
    expect(version).toContain(pinned.version);
  });

  it("reports TS6059 for a static import of another workspace's source", () => {
    const { output, status } = compile(
      `import { value } from "${FOREIGN}";\nexport const a = value;`,
    );
    expect(output).toContain("TS6059");
    expect(output).toContain("package-b");
    expect(status).not.toBe(0);
  });

  it("reports TS6059 for a dynamic import", () => {
    const { output, status } = compile(`export const a = () => import("${FOREIGN}");`);
    expect(output).toContain("TS6059");
    expect(output).toContain("package-b");
    expect(status).not.toBe(0);
  });

  it("reports TS6059 for an import-equals external module reference", () => {
    const { output, status } = compile(
      `import value = require("${FOREIGN}");\nexport const a = value;`,
    );
    expect(output).toContain("TS6059");
    expect(output).toContain("package-b");
    expect(status).not.toBe(0);
  });

  it("reports TS6059 for a directory import that resolves into the foreign src", () => {
    const { output, status } = compile(
      `import { value } from "../../package-b/src";\nexport const a = value;`,
    );
    expect(output).toContain("TS6059");
    expect(output).toContain("package-b");
    expect(status).not.toBe(0);
  });

  it("does NOT cover a plain require() call — measured, not assumed", () => {
    // A bare `require(…)` is a runtime call, not a TypeScript module reference, so nothing is
    // added to the program and no boundary diagnostic exists to report. Every package here is
    // ESM (`"type": "module"`), so such a call would not work at runtime either — but the
    // documentation must not claim coverage the compiler does not provide.
    const { output, status } = compile(
      `declare const require: (id: string) => unknown;\nexport const a = require("${FOREIGN}");`,
    );
    expect(output).not.toContain("TS6059");
    // Compiles clean — so the absence of TS6059 is a real answer, not a different failure.
    expect(status).toBe(0);
  });

  it.each([
    ["a string literal", `export const a = 'import "${FOREIGN}"';`],
    ["a template literal", `export const a = String.raw\`import "${FOREIGN}"\`;`],
    ["a line comment", `// import "${FOREIGN}"\nexport const a = 1;`],
    ["a block comment", `/* import "${FOREIGN}" */\nexport const a = 1;`],
    [
      "a member call",
      `declare const loader: { import(id: string): unknown };\nexport const a = loader.import("${FOREIGN}");`,
    ],
  ])("does not report TS6059 for %s that merely looks like an import", (_label, source) => {
    const { output, status } = compile(source);
    expect(output).not.toContain("TS6059");
    // Without this, a fixture that failed to compile at all would pass as a clean control.
    expect(status).toBe(0);
  });

  it("compiles the untouched fixture cleanly", () => {
    const { output, status } = compile("export const placeholder = 1;");
    expect(output).not.toContain("TS6059");
    expect(status).toBe(0);
  });
});

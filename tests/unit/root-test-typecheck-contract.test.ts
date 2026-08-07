import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The wiring that puts root unit tests under a compiler, checked by something other than memory.
 *
 * `pnpm -r --if-present typecheck` visits workspace packages. The repository root is not one, and
 * `tests/unit` lives there — so for the whole life of this repository these 49 files were checked
 * by nothing, and a `JSON.parse(...) as { … }` naming a shape the data does not have sat in them
 * until a compiler was finally pointed at it.
 *
 * Closing that gap put four strings in `package.json` and one tsconfig on disk. Nothing else
 * referenced them. Deleting `&& pnpm typecheck:root-tests` would have left every test in this
 * repository green — the root tests would still *run*, they would simply stop being typechecked,
 * which is the exact state this branch exists to end. A gate whose own removal is silent is not a
 * gate, so this is the test that notices.
 *
 * It reads the *resolved* configuration — `tsc --showConfig`, not the file text — so the assertions
 * below are about what the compiler actually does. Strictness inherited from `tsconfig.base.json`
 * arrives here already resolved: weakening it in the base, or overriding it in the root config,
 * fails this the same way.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_FILE = "tsconfig.root-tests.json";

/**
 * The root-level TypeScript trees this config owns, in order.
 *
 * Two, and listed rather than globbed: `tests/fixtures` is deliberately outside — those trees are
 * compiled by the tests that own them, one of which asserts a TS6059 error.
 */
const ROOT_TEST_INCLUDE = ["tests/unit/**/*.ts", "tests/setup/**/*.ts"] as const;

/** The resolved shape of `tsc --showConfig`, narrowed to what is asserted. */
interface ResolvedConfig {
  readonly compilerOptions: Record<string, unknown>;
  readonly files: readonly string[];
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

interface Wiring {
  readonly scripts: Readonly<Record<string, string>>;
  readonly config: ResolvedConfig;
}

/**
 * Every strict-family flag the root test program must have on.
 *
 * `noUncheckedIndexedAccess` earns its place by name: 32 of the 72 errors this branch fixed were
 * that flag, and it is the one most easily switched off to make a red typecheck go green.
 */
const REQUIRED_FLAGS = [
  "strict",
  "noUncheckedIndexedAccess",
  "noImplicitOverride",
  "noFallthroughCasesInSwitch",
  "forceConsistentCasingInFileNames",
] as const;

/**
 * Violations of the root-test typecheck contract, as a list.
 *
 * Pure, so the mutations below can be fed to it directly rather than written to disk.
 */
function rootTestTypecheckFailures({ scripts, config }: Wiring): string[] {
  const failures: string[] = [];
  const { compilerOptions: options } = config;

  const rootTests = scripts["typecheck:root-tests"];
  const workspaces = scripts["typecheck:workspaces"];
  const built = scripts["typecheck:built"];

  // 1. The two halves exist, and the root half names this config.
  if (!workspaces) failures.push("no typecheck:workspaces script");
  if (!rootTests) failures.push("no typecheck:root-tests script");
  else if (!rootTests.includes(CONFIG_FILE)) {
    failures.push(`typecheck:root-tests does not use ${CONFIG_FILE}: ${rootTests}`);
  }

  // 2. `typecheck:built` calls both. This is the assertion that matters most: it is what makes the
  //    command CI runs and the command a contributor runs mean the same thing.
  if (!built) failures.push("no typecheck:built script");
  else {
    if (!built.includes("typecheck:workspaces")) {
      failures.push(`typecheck:built does not run workspace typechecking: ${built}`);
    }
    if (!built.includes("typecheck:root-tests")) {
      failures.push(`typecheck:built does not run root test typechecking: ${built}`);
    }
    // Sequenced, not backgrounded or made optional: `&&` propagates the first failure.
    if (built.includes("typecheck:root-tests") && !built.includes("&&")) {
      failures.push(`typecheck:built does not sequence its two halves: ${built}`);
    }
  }

  // 3. The scope is the two root-level TypeScript trees no workspace typechecks, and only those.
  //
  //    `tests/setup` joined `tests/unit` when the CLI-process budget arrived: a vitest setup file is
  //    root-level TypeScript that `pnpm -r --if-present typecheck` cannot see, which is the whole
  //    reason this config exists. It is listed exactly, not widened to `tests/**`, because
  //    `tests/fixtures` is deliberately outside — see the exclusion below and the reason under 4.
  const include = config.include ?? [];
  if (
    include.length !== ROOT_TEST_INCLUDE.length ||
    include.some((entry, index) => entry !== ROOT_TEST_INCLUDE[index])
  ) {
    failures.push(
      `include should be exactly ${JSON.stringify(ROOT_TEST_INCLUDE)}, got ${JSON.stringify(include)}`,
    );
  }
  if (!(config.exclude ?? []).includes("tests/fixtures/**")) {
    failures.push("tests/fixtures/** is not excluded");
  }

  // 4. No fixture reaches the program. The fixtures are compiled by the tests that own them, under
  //    their own configs — `package-boundary` by one that asserts TS6059, the SDK consumers against
  //    a tarball installed into a temporary directory. Typechecking them here would mean editing
  //    negative fixtures until they stopped being negative.
  //
  //    Matched on the path segment: a substring test for "fixtures" also catches
  //    `third-party-fixtures-contract.test.ts`, which is a unit test and belongs here.
  const fixtures = config.files.filter((file) => file.includes("/tests/fixtures/"));
  if (fixtures.length > 0) {
    failures.push(`fixtures reached the root test program: ${fixtures.join(", ")}`);
  }
  if (config.files.length === 0) failures.push("the root test program is empty");

  // 5. Strictness, as resolved — so weakening the base fails here too.
  for (const flag of REQUIRED_FLAGS) {
    if (options[flag] !== true) failures.push(`${flag} is not enabled`);
  }
  if (options["noImplicitAny"] === false) failures.push("noImplicitAny is explicitly disabled");

  // 6. The runtime these tests actually have.
  const lib = (options["lib"] as string[] | undefined) ?? [];
  if (!lib.some((entry) => /^es20(2[3-9]|[3-9]\d)$/i.test(entry))) {
    failures.push(`lib should carry ES2023 or later, got ${JSON.stringify(lib)}`);
  }
  if (!lib.some((entry) => entry.toLowerCase() === "dom")) failures.push("lib does not carry DOM");
  if (!((options["types"] as string[] | undefined) ?? []).includes("node")) {
    failures.push("types does not carry node");
  }

  // 7. Module mappings are exact. A `@fairux/*` wildcard would quietly redirect every package to
  //    whatever matched — turning `report-schema-contract`, which asks what a *consumer* receives,
  //    into a check against this checkout's sources.
  const paths = (options["paths"] as Record<string, string[]> | undefined) ?? {};
  for (const [specifier, targets] of Object.entries(paths)) {
    if (specifier.includes("*")) failures.push(`wildcard path mapping: ${specifier}`);
    if (targets.length !== 1) {
      failures.push(`${specifier} maps to ${targets.length} targets, expected exactly one`);
    }
    for (const target of targets) {
      if (!target.endsWith(".d.ts") && !target.endsWith(".d.mts")) {
        failures.push(`${specifier} maps to ${target}, which is not a declaration entry`);
      }
      if (target.includes("/src/")) {
        failures.push(`${specifier} maps into package sources: ${target}`);
      }
    }
  }

  return failures;
}

const scripts = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

// The resolved config, from the compiler rather than from the file — `tsconfig.root-tests.json`
// carries comments, and reading it as text would check what it says instead of what it means.
const config = JSON.parse(
  execFileSync("npx", ["tsc", "--showConfig", "-p", CONFIG_FILE], {
    cwd: ROOT,
    encoding: "utf8",
  }),
) as ResolvedConfig;

/** The tracked wiring with one thing broken, for the negative cases. */
const withScripts = (over: Record<string, string | undefined>): Wiring => {
  const changed: Record<string, string> = { ...scripts };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete changed[key];
    else changed[key] = value;
  }
  return { scripts: changed, config };
};
const withOptions = (over: Record<string, unknown>): Wiring => ({
  scripts,
  config: { ...config, compilerOptions: { ...config.compilerOptions, ...over } },
});

describe("the root test typecheck contract", () => {
  it("holds for the tracked configuration", () => {
    expect(rootTestTypecheckFailures({ scripts, config })).toEqual([]);
  });

  it("covers every root unit test, and the count is not zero", () => {
    // The count is the reason this exists: an `include` that quietly matched nothing would satisfy
    // every other assertion here.
    expect(config.files.length).toBeGreaterThanOrEqual(49);
    expect(
      config.files.every((file) =>
        ROOT_TEST_INCLUDE.some((pattern) => file.startsWith(`./${pattern.split("**")[0]}`)),
      ),
    ).toBe(true);
    // And each listed tree actually contributes, so a pattern that matched nothing would fail here
    // rather than pass by being ignored.
    for (const pattern of ROOT_TEST_INCLUDE) {
      const prefix = `./${pattern.split("**")[0]}`;
      expect(
        config.files.some((file) => file.startsWith(prefix)),
        `${pattern} matched no file`,
      ).toBe(true);
    }
  });

  it("resolves @fairux/core to the published declaration entry", () => {
    expect(config.compilerOptions["paths"]).toEqual({
      "@fairux/core": ["./packages/core/dist/index.d.ts"],
    });
  });

  it("keeps the consumer-facing test importing by specifier", () => {
    // The mapping above exists to serve this one import, so the mapping alone is not the contract.
    // `report-schema-contract` asks what a *consumer* receives; reaching into
    // `packages/core/src` would skip package resolution, `exports`, and the generated declarations
    // — answering a different question while every assertion in it still passed. That swap is what
    // this refuses, and it is a swap a compiler error makes tempting.
    const source = readFileSync(join(ROOT, "tests/unit/report-schema-contract.test.ts"), "utf8");
    expect(source).toMatch(/^import type \{[^}]*\} from "@fairux\/core";$/m);
    expect(source, "type imports must not reach into packages/core/src").not.toMatch(
      /^import type \{[^}]*\} from "\.\.\/\.\.\/packages\/core\//ms,
    );
  });
});

describe("what the contract refuses", () => {
  // Each of these is a way the gate could be removed or widened while every test still passed.
  it.each([
    [
      "typecheck:built no longer running the root tests",
      withScripts({ "typecheck:built": "pnpm typecheck:workspaces" }),
      /does not run root test typechecking/,
    ],
    [
      "typecheck:built no longer running the workspaces",
      withScripts({ "typecheck:built": "pnpm typecheck:root-tests" }),
      /does not run workspace typechecking/,
    ],
    [
      "the root script deleted outright",
      withScripts({ "typecheck:root-tests": undefined }),
      /no typecheck:root-tests script/,
    ],
    [
      "the root script pointed at another tsconfig",
      withScripts({ "typecheck:root-tests": "tsc --noEmit -p tsconfig.base.json" }),
      /does not use tsconfig\.root-tests\.json/,
    ],
    [
      "the include widened to all of tests/",
      { scripts, config: { ...config, include: ["tests/**/*.ts"] } },
      /include should be exactly/,
    ],
    [
      "the fixture exclusion removed",
      { scripts, config: { ...config, exclude: [] } },
      /tests\/fixtures\/\*\* is not excluded/,
    ],
    [
      "a fixture reaching the program",
      {
        scripts,
        config: { ...config, files: [...config.files, "./tests/fixtures/package-boundary/a.ts"] },
      },
      /fixtures reached the root test program/,
    ],
    ["strict switched off", withOptions({ strict: false }), /strict is not enabled/],
    [
      "noUncheckedIndexedAccess switched off",
      withOptions({ noUncheckedIndexedAccess: false }),
      /noUncheckedIndexedAccess is not enabled/,
    ],
    [
      "noImplicitAny explicitly disabled",
      withOptions({ noImplicitAny: false }),
      /noImplicitAny is explicitly disabled/,
    ],
    [
      "a @fairux/* wildcard mapping",
      withOptions({ paths: { "@fairux/*": ["./packages/*/src/index.ts"] } }),
      /wildcard path mapping/,
    ],
    [
      "@fairux/core pointed into package sources",
      withOptions({ paths: { "@fairux/core": ["./packages/core/src/index.ts"] } }),
      /maps into package sources|not a declaration entry/,
    ],
    [
      "the lib dropped below the tests' runtime",
      withOptions({ lib: ["es2022", "dom"] }),
      /lib should carry ES2023 or later/,
    ],
  ])("refuses %s", (_name, wiring: Wiring, expected: RegExp) => {
    const failures = rootTestTypecheckFailures(wiring);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join("\n")).toMatch(expected);
  });
});

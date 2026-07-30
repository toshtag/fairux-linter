import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, extname, isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { staticImportSpecifiers } from "../../scripts/static-module-imports.mjs";

/**
 * Pins the Purchase Guard architecture contract from
 * `design/decisions/P18-T1-purchase-guard-architecture-contract.md`.
 *
 * The boundary — FairUX measures a UI, the consuming application measures the site — was stated in
 * three documents and enforced nowhere. It fails in the direction that feels helpful: the first
 * time a TLS or reputation signal would be convenient to express as a finding, it inherits severity,
 * SARIF, and CLI rendering for free, and the product boundary is gone before anyone notices it
 * moved.
 *
 * These are structural assertions over identifiers, exports, and prose. They cannot detect a rule
 * that performs a network check while naming itself innocuously; `check:runtime-safety` and the
 * SDK's browser-module audit cover that from the other side, and neither is claimed here. They also
 * establish nothing about registry-installed integration, which is P18-T2.
 */

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const ADR = "design/decisions/P18-T1-purchase-guard-architecture-contract.md";
const adr = read(ADR);

/**
 * Site and security vocabulary, parsed out of the ADR rather than restated here. A term added to
 * the contract is enforced without editing this file, and a term dropped from the contract stops
 * being enforced visibly rather than silently.
 *
 * The ADR holds the list in a fenced block for this reason. An earlier version scraped backticked
 * words between two prose landmarks; adding a paragraph moved one landmark and the list silently
 * grew from 26 terms to 44, pulling in every identifier the surrounding sentences quoted. A
 * delimiter that a rewrite can move is not a delimiter.
 */
const RESERVED_TERMS = (() => {
  const marker = "The reserved\nterms are the whole of this block";
  const start = adr.indexOf(marker);
  if (start === -1) throw new Error(`${ADR} has no reserved-term block`);
  const fence = /```text\n([\s\S]*?)```/.exec(adr.slice(start));
  if (!fence) throw new Error(`${ADR} reserved-term block is not fenced`);
  const terms = (fence[1] as string).split("\n").filter(Boolean);
  if (terms.length < 20) throw new Error(`${ADR} lists only ${terms.length} reserved terms`);
  for (const term of terms) {
    if (!/^[a-z][a-z0-9-]*$/.test(term)) throw new Error(`${ADR}: malformed term "${term}"`);
  }
  return terms;
})();

/** The three public entry points, read from the package that declares them. */
const SDK_EXPORTS = Object.keys(
  (JSON.parse(read("packages/sdk/package.json")) as { exports: Record<string, unknown> }).exports,
);

/** The runtime API. A consumer imports code from these three and nowhere else. */
const PUBLIC_RUNTIME_SDK_SPECIFIERS = [
  "@fairux/sdk",
  "@fairux/sdk/html",
  "@fairux/sdk/dom",
] as const;

/** Metadata, not an API: read to assert the installed version, never imported for behavior. */
const SDK_METADATA_SPECIFIER = "@fairux/sdk/package.json";

const ALLOWED_SDK_SPECIFIERS: readonly string[] = [
  ...PUBLIC_RUNTIME_SDK_SPECIFIERS,
  SDK_METADATA_SPECIFIER,
];

/**
 * Every workspace package, read from the manifests that declare them.
 *
 * The first version of this test hardcoded eight `@fairux/*` names, which is an allowlist of
 * everything else wearing a denylist's clothes: `@fairux/chrome-extension`, `fairux`, and
 * `fairux-vscode` all exist and none was listed, and any package added later would have been
 * admitted silently. Derived from `packages/*` and `apps/*` instead, so a new workspace member is
 * forbidden the moment it appears.
 */
const WORKSPACE_PACKAGES = ["packages", "apps"]
  .flatMap((dir) =>
    readdirSync(resolve(root, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(root, dir, entry.name, "package.json")),
  )
  .filter((path) => existsSync(path))
  .map((path) => (JSON.parse(readFileSync(path, "utf8")) as { name: string }).name)
  .sort();

const FORBIDDEN_PACKAGES = WORKSPACE_PACKAGES.filter((name) => name !== "@fairux/sdk");

/**
 * The fixture trees this contract governs: every directory under `tests/fixtures` except an
 * explicit, reason-bearing exclusion.
 *
 * Discovery rather than a list, for two reasons the previous four-entry array got wrong. A fixture
 * added by P18-T2 would not have been checked at all. And `sdk-custom-rule-pack/invalid` was
 * ungoverned while `governance-consumer.mjs` imports three files out of it — a governed consumer
 * reaching into an ungoverned tree is a hole with a hop in it.
 */
const FIXTURE_TREE = resolve(root, "tests/fixtures");

const EXCLUDED_FIXTURE_ROOTS = new Map([
  ["package-boundary", "TypeScript rootDir fixture; not an external SDK consumer"],
]);

/**
 * The top level, read once and shared.
 *
 * A symlink to a directory is not `isDirectory()`, so filtering on that alone dropped a top-level
 * symlink out of the roots, out of `fixtureFiles`, and therefore out of the symlink check further
 * down — which only ever looked *inside* trees it had already found. `tests/fixtures/x ->
 * ../../packages/core` was invisible to every rule at once.
 */
const FIXTURE_TOP_LEVEL_ENTRIES = readdirSync(FIXTURE_TREE, { withFileTypes: true });

const TOP_LEVEL_SYMLINKS = FIXTURE_TOP_LEVEL_ENTRIES.filter((entry) => entry.isSymbolicLink()).map(
  (entry) => entry.name,
);

const FIXTURE_ROOTS = FIXTURE_TOP_LEVEL_ENTRIES.filter(
  (entry) => entry.isDirectory() && !EXCLUDED_FIXTURE_ROOTS.has(entry.name),
)
  .map((entry) => resolve(FIXTURE_TREE, entry.name))
  .sort();

const SOURCE_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"];
/** Node's type stripping does not handle JSX, so such a fixture must fail rather than be skipped. */
const UNSUPPORTED_EXTENSIONS = [".tsx", ".jsx"];

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) return [path];
    return entry.isDirectory() ? walk(path) : [path];
  });

const describeFile = (path: string) => ({ path, relative: relative(root, path) });

const fixtureFiles = FIXTURE_ROOTS.flatMap(walk).sort();

const consumerSources = fixtureFiles
  .filter((path) => SOURCE_EXTENSIONS.includes(extname(path)))
  .map(describeFile);

const fixtureManifests = fixtureFiles
  .filter((path) => path.endsWith("package.json"))
  .map(describeFile);

/**
 * Containment, without a separator comparison.
 *
 * The previous rule was a `startsWith` against the base plus a forward slash, which is false for
 * every legitimate path on Windows because `resolve()` returns backslashes there. `relative()`
 * answers the question the rule is actually asking, and it does not call `fixtures-other` a child
 * of `fixtures` either.
 */
const isInside = (base: string, target: string) => {
  const value = relative(base, target);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
};

const insideFixtureTree = (target: string) => isInside(FIXTURE_TREE, target);

/**
 * Whether a specifier is absolute in either notation, or a file URL.
 *
 * The scheme is matched case-insensitively because URL schemes are: `new URL("FILE:///tmp/x")`
 * reports `protocol: "file:"`, and Node's parser hands the specifier back verbatim. A
 * `startsWith("file:")` therefore let `FILE:///…` past both the parsed check and — since the raw
 * type-only rule shares this predicate — the erased-literal one.
 */
const isAbsoluteSpecifier = (specifier: string) =>
  /^file:/i.test(specifier) || posix.isAbsolute(specifier) || win32.isAbsolute(specifier);

/**
 * A module's static import specifiers, via Node's own parser.
 *
 * TypeScript is type-stripped by `node:module` first — Node's own grammar, not a hand-rolled one —
 * because `vm.SourceTextModule` parses ES modules and nothing else.
 *
 * This is the exact half of the check, and its limits are why the textual rules below exist rather
 * than being belt-and-braces. Stripping *erases* type-only imports, so `import type … from
 * "@fairux/core"` leaves nothing to find. Dynamic `import()` and `require()` are not static module
 * requests and are excluded by design. A parse failure throws, and the throw is the point: a fixture
 * this cannot read must fail the contract rather than be reported as clean.
 */
const specifiersOf = (path: string): string[] => {
  const source = readFileSync(path, "utf8");
  const parseable = /^\.[cm]?ts$/.test(extname(path))
    ? stripTypeScriptTypes(source, { mode: "strip" })
    : source;
  return staticImportSpecifiers(parseable);
};

/**
 * Every `@fairux/…` reference in raw text — comments and prose included.
 *
 * **Supplementary, not the module parser.** A shape match stops where the shape stops, so
 * `"@fairux/sdk/html?internal"` matched as far as an allowed entry point and read as permitted. The
 * authority over a module specifier is `packageSpecifierViolation`, applied to whole quoted literals
 * and to parsed specifiers alike; this catches an internal package named in a comment, where there
 * is no literal to check.
 *
 * The character class covers punctuation because it previously did not, which is what let
 * `@fairux/sdk.internal` truncate to `@fairux/sdk`.
 */
const fairuxReferences = (source: string) =>
  [...source.matchAll(/@fairux\/[a-z0-9._~-]+(?:\/[a-z0-9._~/-]+)*/giu)].map((match) => match[0]);

/**
 * One quoted-literal scanner, shared by the specifier policy and the escape ban.
 *
 * `\\(?:\r\n|[\s\S])` consumes a line continuation as one escape, so
 * `"@fairux\\
core"` — a specifier split across two lines, which TypeScript stripping erases and
 * every previous matcher missed — is seen as a single literal rather than as no literal at all.
 */
const QUOTED_LITERAL = /(['"])((?:\\(?:\r\n|[\s\S])|(?!\1)[^\\\r\n])*)\1/g;

const quotedStrings = (source: string) =>
  [...source.matchAll(QUOTED_LITERAL)].map((match) => match[2] as string);

/**
 * Quoted literals containing a backslash escape.
 *
 * `"@fairux\u002fcore"` and `"fai\u0072ux"` are the same specifiers as their plain spellings, and
 * neither the raw `@fairux/…` shape nor the workspace-name comparison can see through the encoding.
 * A type-only import is erased before any parser runs, so there is no decoded form to fall back on.
 *
 * Rather than decode — which means implementing a string-literal grammar, and the last rounds are
 * what hand-rolled grammars cost — the contract forbids the construct. No governed fixture uses one
 * today, and a consumer example has no reason to.
 */
const escapedQuotedLiterals = (source: string) =>
  [...source.matchAll(QUOTED_LITERAL)]
    .map((match) => match[0])
    .filter((literal) => literal.includes("\\"));

/**
 * Whitespace or a comment: what may legally sit between two tokens.
 *
 * A line comment ends at any ECMAScript LineTerminator, which is four code points and not two. The
 * previous pattern recognised LF and CRLF only, so a lone CR, U+2028, or U+2029 left the comment
 * unterminated and the call undetected.
 */
const LINE_TERMINATOR = String.raw`(?:\r\n|[\n\r\u2028\u2029])`;
const INTER_TOKEN = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*(?:${LINE_TERMINATOR}|$))*`;
const DYNAMIC_IMPORT = new RegExp(String.raw`\bimport${INTER_TOKEN}\(`);
const REQUIRE_CALL = new RegExp(String.raw`\brequire${INTER_TOKEN}\(`);

/** Whether a specifier names a forbidden workspace package, at its root or a subpath. */
const namesForbiddenPackage = (specifier: string) =>
  FORBIDDEN_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`));

/**
 * One policy for every parsed bare specifier, scoped or not.
 *
 * The previous split checked `@fairux/…` against the allowlist and left unscoped packages to a raw
 * textual rule — so `import "fai\u0072ux"` decoded to `fairux` for the parser, which was not
 * looking, and stayed encoded for the textual rule, which could not see it.
 */
const packageSpecifierViolation = (specifier: string): string | undefined => {
  if (specifier.startsWith("@fairux/")) {
    return ALLOWED_SDK_SPECIFIERS.includes(specifier)
      ? undefined
      : `not a public SDK entry point: ${specifier}`;
  }
  return namesForbiddenPackage(specifier)
    ? `workspace package is internal: ${specifier}`
    : undefined;
};

/** Relative specifiers must name their extension; resolution is not re-implemented here. */
const RELATIVE_EXTENSIONS = [...SOURCE_EXTENSIONS, ".json"];

/** Sources whose type-only imports and exports are erased before any parser sees them. */
const TYPE_STRIPPED_EXTENSIONS = [".ts", ".mts", ".cts"];

const isTypeStrippedSource = (path: string) => TYPE_STRIPPED_EXTENSIONS.includes(extname(path));

/** A literal that could be a path specifier: relative, absolute, or a file URL. */
const isPathShapedLiteral = (literal: string) =>
  literal.startsWith(".") || isAbsoluteSpecifier(literal);

const governedSources = new Set(consumerSources.map((source) => source.path));

/** TypeScript sources name their emitted `.js`; the counterpart is tried before a path is refused. */
const SOURCE_COUNTERPARTS: Readonly<Record<string, string>> = {
  ".js": ".ts",
  ".mjs": ".mts",
  ".cjs": ".cts",
};

/**
 * The whole path contract, in one place.
 *
 * It was four assertions spread across three tests, each reading a parsed specifier — and type
 * stripping erases a type-only import before any parser sees it, so
 * `import type { X } from "../../../packages/core/src/index.ts"` reached none of them. The package
 * half of that hole was closed by checking raw literals; the path half was not.
 */
const pathSpecifierViolation = (fromPath: string, specifier: string): string | undefined => {
  if (isAbsoluteSpecifier(specifier)) return `absolute or file specifier: ${specifier}`;
  if (!specifier.startsWith(".")) return undefined;

  const extension = extname(specifier);
  if (!RELATIVE_EXTENSIONS.includes(extension)) {
    return `relative specifier lacks an explicit supported extension: ${specifier}`;
  }

  const target = resolve(dirname(fromPath), specifier);
  if (!insideFixtureTree(target))
    return `relative specifier escapes the fixture tree: ${specifier}`;

  if (extension === ".json") {
    // An asset is confined but not required to exist: the packed smoke runner copies
    // `rule-catalog.json` in beside the consumer at run time.
    return FIXTURE_ROOTS.some((tree) => isInside(tree, target))
      ? undefined
      : `JSON asset is outside every governed fixture root: ${specifier}`;
  }

  const counterpart = SOURCE_COUNTERPARTS[extension];
  const alternative = counterpart ? target.replace(/\.[cm]?js$/, counterpart) : undefined;
  if (governedSources.has(target) || (alternative && governedSources.has(alternative))) {
    return undefined;
  }
  return `relative source is outside the governed source set: ${specifier}`;
};

/**
 * The built-in pack's identifiers, read from the generated catalog.
 *
 * The catalog is the runtime pack's projection, and `pnpm rules:catalog:check` fails in CI when the
 * two disagree — so reading it here is reading the pack, without this root-level test needing a
 * workspace dependency or a path into `dist`.
 */
const catalog = JSON.parse(read("docs/generated/rule-catalog.json")) as {
  pack: { id: string };
  rules: readonly {
    identity: { id: string; category: string; tags?: readonly string[] };
    execution: { appliesTo?: readonly string[] };
  }[];
};

/**
 * Identifier segments, with camelCase and acronym boundaries treated as separators.
 *
 * Rule ids, categories, and page contexts are slugs, but `tags` is an arbitrary string — so
 * `domainReputation`, `safeBrowsing`, and `TLSCheck` are the realistic evasion. Lowercasing before
 * splitting turned each into one unsplittable segment, and every reserved term missed it.
 */
const segments = (value: string) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Contiguous-segment matching. `tls-check` uses `tls` and `hidden-cost` does not, but a term may
 * itself be several segments: the first version of this test split on every separator and compared
 * single segments, so `ip-address` and `safe-browsing` — both listed in the ADR — could never have
 * matched anything. Two of the contract's own reserved terms were decorative.
 */
const usesTerm = (identifier: string, term: string) => {
  const haystack = segments(identifier);
  const needle = segments(term);
  return haystack.some((_, start) =>
    needle.every((segment, offset) => haystack[start + offset] === segment),
  );
};

describe("built-in pack carries no site or security signal", () => {
  it("reads the built-in pack, and finds rules in it", () => {
    // Without this, every assertion below passes over an empty list or the wrong pack.
    expect(catalog.pack.id).toBe("@fairux/builtin");
    expect(catalog.rules.length).toBeGreaterThan(0);
    expect(RESERVED_TERMS).toContain("tls");
    expect(RESERVED_TERMS).toContain("reputation");
    // Multi-segment terms are the ones a naive matcher silently drops.
    expect(RESERVED_TERMS).toContain("ip-address");
    expect(RESERVED_TERMS).toContain("safe-browsing");
    // A duplicate would inflate the list without adding coverage, and hide a typo next to it.
    expect(new Set(RESERVED_TERMS).size).toBe(RESERVED_TERMS.length);
  });

  it.each(catalog.rules.map((rule) => [rule.identity.id, rule] as const))(
    "%s uses no reserved site vocabulary",
    (_id, rule) => {
      // Identifiers only. A rule's prose legitimately discusses checkout, payment, and trust; what
      // it may not do is *classify* by site vocabulary, because classification is what downstream
      // surfaces group, filter, and render by.
      const identifiers = [
        rule.identity.id,
        rule.identity.category,
        ...(rule.identity.tags ?? []),
        ...(rule.execution.appliesTo ?? []),
      ];
      for (const identifier of identifiers) {
        for (const term of RESERVED_TERMS) {
          expect(
            usesTerm(identifier, term),
            `${rule.identity.id}: identifier "${identifier}" uses reserved term "${term}"`,
          ).toBe(false);
        }
      }
    },
  );

  it("rejects a rule that classifies by site vocabulary", () => {
    // The assertion above only ever sees the passing case. These are the shapes it must catch —
    // including the two multi-segment terms a single-segment matcher silently dropped.
    for (const identifier of [
      "security/bad-tls",
      "domain-reputation",
      "phishing",
      "url",
      "ip-address-risk",
      "safe-browsing-check",
      // `security` itself: the ADR describes preventing exactly this category and, for four
      // revisions, omitted the word from its own list.
      "security",
      "purchase-guard/security",
      "site-security",
      // camelCase, the realistic evasion for a free-form tag.
      "domainReputation",
      "safeBrowsing",
      "TLSCheck",
      "certificateStatus",
      "phishingRisk",
    ]) {
      expect(
        RESERVED_TERMS.some((term) => usesTerm(identifier, term)),
        `"${identifier}" must be rejected`,
      ).toBe(true);
    }
    // And the identifiers that merely look adjacent must not be caught. An over-eager matcher gets
    // switched off by the first person it inconveniences.
    for (const identifier of [
      "hidden-cost",
      "consent/bundled-consent",
      "checkout",
      "obstruction",
      "purchase-guard/return-policy",
      "purchase-guard/checkout-form",
    ]) {
      expect(
        RESERVED_TERMS.some((term) => usesTerm(identifier, term)),
        `"${identifier}" must be accepted`,
      ).toBe(false);
    }
  });
});

describe("Purchase Guard reference pack stays inside the contract", () => {
  // Arbitrary third-party packs are outside FairUX governance and this says nothing about them.
  // This fixture is different: it ships under FairUX's name and is what an external author copies,
  // so an example that encoded a site signal as a finding would teach the violation.
  const PACK = "tests/fixtures/sdk-custom-rule-pack/valid/purchase-guard-pack.mjs";

  interface PackRule {
    meta: { id: string; category: string; tags?: string[]; appliesTo?: string[] };
  }
  interface Pack {
    taxonomy?: {
      categories?: { id: string; parentId?: string }[];
      pageContexts?: { id: string }[];
    };
    rules: PackRule[];
  }

  // A filesystem path is not a module specifier on Windows, where `resolve()` returns
  // `C:{backslash}…`. Node resolves an ESM import as a URL, so the path is converted to one.
  const load = async (): Promise<Pack> =>
    (await import(/* @vite-ignore */ pathToFileURL(resolve(root, PACK)).href)).rulePack as Pack;

  it("declares identifiers to check", async () => {
    const pack = await load();
    expect(pack.rules.length).toBeGreaterThan(0);
    expect(pack.taxonomy?.categories?.length).toBeGreaterThan(0);
  });

  it("keeps the reference pack limited to UI signals", async () => {
    const pack = await load();
    const identifiers = [
      ...(pack.taxonomy?.categories ?? []).flatMap((entry) => [entry.id, entry.parentId ?? ""]),
      ...(pack.taxonomy?.pageContexts ?? []).map((entry) => entry.id),
      ...pack.rules.flatMap((rule) => [
        rule.meta.id,
        rule.meta.category,
        ...(rule.meta.tags ?? []),
        ...(rule.meta.appliesTo ?? []),
      ]),
    ].filter(Boolean);

    expect(identifiers.length).toBeGreaterThan(0);
    for (const identifier of identifiers) {
      for (const term of RESERVED_TERMS) {
        expect(
          usesTerm(identifier, term),
          `${PACK}: identifier "${identifier}" uses reserved term "${term}"`,
        ).toBe(false);
      }
    }
  });

  it("would reject a namespaced site signal", () => {
    // A namespace prefix changes who owns an identifier, not which field the signal belongs in.
    for (const identifier of [
      "purchase-guard/domain-reputation",
      "purchase-guard/bad-tls",
      "purchase-guard/phishing-check",
      "purchase-guard/safe-browsing-status",
      "purchase-guard/security",
      // A tag is an arbitrary string, so this is the shape a pack would actually reach for.
      "domainReputation",
      "safeBrowsing",
    ]) {
      expect(
        RESERVED_TERMS.some((term) => usesTerm(identifier, term)),
        `"${identifier}" must be rejected`,
      ).toBe(true);
    }
  });
});

describe("consumer entry-point contract", () => {
  it("publishes exactly the three documented entry points", () => {
    // `./package.json` is a subpath every modern package exposes for tooling; it is not an API.
    expect(SDK_EXPORTS.sort()).toEqual([".", "./dom", "./html", "./package.json"]);
  });

  it("separates the runtime API from the metadata export", () => {
    // The ADR says "three entry points" and the allowlist has four entries. One of them is not an
    // API, and saying so is cheaper than leaving a reader to reconcile the two.
    expect(PUBLIC_RUNTIME_SDK_SPECIFIERS).toEqual([
      "@fairux/sdk",
      "@fairux/sdk/html",
      "@fairux/sdk/dom",
    ]);
    expect(SDK_METADATA_SPECIFIER).toBe("@fairux/sdk/package.json");
    expect(ALLOWED_SDK_SPECIFIERS).toHaveLength(PUBLIC_RUNTIME_SDK_SPECIFIERS.length + 1);
    expect(adr).toContain("metadata-only");
  });

  it("loads the reference pack through a file URL", () => {
    // `resolve()` returns `C:\…` on Windows, which is not a module specifier.
    expect(pathToFileURL(resolve(root, "package.json")).protocol).toBe("file:");
  });

  it("names those three in the SDK README and the root README", () => {
    for (const file of ["packages/sdk/README.md", "README.md"]) {
      const text = read(file);
      for (const entry of ["@fairux/sdk/html", "@fairux/sdk/dom"]) {
        expect(text, `${file} must name ${entry}`).toContain(entry);
      }
    }
  });

  it("derives the forbidden package set from the workspace, not from a literal", () => {
    // The names the hardcoded list missed. Asserted individually rather than as a count, so a new
    // workspace package is governed without editing an expectation.
    for (const name of [
      "@fairux/core",
      "@fairux/rules",
      "@fairux/chrome-extension",
      "fairux",
      "fairux-vscode",
    ]) {
      expect(WORKSPACE_PACKAGES, `${name} must be discovered`).toContain(name);
      expect(FORBIDDEN_PACKAGES, `${name} must be forbidden`).toContain(name);
    }
    expect(WORKSPACE_PACKAGES).toContain("@fairux/sdk");
    expect(FORBIDDEN_PACKAGES).not.toContain("@fairux/sdk");
  });

  it("states in the ADR that every other package is implementation detail", () => {
    for (const pkg of ["@fairux/core", "@fairux/rules", "@fairux/chrome-extension", "fairux"]) {
      expect(adr, `${ADR} must name ${pkg} as internal`).toContain(pkg);
    }
    expect(adr).toContain("packages/*/src");
    expect(adr).toContain("workspace:");
  });

  it.each(consumerSources)("$relative imports only the public entry points", ({ path }) => {
    // Both policies, on every parsed specifier. One policy for scoped and unscoped packages alike;
    // the path policy in the same loop, so a package rule and a path rule cannot drift apart.
    for (const specifier of specifiersOf(path)) {
      expect(
        packageSpecifierViolation(specifier),
        `${path}: package boundary: ${specifier}`,
      ).toBeUndefined();
      expect(
        pathSpecifierViolation(path, specifier),
        `${path}: path boundary: ${specifier}`,
      ).toBeUndefined();
    }
  });

  it.each(consumerSources.filter(({ path }) => isTypeStrippedSource(path)))(
    "$relative applies the path contract to erased type-only literals",
    ({ path }) => {
      // Type stripping erases a type-only import *and its specifier*, so
      // `import type { X } from "../../../packages/core/src/index.ts"` reaches no parser at all.
      // The package half of that hole was already closed by checking raw literals; this is the
      // path half. Deliberately over-broad: a path-shaped data string in a TypeScript fixture is
      // treated as a possible erased specifier rather than told apart from one, because telling
      // them apart is a TypeScript module-specifier lexer.
      const source = readFileSync(path, "utf8");
      for (const literal of quotedStrings(source)) {
        if (!isPathShapedLiteral(literal)) continue;
        expect(
          pathSpecifierViolation(path, literal),
          `${path}: quoted path "${literal}" violates the path boundary`,
        ).toBeUndefined();
      }
    },
  );

  it("rejects an erased type-only path import", () => {
    const from = resolve(root, "tests/fixtures/sdk-typescript-consumer/consumer.ts");
    const erased = [
      "../../../packages/core/src/index.ts",
      "../package-boundary/package-a/src/index.ts",
      "./types",
      "file:///tmp/internal.d.ts",
      "/tmp/internal.d.ts",
      "C:/tmp/internal.d.ts",
    ];
    // Non-vacuity: prove the parser really sees nothing, so the rejection below is the raw rule's
    // doing rather than the parser's. A case the parser caught would prove the wrong thing.
    for (const specifier of erased) {
      const source = `import type { X } from "${specifier}";\nexport {};`;
      expect(staticImportSpecifiers(stripTypeScriptTypes(source, { mode: "strip" }))).toEqual([]);
      expect(quotedStrings(source)).toContain(specifier);
      expect(
        pathSpecifierViolation(from, specifier),
        `"${specifier}" must be rejected`,
      ).toBeDefined();
    }
    for (const specifier of [
      "./custom-pack.js",
      "../sdk-custom-rule-pack/valid/purchase-guard-pack.mjs",
    ]) {
      expect(
        pathSpecifierViolation(from, specifier),
        `"${specifier}" must be accepted`,
      ).toBeUndefined();
    }
    // A bare package name is not this rule's business.
    expect(pathSpecifierViolation(from, "@fairux/sdk")).toBeUndefined();
  });

  it("applies one specifier policy to scoped and unscoped packages", () => {
    for (const specifier of [
      "@fairux/core",
      "@fairux/sdk.internal",
      "@fairux/sdk/internal",
      "fairux",
      "fairux/cli",
      "fairux-vscode",
    ]) {
      expect(packageSpecifierViolation(specifier), `"${specifier}" must be rejected`).toBeDefined();
    }
    for (const specifier of [
      "@fairux/sdk",
      "@fairux/sdk/html",
      "@fairux/sdk/dom",
      "vitest",
      "./custom-pack.js",
    ]) {
      expect(
        packageSpecifierViolation(specifier),
        `"${specifier}" must be accepted`,
      ).toBeUndefined();
    }
  });

  it("confines a relative import to the fixture tree", () => {
    // The rule above only ever sees compliant fixtures. This is the escape it must reject, from a
    // fixture's real directory rather than a hypothetical one.
    const from = resolve(root, "tests/fixtures/sdk-node-consumer");
    expect(insideFixtureTree(resolve(from, "../sdk-custom-rule-pack/valid/minimal-pack.mjs"))).toBe(
      true,
    );
    expect(insideFixtureTree(resolve(from, "../../../packages/core/src/index.ts"))).toBe(false);
    expect(insideFixtureTree(resolve(from, "../../../packages/sdk/src/index.ts"))).toBe(false);
    expect(insideFixtureTree(resolve(from, "../../../apps/cli/src/index.ts"))).toBe(false);
  });

  it.each(consumerSources)("$relative names no other @fairux package, in any form", ({ path }) => {
    // Deliberately over-broad, and the only rule that catches what type stripping erases: an
    // `import type … from "@fairux/chrome-extension"` leaves no static specifier behind. Written
    // against the *shape* `@fairux/…` rather than a list of names, so a package that does not exist
    // yet is refused too. Comments and strings are included: a consumer example has no reason to
    // mention an internal package at all.
    const text = readFileSync(path, "utf8");
    for (const reference of fairuxReferences(text)) {
      expect(
        ALLOWED_SDK_SPECIFIERS,
        `${path}: "${reference}" is not a public entry point`,
      ).toContain(reference);
    }
  });

  it.each(consumerSources)("$relative quotes no forbidden package specifier", ({ path }) => {
    // The same exact-match policy the parser gets, applied to whole quoted literals. This is what
    // covers a type-only import, which stripping erases: the literal survives in the source even
    // when no specifier reaches the parser. Matching the `@fairux/…` shape instead let
    // `"@fairux/sdk/html?internal"` stop at an allowed entry point, and checking only unscoped names
    // here left the scoped half to a matcher that truncates.
    const text = readFileSync(path, "utf8");
    for (const literal of quotedStrings(text)) {
      expect(
        packageSpecifierViolation(literal),
        `${path}: quoted literal "${literal}" violates the package boundary`,
      ).toBeUndefined();
    }
  });

  it("rejects a suffix appended to an allowed entry point", () => {
    // Each of these truncated to `@fairux/sdk/html` under a shape match and read as permitted.
    for (const literal of [
      "@fairux/sdk/html?internal",
      "@fairux/sdk/html#internal",
      "@fairux/sdk/html+internal",
      "@fairux/sdk/package.json?internal",
      "@fairux/sdk.internal",
    ]) {
      expect(packageSpecifierViolation(literal), `"${literal}" must be rejected`).toBeDefined();
    }
    for (const literal of ["@fairux/sdk", "@fairux/sdk/html", "@fairux/sdk/dom"]) {
      expect(packageSpecifierViolation(literal), `"${literal}" must be accepted`).toBeUndefined();
    }
  });

  it.each(consumerSources)("$relative loads no module dynamically", ({ path }) => {
    // `staticImportSpecifiers` returns static requests only, by design. Rather than widen it, the
    // fixtures are held to static imports so the specifier list is the whole story. Whitespace is
    // not the only thing allowed between two tokens — `import /* c */ ("x")` is the same call —
    // so comments are consumed too.
    const text = readFileSync(path, "utf8");
    expect(text, `${path} must not use dynamic import()`).not.toMatch(DYNAMIC_IMPORT);
    expect(text, `${path} must not use require()`).not.toMatch(REQUIRE_CALL);
  });

  it("sees a dynamic load through an interleaved comment", () => {
    // A line comment ends at any ECMAScript LineTerminator: LF, CR, CRLF, U+2028, and U+2029. The
    // previous pattern knew two of the four, so a lone CR or a line separator left the comment
    // unterminated and the call undetected.
    const terminators = ["\n", "\r", "\r\n", "\u2028", "\u2029"];
    expect(terminators.some((value) => value === "\u2028")).toBe(true);
    for (const terminator of terminators) {
      for (const keyword of ["import", "require"]) {
        const source = `${keyword} // comment${terminator}("some-package");`;
        // Non-vacuity: the case must really contain the code point it is named for.
        expect(source).toContain(terminator);
        expect(
          DYNAMIC_IMPORT.test(source) || REQUIRE_CALL.test(source),
          `${keyword} across ${JSON.stringify(terminator)} must be detected`,
        ).toBe(true);
      }
    }
    for (const source of [
      'import("some-package");',
      'import /* comment */ ("some-package");',
      'require("some-package");',
      'require /* comment */ ("some-package");',
    ]) {
      expect(
        DYNAMIC_IMPORT.test(source) || REQUIRE_CALL.test(source),
        `${JSON.stringify(source)} must be detected`,
      ).toBe(true);
    }
    for (const source of [
      'import value from "./value.js";',
      "const requiredValue = 1;",
      "const important = 2;",
    ]) {
      expect(
        DYNAMIC_IMPORT.test(source) || REQUIRE_CALL.test(source),
        `${JSON.stringify(source)} must not be detected`,
      ).toBe(false);
    }
  });

  it.each(consumerSources)("$relative uses no escaped quoted literal", ({ path }) => {
    // `"@fairux\\u002fcore"` and `"fai\\u0072ux"` are the same specifiers as their plain spellings,
    // and a type-only import is erased before any parser sees the decoded form. Decoding here would
    // mean implementing a string-literal grammar; the construct is refused instead.
    const found = escapedQuotedLiterals(readFileSync(path, "utf8"));
    expect(found, `${path} uses an escaped quoted literal`).toEqual([]);
  });

  it("rejects an escaped specifier in any spelling", () => {
    const sources = [
      String.raw`import type { X } from "@fairux\/core";`,
      String.raw`import type { X } from "@fairux\u002fcore";`,
      String.raw`import type { X } from "\u0040fairux/core";`,
      String.raw`import "fai\u0072ux";`,
      String.raw`import "fai\x72ux-vscode";`,
      // A line continuation splits a specifier across two lines. TypeScript stripping erases the
      // import, and every earlier matcher stopped at the newline and found no literal at all.
      'import type { X } from "@fairux/\\\ncore";',
      'import type { X } from "@fairux/\\\r\ncore";',
    ];
    for (const source of sources) {
      // Non-vacuity guard. These cases are written with `String.raw` and escaped literals, and a
      // spelling that lost its backslash in an edit would still satisfy the rejection assertion
      // below by never being an escape at all — a passing test over an input that proves nothing.
      expect(source, `${JSON.stringify(source)} must actually contain an escape`).toContain("\\");
      expect(escapedQuotedLiterals(source), `${source} must be rejected`).not.toEqual([]);
    }
    // The two continuation cases must really span two lines, for the same reason.
    expect(
      sources.filter((source) => source.includes("\\\n") || source.includes("\\\r\n")),
    ).toHaveLength(2);
    for (const source of [
      'import type { RulePack } from "@fairux/sdk";',
      'import { scanHtml } from "@fairux/sdk/html";',
    ]) {
      expect(escapedQuotedLiterals(source), `${source} must be accepted`).toEqual([]);
    }
  });

  it("catches the partial match that read as an allowed entry point", () => {
    // `@fairux/sdk.internal` matched only as far as `@fairux/sdk`, which is on the allowlist.
    for (const source of [
      'import type { X } from "@fairux/sdk.internal";',
      'import type { X } from "@fairux/sdk_internal";',
      'import type { X } from "@fairux/sdk~internal";',
    ]) {
      const references = fairuxReferences(source);
      expect(references.length, `${source} must yield a reference`).toBeGreaterThan(0);
      expect(
        references.every((reference) => ALLOWED_SDK_SPECIFIERS.includes(reference)),
        `${source} must not read as a permitted entry point`,
      ).toBe(false);
    }
    expect(fairuxReferences('import { x } from "@fairux/sdk/html";')).toEqual(["@fairux/sdk/html"]);
  });

  it("finds fixture sources to check at all", () => {
    // The trees are discovered, not listed, so this is what stops a rename from emptying the suite.
    expect(consumerSources.length).toBeGreaterThanOrEqual(5);
    expect(consumerSources.some((source) => source.relative.endsWith(".ts"))).toBe(true);
    expect(consumerSources.some((source) => source.relative.endsWith(".mjs"))).toBe(true);
  });

  it("governs every fixture tree except a declared exclusion", () => {
    const discovered = FIXTURE_TOP_LEVEL_ENTRIES.filter((entry) => entry.isDirectory()).map(
      (entry) => entry.name,
    );
    for (const name of discovered) {
      const governed = FIXTURE_ROOTS.some((path) => path.endsWith(`${sep}${name}`));
      expect(
        governed || EXCLUDED_FIXTURE_ROOTS.has(name),
        `tests/fixtures/${name} is neither governed nor excluded with a reason`,
      ).toBe(true);
    }
    // A stale exclusion is a silent hole: the directory it names is gone, and the next tree added
    // under that name inherits the exemption.
    for (const [name, reason] of EXCLUDED_FIXTURE_ROOTS) {
      expect(discovered, `the exclusion for ${name} is stale`).toContain(name);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it("governs the invalid packs a consumer imports", () => {
    // These three were outside the previous four-root list while `governance-consumer.mjs` imported
    // them. A governed file reaching into an ungoverned tree is a hole with one hop in it.
    for (const relativePath of [
      "tests/fixtures/sdk-custom-rule-pack/invalid/governance-empty-required.mjs",
      "tests/fixtures/sdk-custom-rule-pack/invalid/governance-invalid-deprecation.mjs",
      "tests/fixtures/sdk-custom-rule-pack/invalid/governance-invalid-source.mjs",
    ]) {
      expect(
        consumerSources.map((source) => source.relative),
        `${relativePath} must be governed`,
      ).toContain(relativePath);
    }
  });

  it("requires an explicit extension on a relative specifier", () => {
    for (const specifier of [
      "./custom-pack",
      "../package-boundary/package-b/src/index",
      "../package-boundary/package-b/src",
    ]) {
      expect(
        RELATIVE_EXTENSIONS.includes(extname(specifier)),
        `"${specifier}" must be rejected`,
      ).toBe(false);
    }
    for (const specifier of ["./custom-pack.js", "./pack.mjs", "./rule-catalog.json"]) {
      expect(
        RELATIVE_EXTENSIONS.includes(extname(specifier)),
        `"${specifier}" must be accepted`,
      ).toBe(true);
    }
  });

  it("uses no fixture syntax this contract cannot parse", () => {
    // Node's type stripping does not handle JSX. Skipping such a file would report it as clean.
    const unsupported = fixtureFiles.filter((path) =>
      UNSUPPORTED_EXTENSIONS.includes(extname(path)),
    );
    expect(unsupported, "JSX fixtures are not supported by this contract").toEqual([]);
  });

  it("contains no symlink that could leave the fixture tree", () => {
    // A lexically-inside path whose real target is outside would satisfy the confinement rule.
    const links = fixtureFiles.filter((path) => lstatSync(path).isSymbolicLink());
    expect(links, "symlinks are not permitted in the fixture tree").toEqual([]);
  });

  it("rejects a top-level symlink before roots are discovered", () => {
    // A symlink to a directory is not `isDirectory()`, so `tests/fixtures/x -> ../../packages/core`
    // fell out of the roots, out of `fixtureFiles`, and out of the check above, which only looks
    // inside trees already found. It has to be caught from the same top-level read.
    expect(TOP_LEVEL_SYMLINKS, "top-level fixture symlinks are not permitted").toEqual([]);
    // The discovery this depends on is the same list the governance check uses, not a second read.
    expect(FIXTURE_TOP_LEVEL_ENTRIES.length).toBeGreaterThan(0);
    expect(
      FIXTURE_TOP_LEVEL_ENTRIES.filter((entry) => entry.isDirectory()).length,
    ).toBeGreaterThanOrEqual(FIXTURE_ROOTS.length);
  });

  it("answers containment the same way on either separator", () => {
    // The previous rule compared against the base plus a forward slash, which is false for every
    // legitimate path on Windows. These assert the shape of the answer, not this platform's.
    expect(isInside("/repo/tests/fixtures", "/repo/tests/fixtures/a/b.mjs")).toBe(true);
    expect(isInside("/repo/tests/fixtures", "/repo/tests/fixtures")).toBe(true);
    expect(isInside("/repo/tests/fixtures", "/repo/packages/core/src/index.ts")).toBe(false);
    // A prefix match on the string would call this inside; `relative()` does not.
    expect(isInside("/repo/tests/fixtures", "/repo/tests/fixtures-other/a.mjs")).toBe(false);
  });

  it("rejects a file URL scheme in any ASCII case", () => {
    const from = resolve(root, "tests/fixtures/sdk-node-consumer/consumer.mjs");
    for (const specifier of [
      "file:///tmp/internal.mjs",
      "FILE:///tmp/internal.mjs",
      "File:///tmp/internal.mjs",
      "FiLe:///tmp/internal.mjs",
    ]) {
      // Non-vacuity: the parser must really return the variant spelling, so the rejection is the
      // predicate's doing and not a normalisation that happened upstream.
      const parsed = staticImportSpecifiers(`import "${specifier}";`);
      expect(parsed).toEqual([specifier]);
      expect(
        pathSpecifierViolation(from, parsed[0] as string),
        `"${specifier}" must be rejected`,
      ).toBeDefined();
    }
  });

  it("rejects an erased type-only file URL in any ASCII case", () => {
    // This is the path the R6 raw-literal rule owns: stripping erases the import, so the parsed
    // check never sees it and only `isPathShapedLiteral` can.
    const from = resolve(root, "tests/fixtures/sdk-typescript-consumer/consumer.ts");
    for (const specifier of [
      "FILE:///tmp/internal.d.ts",
      "File:///tmp/internal.d.ts",
      "FiLe:///tmp/internal.d.ts",
    ]) {
      const source = `import type { X } from "${specifier}";\nexport {};`;
      expect(staticImportSpecifiers(stripTypeScriptTypes(source, { mode: "strip" }))).toEqual([]);
      expect(quotedStrings(source)).toContain(specifier);
      expect(isPathShapedLiteral(specifier), `"${specifier}" must look path-shaped`).toBe(true);
      expect(
        pathSpecifierViolation(from, specifier),
        `"${specifier}" must be rejected`,
      ).toBeDefined();
    }
  });

  it("rejects an absolute specifier in any notation", () => {
    for (const specifier of [
      "/absolute/path.mjs",
      "C:\\absolute\\path.mjs",
      "C:/absolute/path.mjs",
      "file:///tmp/example.mjs",
    ]) {
      expect(isAbsoluteSpecifier(specifier), `"${specifier}" must be rejected`).toBe(true);
    }
    for (const specifier of ["@fairux/sdk", "./custom-pack.js"]) {
      expect(isAbsoluteSpecifier(specifier), `"${specifier}" must not be caught`).toBe(false);
    }
  });

  it("rejects every shape the previous substring check let through", () => {
    // Each of these passed `not.toContain('"@fairux/core')`: a single quote, an `export … from`,
    // and a relative path that names no package at all.
    const evasions = [
      "import '@fairux/core';",
      'import "@fairux/core/private";',
      "export { something } from '@fairux/rules';",
      'import "../../../packages/core/src/index.ts";',
    ];
    for (const source of evasions) {
      const specifiers = staticImportSpecifiers(source);
      const offending = specifiers.filter(
        (specifier) =>
          (specifier.startsWith("@fairux/") && !ALLOWED_SDK_SPECIFIERS.includes(specifier)) ||
          specifier.includes("packages/"),
      );
      expect(offending, `"${source}" must be rejected`).not.toEqual([]);
    }
  });

  it("accepts the public entry points and a sibling module", () => {
    const specifiers = staticImportSpecifiers(
      [
        'import { composeRulePacks } from "@fairux/sdk";',
        'import { scanHtml } from "@fairux/sdk/html";',
        'import { createDomScanner } from "@fairux/sdk/dom";',
        'import customPack from "./custom-pack.js";',
      ].join("\n"),
    );
    const offending = specifiers.filter(
      (specifier) =>
        specifier.startsWith("@fairux/") && !ALLOWED_SDK_SPECIFIERS.includes(specifier),
    );
    expect(offending).toEqual([]);
  });
});

describe("consumer manifest contract", () => {
  /**
   * Local-source protocols. Each resolves to something other than a published registry package, so
   * each defeats the point of a consumer fixture. `npm:` is here because an alias hides its target
   * behind an arbitrary key — `"alias": "npm:@fairux/core@0.1.0"` passes any name-based rule — and
   * a fixture has no reason to alias at all.
   */
  const LOCAL_PROTOCOLS = [
    "workspace:",
    // `catalog:` and `catalog:<name>` read the range from the workspace's own pnpm-workspace.yaml,
    // which is exactly the workspace dependency an external consumer fixture must not have.
    "catalog:",
    "file:",
    "link:",
    "portal:",
    "patch:",
    "npm:",
    "git+file:",
  ];

  /** A range that names a path in this working tree rather than a published version. */
  const isLocalPathRange = (range: string) =>
    /^\.{1,2}[\\/]/.test(range) ||
    /^~[\\/]/.test(range) ||
    posix.isAbsolute(range) ||
    win32.isAbsolute(range);

  /**
   * Fields that can substitute a different package for the one a dependency names.
   *
   * A clean `"@fairux/sdk": "0.1.0-beta.2"` beside an override to `link:../../../packages/sdk`
   * installs the workspace copy, and the range alone reads as compliant. Each of these has its own
   * semantics across npm, pnpm, and Yarn; a governed fixture refuses them rather than interpreting
   * three resolvers, which is the same mistake as re-implementing three module resolution
   * algorithms. A consumer example needs none of them.
   */
  const RESOLUTION_CONTROL_FIELDS = [
    "imports",
    "overrides",
    "resolutions",
    "packageExtensions",
  ] as const;
  const PNPM_CONTROL_FIELDS = ["overrides", "patchedDependencies", "packageExtensions"] as const;

  const offendingDependencies = (manifest: Record<string, unknown>) => {
    const found: string[] = [];
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const entries = (manifest[field] ?? {}) as Record<string, string>;
      for (const [name, range] of Object.entries(entries)) {
        // The key: any workspace package other than the SDK, at its root or a subpath.
        if (namesForbiddenPackage(name)) found.push(name);
        // The value's protocol.
        const normalized = range.trim().toLowerCase();
        const protocol = LOCAL_PROTOCOLS.find((prefix) => normalized.startsWith(prefix));
        if (protocol) found.push(`${name}@${range}`);
        // A path in place of a version — relative, home-relative, or absolute, either notation.
        else if (isLocalPathRange(range)) found.push(`${name}@${range}`);
      }
    }
    for (const field of RESOLUTION_CONTROL_FIELDS) {
      if (manifest[field] !== undefined) found.push(`${field} is a resolution control`);
    }
    const pnpm = manifest.pnpm as Record<string, unknown> | undefined;
    for (const field of PNPM_CONTROL_FIELDS) {
      if (pnpm?.[field] !== undefined) found.push(`pnpm.${field} is a resolution control`);
    }
    return found;
  };

  it.each(fixtureManifests.length > 0 ? fixtureManifests : [{ path: "", relative: "(none)" }])(
    "$relative declares no internal or local dependency",
    ({ path }) => {
      if (!path) return;
      expect(
        offendingDependencies(JSON.parse(readFileSync(path, "utf8"))),
        `${path} declares a forbidden dependency`,
      ).toEqual([]);
    },
  );

  it.each([
    ["the workspace protocol", { dependencies: { "@fairux/sdk": "workspace:*" } }],
    ["the file protocol", { dependencies: { "@fairux/sdk": "file:../../../packages/sdk" } }],
    ["the link protocol", { dependencies: { "@fairux/sdk": "link:../../../packages/sdk" } }],
    ["the portal protocol", { dependencies: { "@fairux/sdk": "portal:../../../packages/sdk" } }],
    [
      "the patch protocol",
      { dependencies: { "@fairux/sdk": "patch:@fairux/sdk@0.1.0#./p.patch" } },
    ],
    ["an npm alias to an internal package", { dependencies: { alias: "npm:@fairux/core@0.1.0" } }],
    [
      "an npm alias behind the SDK's own key",
      { dependencies: { "@fairux/sdk": "npm:@fairux/core@0.1.0" } },
    ],
    ["an internal package by name", { devDependencies: { "@fairux/rules": "^0.1.0" } }],
    ["the unscoped CLI", { dependencies: { fairux: "0.1.0" } }],
    ["the VS Code extension", { dependencies: { "fairux-vscode": "0.1.0" } }],
    ["a workspace catalog", { dependencies: { "@fairux/sdk": "catalog:" } }],
    ["a named workspace catalog", { dependencies: { "@fairux/sdk": "catalog:beta" } }],
    [
      "a package import map",
      { dependencies: { "@fairux/sdk": "0.1.0-beta.2" }, imports: { "#fairux": "@fairux/core" } },
    ],
    [
      "an npm override to a local SDK",
      {
        dependencies: { "@fairux/sdk": "0.1.0-beta.2" },
        overrides: { "@fairux/sdk": "file:../../../packages/sdk" },
      },
    ],
    [
      "a Yarn resolution to a local SDK",
      {
        dependencies: { "@fairux/sdk": "0.1.0-beta.2" },
        resolutions: { "@fairux/sdk": "link:../../../packages/sdk" },
      },
    ],
    [
      "a pnpm override to a local SDK",
      {
        dependencies: { "@fairux/sdk": "0.1.0-beta.2" },
        pnpm: { overrides: { "@fairux/sdk": "link:../../../packages/sdk" } },
      },
    ],
    [
      "a patched dependency",
      {
        dependencies: { "@fairux/sdk": "0.1.0-beta.2" },
        pnpm: { patchedDependencies: { "@fairux/sdk@0.1.0-beta.2": "./sdk.patch" } },
      },
    ],
    [
      "a package extension",
      {
        dependencies: { "@fairux/sdk": "0.1.0-beta.2" },
        packageExtensions: { "@fairux/sdk@*": { dependencies: { "@fairux/core": "*" } } },
      },
    ],
    ["a git+file source", { dependencies: { "@fairux/sdk": "git+file:../../../packages/sdk" } }],
    [
      "a home-relative POSIX path",
      { dependencies: { "@fairux/sdk": "~/Development/fairux-linter/packages/sdk" } },
    ],
    [
      "a home-relative Windows path",
      { dependencies: { "@fairux/sdk": "~\\Development\\fairux-linter\\packages\\sdk" } },
    ],
    ["a relative path as a range", { dependencies: { something: "../../../packages/sdk" } }],
    ["a POSIX absolute path as a range", { dependencies: { something: "/opt/pkg" } }],
    ["a Windows absolute path as a range", { dependencies: { something: "C:\\pkg" } }],
  ] as [string, Record<string, unknown>][])("rejects %s", (_label, manifest) => {
    // There are no fixture manifests today, so without these the checker would stay unverified
    // until the first one appeared — the worst possible moment to discover it was wrong.
    expect(offendingDependencies(manifest)).not.toEqual([]);
  });

  it.each([
    ["the published SDK", { dependencies: { "@fairux/sdk": "^0.1.0-beta.2" } }],
    ["an exact SDK version", { dependencies: { "@fairux/sdk": "0.1.0-beta.2" } }],
    ["an unrelated registry package", { dependencies: { vitest: "^4.1.10" } }],
    ["no dependencies at all", {}],
  ] as [string, Record<string, unknown>][])("accepts %s", (_label, manifest) => {
    expect(offendingDependencies(manifest)).toEqual([]);
  });
});

describe("site signals stay beside the report", () => {
  it("carries a typed example that composes rather than merges", () => {
    // The example is the part a reader copies, so it is pinned as structure rather than as prose:
    // two named fields, the FairUX one typed by the SDK's own export.
    expect(adr).toContain('import type { FairUxReport } from "@fairux/sdk"');
    expect(adr).toMatch(/interface\s+PurchaseGuardReport\s*\{/);
    expect(adr).toMatch(/readonly fairux:\s*FairUxReport;/);
    expect(adr).toMatch(/readonly siteSignals:\s*SiteSignals;/);
  });

  it("keeps the site vocabulary out of the FairUX half of that example", () => {
    // `SiteSignals` is where `url`, `tls`, `redirectChain`, and `domainReputation` belong; the
    // example would contradict the contract if they appeared on the FairUX side.
    const siteSignals = adr.slice(adr.indexOf("interface SiteSignals"));
    expect(siteSignals).toContain("readonly url: string;");
    expect(siteSignals).toContain("tlsValid");
    expect(siteSignals).toContain("redirectChain");
    expect(siteSignals).toContain("domainReputation");
  });

  it("says the report is not written into by the application", () => {
    expect(adr).toContain("the application does not write into it");
  });
});

describe("FairUX returns no verdict", () => {
  it("refuses fraud, legal, and safety verdicts in the ADR and in the public documents", () => {
    expect(adr).toContain("It is not a determination that a page is");
    // The same refusal has to survive in what a user actually reads, not only in the design record.
    expect(read("docs/status.md")).toContain(
      "legal verdicts, fraud verdicts, site safety verdicts",
    );
  });

  it("refuses to read zero findings as a clean result", () => {
    expect(adr).toContain("Zero findings is not a clean bill of health");
    expect(adr).toContain("absence of a signal is not\nevidence of absence");
  });

  it("keeps Purchase Guard a product rather than a mode", () => {
    expect(adr).toContain("There is no FairUX flag, option, preset, or entry point");
    for (const file of ["README.md", "packages/sdk/README.md", "docs/status.md"]) {
      expect(read(file), `${file} must keep Purchase Guard separate`).toContain("Purchase Guard");
    }
  });
});

describe("contract scope", () => {
  it("states what it does not cover", () => {
    // A contract that reads as broader than it is becomes the reason nobody writes the next one.
    expect(adr).toContain("That is P18-T2");
    expect(adr).toContain("*implements* a network check");
    // The validation section must name the artifact the test actually reads, not the one it would
    // be tidier to claim.
    expect(adr).toContain("docs/generated/rule-catalog.json");
    expect(adr).toContain("of the runtime pack, not the pack itself");
    // The corrections this contract's own earlier versions needed, kept on the record so the next
    // reader knows the matcher, the parser, and the discovery are load-bearing, not incidental.
    expect(adr).toContain("could never have\nmatched either");
    expect(adr).toContain("parser, not a substring search");
    expect(adr).toContain("arbitrary third-party");
    // The parser's limits, each of which has its own rule rather than a footnote.
    expect(adr).toContain("erases type-only imports");
    expect(adr).toContain("does not handle **JSX**");
    expect(adr).toContain("parse failure throws");
    expect(adr).toContain("Fixture trees are discovered, not listed");
    expect(adr).toContain("derived from the workspace manifests");
    // The conservative rules that close what the parser cannot see.
    expect(adr).toContain("Escaped quoted literals are prohibited");
    expect(adr).toContain("must name an explicit supported extension");
    expect(adr).toContain("a comment is whitespace");
    expect(adr).toContain("top-level symlink is rejected from the same read");
    // R4: the exact-match policy, the vocabulary correction, and the local-source boundary.
    expect(adr).toContain("share one exact-match policy");
    expect(adr).toContain("the broader `@fairux/…` textual matcher, supplementary");
    expect(adr).toContain("camelCase and acronym boundaries are segments");
    expect(adr).toContain("omitted the word");
    expect(adr).toContain("`git+file:` and a `~/` home-relative");
    expect(RESERVED_TERMS).toContain("security");
    // R5: resolver controls refused rather than interpreted, and the direct-syntax limit stated.
    expect(adr).toContain("refused outright in a governed fixture manifest");
    expect(adr).toContain("direct syntax");
    expect(adr).toContain("no data-flow analysis");
    // The path half of the erased-type-only hole, and the cost this contract chose not to pay.
    expect(adr).toContain("path-shaped** raw quoted literal in a type-stripped source");
    expect(adr).toContain("*and its specifier*");
    expect(adr).toContain("path-shaped *data* string");
    // The descriptions R4 superseded must not linger beside their replacements.
    expect(adr).not.toContain("every quoted literal, against the unscoped workspace names");
    expect(adr).not.toContain(
      "every quoted literal is checked against the workspace package names",
    );
  });
});

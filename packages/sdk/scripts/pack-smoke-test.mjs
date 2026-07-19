#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdkDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(sdkDir, "..", "..");
const fixturesDir = resolve(repoRoot, "tests", "fixtures");
const work = mkdtempSync(join(tmpdir(), "fairux-sdk-pack-"));
const TIMEOUT = 120_000;
// Current SDK tarball is roughly 1 MB unpacked and well below 500 KB packed. These caps leave
// room for source-map churn while still catching accidental source/test/dependency payloads.
const MAX_PACKED_SIZE_BYTES = 512 * 1024;
const MAX_UNPACKED_SIZE_BYTES = 1536 * 1024;
const MAX_BROWSER_BUNDLE_BYTES = 180 * 1024;
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => name.replace(/^node:/, "")),
  ...builtinModules.map((name) => `node:${name.replace(/^node:/, "")}`),
]);

let failed = false;
const ok = (message) => console.log(`✓ ${message}`);
const bad = (message) => {
  console.error(`✗ ${message}`);
  failed = true;
};
const assert = (condition, message) => (condition ? ok(message) : bad(message));

function run(cmd, args, options = {}) {
  const { env = {}, ...execOptions } = options;
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TIMEOUT,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, npm_config_cache: join(work, ".npm-cache"), ...env },
      ...execOptions,
    });
  } catch (error) {
    const stdout = String(error.stdout ?? "");
    const stderr = String(error.stderr ?? "");
    throw new Error(
      [
        `${cmd} ${args.join(" ")} failed`,
        stdout ? `stdout:\n${stdout}` : undefined,
        stderr ? `stderr:\n${stderr}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function repoBin(name) {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  const rootBin = resolve(repoRoot, "node_modules", ".bin", `${name}${suffix}`);
  if (existsSync(rootBin)) return rootBin;
  return resolve(sdkDir, "node_modules", ".bin", `${name}${suffix}`);
}

function importSpecifiers(source) {
  const specs = [];
  const re =
    /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(re)) {
    specs.push(match[1] ?? match[2] ?? match[3]);
  }
  return specs;
}

function assertNoNodeBuiltins(source, label) {
  const imports = importSpecifiers(source).filter((specifier) => nodeBuiltins.has(specifier));
  assert(imports.length === 0, `${label} has no Node builtin import`);
}

function parseNpmJson(stdout) {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const starts = [trimmed.indexOf("{"), trimmed.indexOf("[")].filter((index) => index >= 0);
    if (starts.length === 0) throw new Error(`npm did not print JSON: ${trimmed}`);
    const start = Math.min(...starts);
    try {
      return JSON.parse(trimmed.slice(start));
    } catch (error) {
      throw new Error(`Failed to parse npm JSON output: ${error.message}\nraw stdout:\n${stdout}`);
    }
  }
}

function normalizePublishDryRun(payload, fallback) {
  const item = Array.isArray(payload)
    ? (payload.find((entry) => entry?.name === "@fairux/sdk") ?? payload[0])
    : payload;
  const data = item?.data ?? item;
  const files = data?.files ?? item?.files ?? [];
  const id = data?.id ?? item?.id;
  const idMatch = typeof id === "string" ? id.match(/^(@[^/]+\/[^@]+|[^@]+)@(.+)$/) : null;
  const packedSize = data?.size ?? data?.packedSize ?? data?.packageSize ?? item?.size;
  const unpackedSize =
    data?.unpackedSize ??
    data?.unpacked_size ??
    item?.unpackedSize ??
    files.reduce((total, file) => total + (Number(file.size) || 0), 0);
  return {
    name: data?.name ?? item?.name ?? idMatch?.[1] ?? fallback.name,
    version: data?.version ?? item?.version ?? idMatch?.[2] ?? fallback.version,
    filename: data?.filename ?? item?.filename ?? item?.tarball ?? fallback.filename,
    files: files.length > 0 ? files : fallback.files,
    packedSize: packedSize ?? fallback.packedSize,
    unpackedSize: unpackedSize || fallback.unpackedSize,
    access: data?.access ?? item?.access,
  };
}

try {
  for (const name of ["core", "dom", "html", "rules", "sdk"]) {
    rmSync(resolve(repoRoot, "packages", name, "dist"), { recursive: true, force: true });
  }

  run("pnpm", ["pack", "--pack-destination", work], { cwd: sdkDir });
  const tgz = readdirSync(work).find(
    (file) => file.startsWith("fairux-sdk-") && file.endsWith(".tgz"),
  );
  if (!tgz) throw new Error("pnpm pack produced no @fairux/sdk tarball");
  const tarball = join(work, tgz);
  ok(`packed ${tgz}`);
  const tarballSize = statSync(tarball).size;

  const sourceManifest = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8"));
  const manifest = JSON.parse(run("tar", ["-xzOf", tarball, "package/package.json"]));
  assert(manifest.name === "@fairux/sdk", `manifest name is @fairux/sdk (${manifest.name})`);
  assert(manifest.version === sourceManifest.version, "manifest version matches source package");
  assert(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version),
    "manifest version is semver",
  );
  assert(manifest.license === "Apache-2.0", "manifest license is Apache-2.0");
  assert(manifest.author === sourceManifest.author, "manifest author matches source package");
  assert(manifest.homepage === sourceManifest.homepage, "manifest homepage matches source package");
  assert(
    manifest.repository?.type === sourceManifest.repository?.type &&
      manifest.repository?.url === sourceManifest.repository?.url &&
      manifest.repository?.directory === "packages/sdk",
    "manifest repository metadata points at packages/sdk",
  );
  assert(
    manifest.bugs?.url === sourceManifest.bugs?.url,
    "manifest bugs URL matches source package",
  );
  assert(
    JSON.stringify(manifest.keywords ?? []) === JSON.stringify(sourceManifest.keywords ?? []),
    "manifest keywords match source package",
  );
  assert(
    manifest.engines?.node === sourceManifest.engines?.node,
    "manifest Node engine matches source package",
  );
  assert(manifest.private !== true, "manifest is public");
  assert(manifest.publishConfig?.access === "public", "publishConfig.access is public");
  assert(
    Object.keys(manifest.dependencies ?? {}).length === 0,
    "manifest has no runtime dependencies",
  );
  assert(!JSON.stringify(manifest).includes("workspace:"), "manifest has no workspace: specifier");
  assert(
    Boolean(manifest.exports?.["."] && manifest.exports?.["./html"] && manifest.exports?.["./dom"]),
    "manifest exposes root/html/dom entrypoints",
  );
  assert(
    manifest.exports?.["./package.json"] === "./package.json",
    "manifest exposes package.json",
  );
  assert(
    sourceManifest.scripts?.prepublishOnly === "node scripts/prepublish-guard.mjs",
    "source manifest keeps the prepublish guard",
  );

  const entries = run("tar", ["-tzf", tarball])
    .split("\n")
    .filter(Boolean)
    .map((entry) => entry.replace(/^package\//, ""));
  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/html.js",
    "dist/html.d.ts",
    "dist/dom.js",
    "dist/dom.d.ts",
    "README.md",
    "LICENSE",
    "NOTICE",
    "package.json",
  ]) {
    assert(entries.includes(required), `tarball contains ${required}`);
  }
  const unexpected = entries.filter(
    (entry) => !/^(package\.json|README\.md|LICENSE|NOTICE|dist\/.*)$/.test(entry),
  );
  assert(
    unexpected.length === 0,
    `tarball contains only allowed paths (${unexpected.join(",") || "none"})`,
  );
  const readme = run("tar", ["-xzOf", tarball, "package/README.md"]);
  assert(
    readme.includes(manifest.engines.node),
    `README declares exact Node support range ${manifest.engines.node}`,
  );

  const jsAndTypes = entries
    .filter((entry) => /^dist\/.*\.(js|d\.ts)$/.test(entry))
    .map((entry) => run("tar", ["-xzOf", tarball, `package/${entry}`]))
    .join("\n");
  assert(!/from ["']@fairux\//.test(jsAndTypes), "dist JS/types have no private @fairux imports");
  assertNoNodeBuiltins(run("tar", ["-xzOf", tarball, "package/dist/index.js"]), "root entrypoint");
  assertNoNodeBuiltins(run("tar", ["-xzOf", tarball, "package/dist/dom.js"]), "DOM entrypoint");
  assert(
    tarballSize < MAX_PACKED_SIZE_BYTES,
    `packed tarball under ${MAX_PACKED_SIZE_BYTES} bytes (${tarballSize})`,
  );

  run("npm", ["init", "-y"], { cwd: work });
  run("npm", ["install", tarball, "--no-audit", "--no-fund"], { cwd: work });
  ok("installed SDK tarball into a clean temp project");

  cpSync(join(fixturesDir, "sdk-custom-rule-pack"), join(work, "sdk-custom-rule-pack"), {
    recursive: true,
  });
  cpSync(join(fixturesDir, "sdk-node-consumer"), join(work, "sdk-node-consumer"), {
    recursive: true,
  });
  cpSync(join(fixturesDir, "sdk-browser-consumer"), join(work, "sdk-browser-consumer"), {
    recursive: true,
  });
  cpSync(join(fixturesDir, "sdk-typescript-consumer"), join(work, "sdk-typescript-consumer"), {
    recursive: true,
  });

  const nodeOut = JSON.parse(
    run("node", [join(work, "sdk-node-consumer", "consumer.mjs")], { cwd: work }),
  );
  assert(
    nodeOut.ok === true && nodeOut.findings >= 2,
    "Node consumer reports built-in and custom findings",
  );
  assert(
    nodeOut.toolVersion === manifest.version,
    "Node consumer report.toolVersion matches installed SDK version",
  );

  const duplicateCheck = `
    import { composeRulePacks, fairuxBuiltinRulePack } from "@fairux/sdk";
    try {
      composeRulePacks([fairuxBuiltinRulePack, fairuxBuiltinRulePack]);
      process.exit(2);
    } catch (error) {
      if (!/Duplicate rule pack id/.test(String(error.message))) process.exit(3);
    }
  `;
  writeFileSync(join(work, "duplicate-check.mjs"), duplicateCheck, "utf8");
  run("node", [join(work, "duplicate-check.mjs")], { cwd: work });
  ok("duplicate pack ID is rejected from installed SDK");

  const exportSmoke = `
    import * as root from "@fairux/sdk";
    import * as html from "@fairux/sdk/html";
    import * as dom from "@fairux/sdk/dom";
    const rootKeys = [
      "FAIRUX_SDK_VERSION",
      "InputTooLargeError",
      "MAX_INPUT_BYTES",
      "MAX_NODE_COUNT",
      "MAX_TREE_DEPTH",
      "RulePackError",
      "ScannerPolicyError",
      "composeRulePacks",
      "createScanner",
      "fairuxBuiltinRulePack"
    ];
    const htmlKeys = ["InputTooLargeError", "MAX_INPUT_BYTES", "MAX_NODE_COUNT", "MAX_TREE_DEPTH", "ScannerPolicyError", "createHtmlScanner", "scanHtml"];
    const domKeys = ["InputTooLargeError", "MAX_INPUT_BYTES", "MAX_NODE_COUNT", "MAX_TREE_DEPTH", "ScannerPolicyError", "createDomScanner", "scanDom"];
    for (const key of rootKeys) if (!(key in root)) throw new Error("missing root export " + key);
    for (const key of htmlKeys) if (!(key in html)) throw new Error("missing html export " + key);
    for (const key of domKeys) if (!(key in dom)) throw new Error("missing dom export " + key);
    if (html.InputTooLargeError !== root.InputTooLargeError) throw new Error("html error export identity mismatch");
    if (dom.InputTooLargeError !== root.InputTooLargeError) throw new Error("dom error export identity mismatch");
    if (html.ScannerPolicyError !== root.ScannerPolicyError) throw new Error("html policy error export identity mismatch");
    if (dom.ScannerPolicyError !== root.ScannerPolicyError) throw new Error("dom policy error export identity mismatch");
  `;
  writeFileSync(join(work, "export-smoke.mjs"), exportSmoke, "utf8");
  run("node", [join(work, "export-smoke.mjs")], { cwd: work });
  ok("runtime exports are available from root/html/dom");

  const policySmoke = `
    import {
      RulePackError,
      ScannerPolicyError,
      composeRulePacks,
      createScanner,
      fairuxBuiltinRulePack
    } from "@fairux/sdk";
    import { createHtmlScanner, scanHtml } from "@fairux/sdk/html";

    const html = "<label><input type='checkbox' checked> Send marketing</label>";
    const expectScannerPolicyError = (fn) => {
      try {
        fn();
      } catch (error) {
        if (!(error instanceof ScannerPolicyError)) throw error;
        return;
      }
      throw new Error("expected ScannerPolicyError");
    };

    const disabled = createHtmlScanner({
      ruleOverrides: { "consent/checked-checkbox": false },
      severityOverrides: { "consent/checked-checkbox": "low" }
    }).scan(html);
    if (disabled.findings.some((finding) => finding.ruleId === "consent/checked-checkbox")) {
      throw new Error("severityOverrides re-enabled an explicitly disabled rule");
    }

    const experimental = createHtmlScanner({
      ruleOverrides: { "consent/accept-reject-visual-imbalance": true },
      severityOverrides: { "consent/accept-reject-visual-imbalance": "low" },
      rulePacks: [fairuxBuiltinRulePack]
    }).scan("<main><p>Cookies</p><button class='btn-primary'>Accept</button><a href='#' class='link'>Reject</a></main>");
    const finding = experimental.findings.find((entry) => entry.ruleId === "consent/accept-reject-visual-imbalance");
    if (!finding) throw new Error("severityOverrides removed experimental force-enable");
    if (finding.severity !== "low") throw new Error("severityOverrides did not supply final severity");

    try {
      createHtmlScanner({ severityOverrides: { "consent/checked-checkbox": "critical" } });
      throw new Error("invalid severity was accepted");
    } catch (error) {
      if (!(error instanceof ScannerPolicyError)) throw error;
    }

    try {
      createHtmlScanner({ ruleOverrides: { "consent/checked-chekbox": false } });
      throw new Error("unknown rule ID was accepted");
    } catch (error) {
      if (!(error instanceof ScannerPolicyError)) throw error;
    }

    const experimentalPack = {
      meta: {
        id: "smoke/experimental-pack",
        version: "1.0.0",
        engineApiVersion: "1",
        title: "Smoke experimental pack",
        status: "experimental"
      },
      rules: [
        {
          meta: {
            id: "smoke/experimental-rule",
            title: "Smoke experimental rule",
            category: "obstruction",
            defaultSeverity: "low",
            defaultConfidence: "low",
            defaultEnabled: true,
            tags: [],
            version: "1.0.0"
          },
          evaluate() {
            return [];
          }
        }
      ]
    };
    try {
      composeRulePacks([experimentalPack], { includeExperimental: "false" });
      throw new Error("invalid compose options were accepted");
    } catch (error) {
      if (!(error instanceof RulePackError)) throw error;
    }

    for (const invalid of [
      {
        rulePacks: [fairuxBuiltinRulePack],
        includeExperimantal: true
      },
      {
        rulePacks: [fairuxBuiltinRulePack],
        toolVersion: null
      }
    ]) {
      expectScannerPolicyError(() => createScanner(invalid));
    }

    expectScannerPolicyError(() => createHtmlScanner(new Date()));
    expectScannerPolicyError(() => createHtmlScanner({ rulePacks: null }));
    const htmlScanner = createHtmlScanner();
    expectScannerPolicyError(() => htmlScanner.scan(html, { filepath: "x.html" }));

    const reservedPack = {
      ...experimentalPack,
      meta: {
        ...experimentalPack.meta,
        id: "smoke/reserved-pack",
        status: "stable"
      },
      rules: [
        {
          ...experimentalPack.rules[0],
          meta: {
            ...experimentalPack.rules[0].meta,
            id: "constructor"
          }
        }
      ]
    };
    try {
      composeRulePacks([reservedPack]);
      throw new Error("reserved rule ID was accepted");
    } catch (error) {
      if (!(error instanceof RulePackError)) throw error;
    }

    const prototypeGroup = Object.create(null);
    Object.defineProperty(prototypeGroup, "constructor", {
      value: [/alpha/],
      enumerable: true,
      configurable: true
    });
    Object.defineProperty(prototypeGroup, "toString", {
      value: [/beta/],
      enumerable: true,
      configurable: true
    });
    Object.defineProperty(prototypeGroup, "__proto__", {
      value: [/gamma/],
      enumerable: true,
      configurable: true
    });
    const prototypePack = {
      meta: {
        id: "smoke/prototype-dictionary-pack",
        version: "1.0.0",
        engineApiVersion: "1",
        title: "Smoke prototype dictionary pack",
        status: "stable"
      },
      dictionary: { en: prototypeGroup },
      rules: [
        {
          meta: {
            id: "smoke/prototype-dictionary-rule",
            title: "Smoke prototype dictionary rule",
            category: "obstruction",
            defaultSeverity: "low",
            defaultConfidence: "low",
            defaultEnabled: true,
            tags: [],
            version: "1.0.0"
          },
          evaluate(doc, ctx) {
            const dictionary = ctx.getDictionary();
            const matched =
              ctx.text.hasAny(doc.root.subtreeText, dictionary["constructor"] ?? []) &&
              ctx.text.hasAny(doc.root.subtreeText, dictionary["toString"] ?? []) &&
              ctx.text.hasAny(doc.root.subtreeText, dictionary["__proto__"] ?? []);
            if (!matched) return [];
            return [
              ctx.createFinding({
                evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
                description: "Prototype-sensitive dictionary groups matched.",
                whyItMatters: "Dictionary keys should not collide with Object.prototype.",
                recommendation: "Keep prototype-safe dictionary maps."
              })
            ];
          }
        }
      ]
    };
    const prototypeReport = scanHtml("<main>alpha beta gamma</main>", {
      rulePacks: [fairuxBuiltinRulePack, prototypePack]
    });
    if (
      !prototypeReport.findings.some(
        (finding) => finding.ruleId === "smoke/prototype-dictionary-rule"
      )
    ) {
      throw new Error("prototype-sensitive dictionary groups did not match");
    }

    const expectRulePackError = (fn) => {
      try {
        fn();
      } catch (error) {
        if (!(error instanceof RulePackError)) throw error;
        return;
      }
      throw new Error("expected RulePackError");
    };
    expectRulePackError(() => composeRulePacks([{ ...prototypePack, dictionary: null }]));
    expectRulePackError(() => composeRulePacks([{ ...prototypePack, rules: new Array(1) }]));
    expectRulePackError(() =>
      composeRulePacks([{ ...prototypePack, dictionry: prototypePack.dictionary }])
    );
    expectRulePackError(() =>
      composeRulePacks([
        {
          ...prototypePack,
          meta: {
            ...prototypePack.meta,
            experimentl: true
          }
        }
      ])
    );
    expectRulePackError(() =>
      composeRulePacks([{ ...prototypePack, meta: Object.create(prototypePack.meta) }])
    );
    expectRulePackError(() =>
      composeRulePacks([
        {
          ...prototypePack,
          rules: [
            {
              ...prototypePack.rules[0],
              meta: {
                ...prototypePack.rules[0].meta,
                references: new Array(1)
              }
            }
          ]
        }
      ])
    );

    const malformedFindingPack = {
      ...prototypePack,
      meta: {
        ...prototypePack.meta,
        id: "smoke/malformed-finding-pack"
      },
      rules: [
        {
          ...prototypePack.rules[0],
          meta: {
            ...prototypePack.rules[0].meta,
            id: "smoke/malformed-finding-rule"
          },
          evaluate(doc, ctx) {
            return [
              ctx.createFinding({
                severity: "critical",
                evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
                description: "Invalid severity.",
                whyItMatters: "Rule output must preserve the public report schema.",
                recommendation: "Return a valid severity."
              })
            ];
          }
        }
      ]
    };
    expectRulePackError(() =>
      scanHtml("<main>alpha beta gamma</main>", {
        rulePacks: [fairuxBuiltinRulePack, malformedFindingPack]
      })
    );

    const categoryMismatchPack = {
      ...prototypePack,
      meta: {
        ...prototypePack.meta,
        id: "smoke/category-mismatch-pack"
      },
      rules: [
        {
          ...prototypePack.rules[0],
          meta: {
            ...prototypePack.rules[0].meta,
            id: "smoke/category-mismatch-rule",
            category: "obstruction"
          },
          evaluate(doc, ctx) {
            const finding = ctx.createFinding({
              evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
              description: "Invalid category.",
              whyItMatters: "Finding category must match rule metadata.",
              recommendation: "Return the rule meta category."
            });
            return [{ ...finding, category: "privacy" }];
          }
        }
      ]
    };
    expectRulePackError(() =>
      scanHtml("<main>alpha beta gamma</main>", {
        rulePacks: [categoryMismatchPack]
      })
    );

    const duplicateFindingIdPack = {
      ...prototypePack,
      meta: {
        ...prototypePack.meta,
        id: "smoke/duplicate-finding-id-pack"
      },
      rules: [
        {
          ...prototypePack.rules[0],
          meta: {
            ...prototypePack.rules[0].meta,
            id: "smoke/duplicate-finding-id-rule"
          },
          evaluate(doc, ctx) {
            const first = ctx.createFinding({
              evidence: [{ locator: doc.root.locator, text: "first" }],
              description: "Duplicate finding id.",
              whyItMatters: "Finding IDs must be report-unique.",
              recommendation: "Return unique IDs."
            });
            const second = ctx.createFinding({
              evidence: [{ locator: doc.root.locator, text: "second" }],
              description: "Duplicate finding id.",
              whyItMatters: "Finding IDs must be report-unique.",
              recommendation: "Return unique IDs."
            });
            return [
              { ...first, id: "duplicate" },
              { ...second, id: "duplicate" }
            ];
          }
        }
      ]
    };
    expectRulePackError(() =>
      scanHtml("<main>alpha beta gamma</main>", {
        rulePacks: [duplicateFindingIdPack]
      })
    );

    let getterSeverityReads = 0;
    const getterBackedPack = {
      ...prototypePack,
      meta: {
        ...prototypePack.meta,
        id: "smoke/getter-backed-pack"
      },
      rules: [
        {
          ...prototypePack.rules[0],
          meta: {
            ...prototypePack.rules[0].meta,
            id: "smoke/getter-backed-rule",
            defaultSeverity: "high"
          },
          evaluate(doc, ctx) {
            const finding = {
              ...ctx.createFinding({
                evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
                description: "Getter-backed severity.",
                whyItMatters: "Rule output must be snapshotted.",
                recommendation: "Return plain data objects."
              })
            };
            Object.defineProperty(finding, "severity", {
              enumerable: true,
              configurable: true,
              get() {
                getterSeverityReads += 1;
                return getterSeverityReads === 1 ? "high" : "critical";
              }
            });
            return [finding];
          }
        }
      ]
    };
    const getterReport = scanHtml("<main>alpha beta gamma</main>", {
      rulePacks: [getterBackedPack]
    });
    if (getterReport.findings[0]?.severity !== "high") {
      throw new Error("getter-backed severity was not snapshotted");
    }
    if (getterReport.summary.bySeverity.high !== 1) {
      throw new Error("getter-backed severity did not aggregate as high");
    }
    if (Object.hasOwn(getterReport.summary.bySeverity, "critical")) {
      throw new Error("getter-backed severity leaked into summary");
    }
    if (getterSeverityReads !== 1) {
      throw new Error("getter-backed severity was read more than once");
    }

    let optionalEvidenceTextReads = 0;
    const optionalEvidenceGetterPack = {
      ...prototypePack,
      meta: {
        ...prototypePack.meta,
        id: "smoke/optional-evidence-getter-pack"
      },
      rules: [
        {
          ...prototypePack.rules[0],
          meta: {
            ...prototypePack.rules[0].meta,
            id: "smoke/optional-evidence-getter-rule"
          },
          evaluate(doc, ctx) {
            const evidence = { locator: doc.root.locator };
            Object.defineProperty(evidence, "text", {
              enumerable: true,
              configurable: true,
              get() {
                optionalEvidenceTextReads += 1;
                return optionalEvidenceTextReads === 1 ? 123 : "valid";
              }
            });
            return [
              ctx.createFinding({
                evidence: [evidence],
                description: "Changing evidence text.",
                whyItMatters: "Rule output must be snapshotted.",
                recommendation: "Return a valid string."
              })
            ];
          }
        }
      ]
    };
    expectRulePackError(() =>
      scanHtml("<main>alpha beta gamma</main>", {
        rulePacks: [optionalEvidenceGetterPack]
      })
    );
    if (optionalEvidenceTextReads !== 1) {
      throw new Error("optional evidence text was read more than once");
    }

    let optionalBatchOccurrenceReads = 0;
    const optionalBatchGetterPack = {
      ...prototypePack,
      meta: {
        ...prototypePack.meta,
        id: "smoke/optional-batch-getter-pack"
      },
      rules: [
        {
          ...prototypePack.rules[0],
          meta: {
            ...prototypePack.rules[0].meta,
            id: "smoke/optional-batch-getter-rule"
          },
          evaluate(doc, ctx) {
            const finding = {
              ...ctx.createFinding({
                evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
                description: "Changing batch occurrence.",
                whyItMatters: "Rule output must be snapshotted.",
                recommendation: "Return a valid string."
              })
            };
            Object.defineProperty(finding, "batchOccurrenceId", {
              enumerable: true,
              configurable: true,
              get() {
                optionalBatchOccurrenceReads += 1;
                return optionalBatchOccurrenceReads === 1 ? 123 : "valid";
              }
            });
            return [finding];
          }
        }
      ]
    };
    expectRulePackError(() =>
      scanHtml("<main>alpha beta gamma</main>", {
        rulePacks: [optionalBatchGetterPack]
      })
    );
    if (optionalBatchOccurrenceReads !== 1) {
      throw new Error("optional batchOccurrenceId was read more than once");
    }
  `;
  writeFileSync(join(work, "policy-smoke.mjs"), policySmoke, "utf8");
  run("node", [join(work, "policy-smoke.mjs")], { cwd: work });
  ok("packed reusable scanner preserves policy merge semantics and rule pack validation");

  const mutationSmoke = `
    import { fairuxBuiltinRulePack } from "@fairux/sdk";
    import { scanHtml } from "@fairux/sdk/html";

    const html = "<label><input type='checkbox' checked> Send marketing</label>";
    const before = scanHtml(html, { now: () => new Date("2026-01-01T00:00:00Z") });
    const beforeFinding = before.findings.find((finding) => finding.ruleId === "consent/checked-checkbox");
    const originalPackId = fairuxBuiltinRulePack.meta.id;
    const originalVersion = fairuxBuiltinRulePack.meta.version;
    const originalEvaluate = fairuxBuiltinRulePack.rules[0]?.evaluate;
    const checks = {
      pack: Object.isFrozen(fairuxBuiltinRulePack),
      meta: Object.isFrozen(fairuxBuiltinRulePack.meta),
      rules: Object.isFrozen(fairuxBuiltinRulePack.rules),
      firstRule: Object.isFrozen(fairuxBuiltinRulePack.rules[0]),
      firstRuleMeta: Object.isFrozen(fairuxBuiltinRulePack.rules[0]?.meta),
      dictionary: Object.isFrozen(fairuxBuiltinRulePack.dictionary)
    };
    for (const [name, passed] of Object.entries(checks)) {
      if (!passed) throw new Error("built-in pack is not frozen: " + name);
    }
    const mustThrow = (fn, label) => {
      try {
        fn();
      } catch {
        return;
      }
      throw new Error("mutation did not throw: " + label);
    };
    mustThrow(() => {
      fairuxBuiltinRulePack.meta.id = "forged/builtin";
    }, "meta.id");
    mustThrow(() => {
      fairuxBuiltinRulePack.meta.version = "999.0.0";
    }, "meta.version");
    mustThrow(() => {
      fairuxBuiltinRulePack.rules.push(fairuxBuiltinRulePack.rules[0]);
    }, "rules.push");
    mustThrow(() => {
      fairuxBuiltinRulePack.rules[0].evaluate = () => [];
    }, "rule.evaluate");
    const after = scanHtml(html, { now: () => new Date("2026-01-01T00:00:00Z") });
    const afterFinding = after.findings.find((finding) => finding.ruleId === "consent/checked-checkbox");
    if (fairuxBuiltinRulePack.meta.id !== originalPackId) throw new Error("pack id changed");
    if (fairuxBuiltinRulePack.meta.version !== originalVersion) throw new Error("pack version changed");
    if (fairuxBuiltinRulePack.rules[0]?.evaluate !== originalEvaluate) throw new Error("evaluate changed");
    if (before.rulePacks?.[0]?.id !== "@fairux/builtin") throw new Error("before provenance changed");
    if (after.rulePacks?.[0]?.id !== "@fairux/builtin") throw new Error("after provenance changed");
    if (before.rulePacks?.[0]?.version !== "0.1.0") throw new Error("before version changed");
    if (after.rulePacks?.[0]?.version !== "0.1.0") throw new Error("after version changed");
    if (!beforeFinding || !afterFinding) throw new Error("checked checkbox finding missing");
    if (beforeFinding.fingerprint !== afterFinding.fingerprint) throw new Error("fingerprint changed");
  `;
  writeFileSync(join(work, "mutation-smoke.mjs"), mutationSmoke, "utf8");
  run("node", [join(work, "mutation-smoke.mjs")], { cwd: work });
  ok("packed SDK keeps the built-in rule pack immutable");

  run(repoBin("tsc"), ["--noEmit", "-p", join(work, "sdk-typescript-consumer", "tsconfig.json")], {
    cwd: work,
  });
  ok("packed TypeScript consumer compiles against emitted declarations");

  const browserDist = join(work, "sdk-browser-consumer", "dist");
  mkdirSync(browserDist, { recursive: true });
  const browserBundle = join(browserDist, "browser-bundle.mjs");
  const browserMeta = join(browserDist, "meta.json");
  run(
    repoBin("esbuild"),
    [
      join(work, "sdk-browser-consumer", "browser-entry.ts"),
      "--bundle",
      "--platform=browser",
      "--format=esm",
      `--metafile=${browserMeta}`,
      `--outfile=${browserBundle}`,
    ],
    { cwd: work },
  );
  ok("browser consumer bundles with platform=browser");
  const meta = JSON.parse(readFileSync(browserMeta, "utf8"));
  const outputImports = Object.values(meta.outputs).flatMap((output) => output.imports ?? []);
  assert(outputImports.length === 0, "browser bundle has no unresolved external imports");
  const bundleSource = readFileSync(browserBundle, "utf8");
  assertNoNodeBuiltins(bundleSource, "browser bundle");
  assert(!bundleSource.includes(repoRoot), "browser bundle has no SDK source tree references");
  const browserBundleSize = statSync(browserBundle).size;
  assert(
    browserBundleSize < MAX_BROWSER_BUNDLE_BYTES,
    `browser bundle under ${MAX_BROWSER_BUNDLE_BYTES} bytes (${browserBundleSize})`,
  );

  const browserRun = `
    import { createRequire } from "node:module";
    const require = createRequire(${JSON.stringify(pathToFileURL(join(sdkDir, "package.json")).href)});
    const { Window } = await import(require.resolve("happy-dom"));
    const mod = await import(${JSON.stringify(pathToFileURL(browserBundle).href)});
    const window = new Window();
    window.document.body.innerHTML = "<label><input type='checkbox' checked> Email me</label>";
    globalThis.document = window.document;
    const result = mod.scanCurrentDocument();
    if (!result || result.findings < 2 || result.reused !== true) throw new Error("expected reusable browser findings");
    if (result.toolVersion !== ${JSON.stringify(manifest.version)}) {
      throw new Error(\`expected browser toolVersion ${manifest.version}, got \${result.toolVersion}\`);
    }
  `;
  run("node", ["--input-type=module", "--eval", browserRun], { cwd: repoRoot });
  ok("browser bundle executes against a browser-like DOM");

  const publishDryRun = normalizePublishDryRun(
    parseNpmJson(
      run("npm", ["publish", "--dry-run", "--json", "--ignore-scripts", "--tag", "next", tarball], {
        cwd: work,
      }),
    ),
    {
      name: manifest.name,
      version: manifest.version,
      filename: tgz,
      files: entries.map((entry) => ({ path: entry })),
      packedSize: tarballSize,
      unpackedSize: entries
        .map((entry) => Number(run("tar", ["-xzOf", tarball, `package/${entry}`]).length) || 0)
        .reduce((total, size) => total + size, 0),
    },
  );
  assert(publishDryRun.name === manifest.name, `npm dry-run package name is ${manifest.name}`);
  assert(
    publishDryRun.version === manifest.version,
    `npm dry-run package version is ${manifest.version}`,
  );
  assert(
    String(publishDryRun.filename ?? "").includes(tgz) ||
      String(publishDryRun.filename ?? "").endsWith(".tgz"),
    "npm dry-run reports a tarball filename",
  );
  assert(
    publishDryRun.files.some((file) => file.path === "dist/index.js"),
    "npm dry-run file list includes dist/index.js",
  );
  assert(
    publishDryRun.files.some((file) => file.path === "dist/index.d.ts"),
    "npm dry-run file list includes dist/index.d.ts",
  );
  assert(
    Number(publishDryRun.packedSize) < MAX_PACKED_SIZE_BYTES,
    `npm dry-run packed size under ${MAX_PACKED_SIZE_BYTES} bytes (${publishDryRun.packedSize})`,
  );
  assert(
    Number(publishDryRun.unpackedSize) < MAX_UNPACKED_SIZE_BYTES,
    `npm dry-run unpacked size under ${MAX_UNPACKED_SIZE_BYTES} bytes (${publishDryRun.unpackedSize})`,
  );
  assert(
    publishDryRun.access === "public" || manifest.publishConfig?.access === "public",
    "npm dry-run uses public access metadata",
  );

  console.log(failed ? "\n✗ SDK pack smoke test FAILED" : "\n✓ SDK pack smoke test passed");
} catch (error) {
  bad(`SDK pack smoke test errored: ${error.message}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;

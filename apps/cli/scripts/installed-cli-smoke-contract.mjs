/**
 * What an *installed* `fairux` must do — the published CLI's behaviour, checked through the
 * executable npm actually created.
 *
 * This module takes no position on how the CLI got there. `pack-smoke-test.mjs` installs a local
 * tarball and calls it; the registry-installed smoke (M1-R4) will install from the public registry
 * and call the same function with the same expectations. That is the whole reason it is a module
 * and not more assertions inside the pack smoke: the two paths differ in provenance, not in what
 * the CLI is supposed to do, and a Windows-only or registry-only variant of these checks would be
 * a second contract that silently drifts from the first.
 *
 * Correspondingly out of scope, and deliberately: `pnpm pack`, the tarball's structure, npm
 * registry access, `npm install`, and anything about tags or Releases. Everything here starts from
 * "a CLI is installed at `projectDir`" and ends at "it behaves".
 *
 * The caller supplies `runCli`, so this file never decides how to launch a process — on Windows the
 * bin is a `.cmd` shim, and confining that to the caller's runner keeps one launching rule for the
 * whole repository.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where npm puts the `fairux` executable for a project that has it installed.
 *
 * `node_modules/.bin/fairux` is the POSIX half of the answer. On Windows npm writes three shims
 * beside each other — `fairux` (a shell script for MSYS/Cygwin), `fairux.cmd`, and `fairux.ps1` —
 * and the one `cmd.exe` and a plain `spawn` will run is the `.cmd`. Hard-coding the extensionless
 * path meant the Windows check would have run the shell script under whatever interpreter happened
 * to be first, or nothing at all.
 *
 * @param {string} projectDir  a directory with `fairux` installed
 * @param {string} [binName]
 * @returns {string} path to the executable npm generated
 * @throws when no shim exists — the caller must not fall back to `node dist/index.js`, which would
 *   pass while the published `bin` entry was broken
 */
export function installedCliBinPath(projectDir, binName = "fairux") {
  const binDir = join(projectDir, "node_modules", ".bin");
  const candidates =
    process.platform === "win32"
      ? [`${binName}.cmd`, `${binName}.exe`, `${binName}.bat`]
      : [binName];

  for (const candidate of candidates) {
    const shim = join(binDir, candidate);
    if (existsSync(shim)) return shim;
  }

  throw new Error(
    `no npm-generated ${binName} shim in ${binDir} (looked for: ${candidates.join(", ")})`,
  );
}

const CONSENT_DIALOG = '<div role="dialog"><p>We use cookies.</p><button>Accept</button></div>';

/** A consent dialog with an accept button and no reject option; the rule below always fires. */
const CONSENT_RULE = "consent/missing-reject-option";

const FIXTURES = {
  "page.html": `<html><body>${CONSENT_DIALOG}</body></html>\n`,
  "Comp.jsx": `const C = () => (\n  ${CONSENT_DIALOG}\n);\nexport default C;\n`,
  "Comp.tsx": `const C = (): JSX.Element => (\n  ${CONSENT_DIALOG}\n);\nexport default C;\n`,
};

/** Runtime identity each adapter must report for its own input. */
const EXPECTED_RUNTIME = { "page.html": "html", "Comp.jsx": "ast", "Comp.tsx": "ast" };

/**
 * A report path must be usable by whoever reads the report — a reviewer, SARIF, a code-scanning
 * upload. An absolute path out of a temporary directory is none of those, and a Windows separator
 * makes the same file two different identities depending on which machine produced the report.
 *
 * @param {string | undefined} file
 * @returns {string | null} the reason it is unstable, or `null`
 */
function unstableReportPath(file) {
  if (typeof file !== "string" || file === "") return "is missing";
  if (file.includes("\\")) return `contains a backslash (${file})`;
  if (/^[A-Za-z]:/.test(file)) return `carries a drive letter (${file})`;
  if (file.startsWith("/")) return `is absolute (${file})`;
  if (file.includes("..")) return `escapes upward (${file})`;
  return null;
}

/**
 * Run the published CLI's behaviour contract against an already-installed `fairux`.
 *
 * @param {object} input
 * @param {(args: readonly string[], options?: {expectStatus?: number|null, input?: string,
 *   cwd?: string}) => {status: number, stdout: string, stderr: string}} input.runCli
 *   launches the npm-generated executable; `expectStatus` defaults to 0
 * @param {string} input.projectDir  the project `fairux` is installed into
 * @param {string} input.packageVersion  the version the installed package must report
 * @param {(message: string) => void} [input.onPass]
 * @returns {string[]} failures; empty means the installed CLI satisfies the contract
 */
export function runInstalledCliSmoke({ runCli, projectDir, packageVersion, onPass = () => {} }) {
  const failures = [];
  const ok = (message) => onPass(message);
  const bad = (message) => failures.push(message);
  const assert = (condition, message) => (condition ? ok(message) : bad(message));

  /** Parse CLI stdout as JSON, attributing a parse failure to the case that produced it. */
  const parse = (label, stdout) => {
    try {
      return JSON.parse(stdout);
    } catch (error) {
      bad(`${label}: stdout is not valid JSON (${error.message}): ${stdout.slice(0, 200)}`);
      return null;
    }
  };

  // Fixtures live in their own directory so config auto-discovery is exercised deliberately, by
  // the cases below that write a config, rather than incidentally by anything in the project root.
  const inputs = join(projectDir, "inputs");
  mkdirSync(inputs, { recursive: true });
  for (const [name, body] of Object.entries(FIXTURES)) {
    writeFileSync(join(inputs, name), body, "utf8");
  }

  // --- Package identity -----------------------------------------------------------------------
  // The installed manifest, not the source one: this is the boundary where a build-time version
  // injection that failed shows up as `0.0.0-dev` instead of the version that was published.
  const version = runCli(["--version"]).stdout.trim();
  assert(
    version === packageVersion,
    `installed fairux --version is the installed package version (${version} === ${packageVersion})`,
  );

  const installedManifestPath = join(projectDir, "node_modules", "fairux", "package.json");
  if (!existsSync(installedManifestPath)) {
    bad(`installed package has no manifest at ${installedManifestPath}`);
  } else {
    const installed = JSON.parse(readFileSync(installedManifestPath, "utf8"));
    assert(installed.name === "fairux", `installed manifest name is fairux (${installed.name})`);
    assert(
      installed.version === packageVersion,
      `installed manifest version is ${packageVersion} (${installed.version})`,
    );
    assert(
      installed.bin?.fairux === "./dist/index.js",
      `installed manifest bin.fairux is ./dist/index.js (${installed.bin?.fairux})`,
    );
    assert(
      typeof installed.engines?.node === "string" && installed.engines.node.length > 0,
      `installed manifest declares engines.node (${installed.engines?.node})`,
    );
  }

  const help = runCli(["--help"]).stdout;
  assert(/\bfairux\b/.test(help), "--help names the command");
  assert(/\bscan\b/.test(help), "--help lists the scan command");
  assert(/--version\b/.test(help), "--help documents --version");
  assert(/UX risk signals/.test(help), "--help carries the package description");

  // --- Adapters: HTML, JSX, TSX ---------------------------------------------------------------
  for (const name of Object.keys(FIXTURES)) {
    const label = `scan ${name}`;
    const report = parse(
      label,
      runCli(["scan", join(inputs, name), "--format", "json", "--ignore-config"]).stdout,
    );
    if (report === null) continue;

    assert(report.kind === "single", `${label}: report kind is single (${report.kind})`);
    assert(
      report.schemaVersion === "0.1",
      `${label}: report schemaVersion is 0.1 (${report.schemaVersion})`,
    );
    assert(
      report.toolVersion === packageVersion,
      `${label}: report.toolVersion is the installed version (${report.toolVersion})`,
    );
    assert(
      report.input?.runtime === EXPECTED_RUNTIME[name],
      `${label}: runtime identity is ${EXPECTED_RUNTIME[name]} (${report.input?.runtime})`,
    );

    const unstable = unstableReportPath(report.input?.file);
    assert(
      unstable === null,
      `${label}: report path is stable${unstable ? ` — it ${unstable}` : ""}`,
    );

    // Pinned to the rule the fixture is built to trigger. A total-count assertion would break
    // every time a rule is added and prove nothing about whether *this* input was understood.
    const ruleIds = (report.findings ?? []).map((finding) => finding.ruleId);
    assert(ruleIds.includes(CONSENT_RULE), `${label}: reports ${CONSENT_RULE}`);
    assert(
      typeof report.summary?.total === "number" && report.summary.total === report.findings.length,
      `${label}: summary.total agrees with the findings array (${report.summary?.total})`,
    );
    // A finding's identity is published: it must not carry the temporary directory it was produced
    // in, or a separator that differs between the machine that scanned and the machine that reads.
    const leaking = (report.findings ?? []).filter((finding) =>
      JSON.stringify(finding).includes(projectDir.replaceAll("\\", "\\\\")),
    );
    assert(
      leaking.length === 0,
      `${label}: no finding embeds the absolute project path (${leaking.length} do)`,
    );
  }

  // --- Input target modes: stdin, file, directory, glob ----------------------------------------
  const fromStdin = parse(
    "scan -",
    runCli(["scan", "-", "--format", "json", "--ignore-config"], {
      input: FIXTURES["page.html"],
    }).stdout,
  );
  if (fromStdin !== null) {
    assert(
      fromStdin.toolVersion === packageVersion,
      `scan -: report.toolVersion is the installed version (${fromStdin.toolVersion})`,
    );
    assert(
      (fromStdin.findings ?? []).some((finding) => finding.ruleId === CONSENT_RULE),
      `scan -: stdin input reports ${CONSENT_RULE}`,
    );
    // Piped input has no path, so the report names the synthetic one rather than inventing a file.
    assert(
      fromStdin.input?.file === "stdin.html",
      `scan -: report names the stdin input (${fromStdin.input?.file})`,
    );
  }

  // The glob is passed as one literal argument and expanded by the CLI. If a shell had expanded it
  // the CLI would receive a file list, this case would pass on POSIX, and it would fail on Windows
  // where no shell is involved — which is exactly the asymmetry the runner exists to prevent.
  //
  // `inputs/*.html` is written out rather than built with `join`, and is the portable form on every
  // target. On Windows the native `inputs\*.html` is checked beside it and must name the same
  // files: that is the form a Windows user types, and the shell there hands it over untouched. It
  // matched nothing until #84, and pinning only the portable form here would have let the
  // registry-installed smoke inherit that gap as the supported behaviour.
  const nativeGlobTargets =
    process.platform === "win32" ? [["glob-native-separator", "inputs\\*.html"]] : [];
  const scanned = {};
  for (const [mode, target] of [
    ["directory", inputs],
    ["glob", "inputs/*.html"],
    ...nativeGlobTargets,
  ]) {
    const report = parse(
      `scan ${mode}`,
      runCli(["scan", target, "--format", "json", "--ignore-config"], { cwd: projectDir }).stdout,
    );
    if (report === null) continue;
    // One `.html` fixture means the glob resolves to a single file and renders a single report;
    // the directory holds three scannable files and renders a batch. Both must name their inputs.
    const files = report.kind === "batch" ? report.inputs.map((i) => i.file) : [report.input?.file];
    scanned[mode] = files;
    const unstable = files
      .map((file) => unstableReportPath(file))
      .filter((reason) => reason !== null);
    assert(
      unstable.length === 0,
      `scan ${mode}: every reported path is stable (${files.length})${
        unstable.length > 0 ? ` — one ${unstable[0]}` : ""
      }`,
    );
  }
  if (scanned.directory && scanned.glob) {
    const sorted = [...scanned.directory].sort();
    assert(
      scanned.directory.every((file, index) => file === sorted[index]),
      `scan directory: file order is sorted, so it does not depend on readdir order (${scanned.directory.join(", ")})`,
    );
    assert(
      scanned.glob.every((file) => scanned.directory.includes(file)),
      `scan glob: matches are a subset of the directory walk (${scanned.glob.join(", ")})`,
    );
  }
  if (nativeGlobTargets.length > 0) {
    const native = scanned["glob-native-separator"];
    assert(
      Array.isArray(native) && native.length > 0,
      `scan glob-native-separator: a native-separator glob matches (${native?.length ?? 0})`,
    );
    assert(
      Array.isArray(native) &&
        Array.isArray(scanned.glob) &&
        native.length === scanned.glob.length &&
        native.every((file, index) => file === scanned.glob[index]),
      `scan glob-native-separator: names exactly what the portable form names (${native?.join(", ")})`,
    );

    // A drive-absolute pattern is the other half of the same rule, and it is the one an editor
    // integration or a script emits. `join` produces the native form here on purpose.
    const absolute = parse(
      "scan glob-drive-absolute",
      runCli(["scan", join(inputs, "*.html"), "--format", "json", "--ignore-config"]).stdout,
    );
    if (absolute !== null) {
      const file = absolute.kind === "batch" ? absolute.inputs[0]?.file : absolute.input?.file;
      const unstable = unstableReportPath(file);
      assert(
        unstable === null,
        `scan glob-drive-absolute: matched and reported a stable path${unstable ? ` — it ${unstable}` : ` (${file})`}`,
      );
    }

    // UNC, device, and extended-length patterns are refused rather than expanded. The refusal is
    // decided from the pattern's form, so no share is contacted and this is deterministic on a
    // runner with no network drive. It must not read as the matched-nothing failure it replaced.
    const unc = runCli(
      ["scan", "\\\\server\\share\\*.html", "--format", "json", "--ignore-config"],
      {
        expectStatus: 2,
      },
    );
    assert(unc.status === 2, `a UNC glob exits 2 (${unc.status})`);
    assert(
      /not supported for UNC/.test(unc.stderr) && !/no scannable files found/.test(unc.stderr),
      "a UNC glob explains itself rather than reporting no matches",
    );
  }

  // --- Output formats -------------------------------------------------------------------------
  const htmlFixture = join(inputs, "page.html");
  const markdown = runCli(["scan", htmlFixture, "--format", "markdown", "--ignore-config"]).stdout;
  assert(markdown.includes(`\`${CONSENT_RULE}\``), `markdown output names ${CONSENT_RULE}`);
  assert(/\*\*Severity:\*\*\s*medium\b/.test(markdown), "markdown output states the severity");
  assert(/\*\*Recommendation:\*\*\s*\S/.test(markdown), "markdown output carries a recommendation");

  const sarif = parse(
    "scan --format sarif",
    runCli(["scan", htmlFixture, "--format", "sarif", "--ignore-config"]).stdout,
  );
  if (sarif !== null) {
    assert(sarif.version === "2.1.0", `SARIF version is 2.1.0 (${sarif.version})`);
    const driver = sarif.runs?.[0]?.tool?.driver;
    assert(driver?.name === "FairUX", `SARIF driver name is FairUX (${driver?.name})`);
    assert(
      driver?.version === packageVersion,
      `SARIF driver version is the installed version (${driver?.version})`,
    );
    const results = sarif.runs?.[0]?.results ?? [];
    assert(
      results.some((result) => result.ruleId === CONSENT_RULE),
      `SARIF results carry ${CONSENT_RULE}`,
    );
    // A Windows separator survives into SARIF as `%5C` once `encodeURIComponent` sees it, which is
    // a single opaque path segment rather than a location any code-scanning UI can resolve.
    const uris = results
      .flatMap((result) => result.locations ?? [])
      .map((location) => location.physicalLocation?.artifactLocation?.uri)
      .filter((uri) => uri !== undefined);
    assert(uris.length > 0, "SARIF results carry an artifact location");
    assert(
      uris.every((uri) => !uri.includes("%5C") && !uri.includes("\\") && !/^[A-Za-z]:/.test(uri)),
      `SARIF artifact URIs are separator-neutral (${uris.join(", ")})`,
    );
  }

  // --- Config: auto-discovery, and an explicit executable config -------------------------------
  // Auto-discovery is checked by its effect, not its presence: the override lowers a severity that
  // is `medium` by default, so a run that silently ignored the file would report the default and
  // fail here.
  const discovered = join(inputs, "fairux.config.json");
  writeFileSync(
    discovered,
    `${JSON.stringify({ rules: { [CONSENT_RULE]: { severity: "low" } } }, null, 2)}\n`,
    "utf8",
  );
  const baseline = parse(
    "config baseline",
    runCli(["scan", htmlFixture, "--format", "json", "--ignore-config"]).stdout,
  );
  const withConfig = parse(
    "config auto-discovery",
    runCli(["scan", htmlFixture, "--format", "json"]).stdout,
  );
  if (baseline !== null && withConfig !== null) {
    const severityOf = (report) =>
      report.findings?.find((finding) => finding.ruleId === CONSENT_RULE)?.severity;
    assert(
      severityOf(baseline) !== "low",
      `config baseline: ${CONSENT_RULE} is not already low (${severityOf(baseline)})`,
    );
    assert(
      severityOf(withConfig) === "low",
      `auto-discovered fairux.config.json changed the reported severity (${severityOf(withConfig)})`,
    );
  }

  const marker = join(projectDir, "CONFIG_EXECUTED");
  const executableConfig = join(projectDir, "fairux.config.mjs");
  writeFileSync(
    executableConfig,
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(marker)}, "loaded");\n` +
      `export default {};\n`,
    "utf8",
  );
  const trusted = runCli(["scan", htmlFixture, "--config", executableConfig, "--format", "json"]);
  assert(existsSync(marker), "explicit --config executable config actually ran (marker written)");
  assert(/trusted code/.test(trusted.stderr), "executing a trusted config warns on stderr");
  // The warning above must not be on stdout: a consumer piping `--format json` into a parser is
  // the reason machine-readable output and diagnostics are on different streams.
  assert(
    parse("trusted config", trusted.stdout) !== null,
    "trusted-config run keeps stdout parseable JSON",
  );

  // --- Exit behaviour -------------------------------------------------------------------------
  const badFormat = runCli(["scan", htmlFixture, "--format", "toml", "--ignore-config"], {
    expectStatus: 2,
  });
  assert(badFormat.status === 2, `an unknown --format exits 2 (${badFormat.status})`);
  assert(/unknown format/.test(badFormat.stderr), "an unknown --format explains itself on stderr");

  const failOn = runCli(
    ["scan", htmlFixture, "--format", "json", "--ignore-config", "--fail-on", "info"],
    { expectStatus: 1 },
  );
  assert(failOn.status === 1, `--fail-on with a matching finding exits 1 (${failOn.status})`);
  assert(parse("--fail-on", failOn.stdout) !== null, "--fail-on still writes a parseable report");

  const clean = runCli(["scan", htmlFixture, "--format", "json", "--ignore-config"]);
  assert(clean.status === 0, `a scan without a threshold exits 0 (${clean.status})`);

  return failures;
}

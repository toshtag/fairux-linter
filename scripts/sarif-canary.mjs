#!/usr/bin/env node
/**
 * The SARIF upload canary's I/O half: prepare, upload, observe, and delete real code scanning
 * analyses.
 *
 * Every refusal it obeys is in `sarif-canary-contract.mjs` and is checked without a network call.
 * This file is the part that cannot be unit-tested — it talks to GitHub — so it is deliberately
 * thin: parse arguments, call a permitted operation, print evidence as JSON.
 *
 * Usage:
 *   sarif-canary.mjs validate --ref <ref> --sha-before <sha> --sha-after <sha>
 *   sarif-canary.mjs prepare  --in <sarif> --out <sarif> --category <category> [--empty]
 *                             [--location-shape as-emitted|none|input-file] [--artifact-uri <uri>]
 *   sarif-canary.mjs upload  --ref <ref> --sha <sha> --sarif <file> [--record-processing-failure]
 *   sarif-canary.mjs observe --ref <ref>
 *   sarif-canary.mjs compare --ref <ref> --before <evidence> --after <evidence>
 *   sarif-canary.mjs cleanup --ref <ref>
 *
 * `GITHUB_TOKEN` and `GITHUB_REPOSITORY` come from the workflow. Nothing here reads a secret, and
 * the token it uses holds `security-events: write` and `contents: read` and nothing else.
 *
 * Node built-ins only: this runs before any dependency tree is guaranteed to exist.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import {
  alertIdentityAcrossMove,
  assertCanaryRef,
  assertCommitSha,
  CANARY_CATEGORY_LIST,
  CANARY_TOOL_NAME,
  logicalOnlyAlertShape,
  partitionCanaryAnalyses,
  prepareCanarySarif,
  undeletableAnalysisSet,
} from "./sarif-canary-contract.mjs";

const API = "https://api.github.com";
/** SARIF processing is asynchronous; the upload returns before any alert exists. */
const PROCESSING_DEADLINE_MS = 180_000;
const POLL_INTERVAL_MS = 5_000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${requireEnv("GITHUB_TOKEN")}`,
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function repo() {
  const [owner, name] = requireEnv("GITHUB_REPOSITORY").split("/");
  if (!owner || !name) throw new Error("GITHUB_REPOSITORY must be <owner>/<repo>");
  return { owner, name, path: `/repos/${owner}/${name}` };
}

/** The repository's own default branch, read rather than assumed: the ref refusal depends on it. */
async function defaultBranch({ path }) {
  const info = await api(path);
  if (typeof info?.default_branch !== "string") {
    throw new Error("could not read the repository's default branch");
  }
  return info.default_branch;
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name) {
  const value = arg(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

/**
 * @param {{path: string}} target
 * @param {string} ref
 * @param {string} sha
 * @param {string} sarifPath
 * @param {{recordProcessingFailure?: boolean}} [options]  when set, a SARIF GitHub refuses to
 *   process is returned as evidence instead of raised. Only for the probes whose acceptance is
 *   itself the question — for every other upload a failure is a failure, and swallowing it would
 *   make a red observation look like a green one.
 */
async function upload({ path }, ref, sha, sarifPath, { recordProcessingFailure = false } = {}) {
  const created = await api(`${path}/code-scanning/sarifs`, {
    method: "POST",
    body: {
      commit_sha: sha,
      ref,
      sarif: gzipSync(readFileSync(sarifPath)).toString("base64"),
      // No `checkout_uri`: it defaults to the repository root, which is what the SARIF's own
      // repository-relative `artifactLocation.uri` values are already relative to. Supplying one
      // would move the resolution base and point every location somewhere that does not exist.
      validate: true,
    },
  });

  // Processing is asynchronous. A run that reported success on the POST alone would be reporting
  // that GitHub accepted bytes, not that it produced an analysis — a SARIF that fails validation
  // during processing still returns 202 from the POST.
  const deadline = Date.now() + PROCESSING_DEADLINE_MS;
  let status = null;
  while (Date.now() < deadline) {
    status = await api(`${path}/code-scanning/sarifs/${created.id}`);
    if (status.processing_status !== "pending") break;
    await sleep(POLL_INTERVAL_MS);
  }
  if (status?.processing_status !== "complete" && !recordProcessingFailure) {
    throw new Error(
      `SARIF ${created.id} did not process: ${status?.processing_status} ` +
        JSON.stringify(status?.errors ?? []),
    );
  }

  return {
    stage: "upload",
    ref,
    sha,
    sarifId: created.id,
    processingStatus: status?.processing_status ?? null,
    processingErrors: status?.errors ?? [],
    analysesUrl: status?.analyses_url ?? null,
    accepted: status?.processing_status === "complete",
  };
}

function listQuery(ref, extra = {}) {
  return new URLSearchParams({
    ref,
    tool_name: CANARY_TOOL_NAME,
    per_page: "100",
    ...extra,
  });
}

/**
 * List code scanning analyses or alerts, treating "none" as an empty list.
 *
 * GitHub answers a filter that matches nothing with `404 no analysis found` rather than `200 []`.
 * Read as an error, that made the one state cleanup exists to reach — nothing left — indistinguishable
 * from a broken read: the confirmation pass after a successful delete would have failed the run it
 * had just completed. Any other 404, and every other status, still raises.
 *
 * @param {string} path
 * @returns {Promise<object[]>}
 */
async function listOrEmpty(path) {
  try {
    return (await api(path)) ?? [];
  } catch (error) {
    if (/→ 404/.test(error.message) && /no analysis found/.test(error.message)) return [];
    throw error;
  }
}

async function observe({ path }, ref) {
  const [analyses, alerts] = await Promise.all([
    listOrEmpty(`${path}/code-scanning/analyses?${listQuery(ref)}`),
    // Every state, not only `open`: whether a dropped result becomes `fixed` is stage C's whole
    // question, and filtering to open alerts would have made the answer look like a disappearance.
    listOrEmpty(`${path}/code-scanning/alerts?${listQuery(ref)}`),
  ]);
  const { targets, foreign } = partitionCanaryAnalyses(analyses, {
    ref,
    tool: CANARY_TOOL_NAME,
    categories: CANARY_CATEGORY_LIST,
  });
  return {
    stage: "observe",
    ref,
    // What the API actually calls each analysis on this ref, alongside what the upload asked for.
    // The first observation run recorded zero canary analyses and eight foreign ones on a ref no
    // other tool has ever written to — which is the partition saying "I do not recognise my own
    // uploads", not the ref holding someone else's work. Cleanup refuses on a foreign entry, so the
    // failure was safe; it was also undiagnosable, because the evidence never said what the
    // categories were.
    categoriesSeen: [...new Set((analyses ?? []).map((analysis) => analysis?.category))],
    categoriesExpected: CANARY_CATEGORY_LIST,
    canaryAnalyses: targets.map((analysis) => ({
      id: analysis.id,
      commitSha: analysis.commit_sha,
      category: analysis.category,
      toolName: analysis.tool?.name,
      toolVersion: analysis.tool?.version,
      createdAt: analysis.created_at,
      resultsCount: analysis.results_count,
      deletable: analysis.deletable,
    })),
    analysesNotThisCanary: foreign.length,
    alerts: alerts.map((alert) => ({
      number: alert.number,
      ruleId: alert.rule?.id,
      severity: alert.rule?.severity ?? null,
      state: alert.state,
      path: alert.most_recent_instance?.location?.path ?? null,
      startLine: alert.most_recent_instance?.location?.start_line ?? null,
      partialFingerprints: alert.most_recent_instance?.partial_fingerprints ?? null,
      htmlUrl: alert.html_url,
    })),
  };
}

async function cleanup(target, ref) {
  const listed = await listOrEmpty(`${target.path}/code-scanning/analyses?${listQuery(ref)}`);
  const partition = partitionCanaryAnalyses(listed, {
    ref,
    tool: CANARY_TOOL_NAME,
    categories: CANARY_CATEGORY_LIST,
  });
  const refusal = undeletableAnalysisSet(partition, { ref });
  if (refusal) throw new Error(refusal);

  // Newest first, which is the only order the API allows: an analysis is deletable while it is the
  // most recent one in its set, and deleting it makes the next one deletable in turn.
  const deleted = [];
  for (const analysis of [...partition.targets].sort((a, b) => b.id - a.id)) {
    await api(`${target.path}/code-scanning/analyses/${analysis.id}?confirm_delete`, {
      method: "DELETE",
    });
    deleted.push(analysis.id);
  }

  const remaining = partitionCanaryAnalyses(
    await listOrEmpty(`${target.path}/code-scanning/analyses?${listQuery(ref)}`),
    { ref, tool: CANARY_TOOL_NAME, categories: CANARY_CATEGORY_LIST },
  );
  if (remaining.targets.length > 0) {
    throw new Error(
      `cleanup left ${remaining.targets.length} canary analyses on ${ref}: ` +
        remaining.targets.map((analysis) => analysis.id).join(", "),
    );
  }
  return { stage: "cleanup", ref, deleted, remaining: 0 };
}

/** Re-shape one recorded evidence row back into the alert fields the contract reads. */
function asAlert(row) {
  if (!row) return undefined;
  return {
    number: row.number,
    rule: { id: row.ruleId },
    state: row.state,
    most_recent_instance: {
      location: { path: row.path, start_line: row.startLine },
      partial_fingerprints: row.partialFingerprints,
    },
  };
}

function compare(ref) {
  const read = (name) => JSON.parse(readFileSync(required(name), "utf8"));
  const before = read("before");
  const after = read("after");
  const pick = (evidence, ruleId) => evidence.alerts?.find((alert) => alert.ruleId === ruleId);

  return {
    stage: "compare",
    ref,
    lineMove: alertIdentityAcrossMove({
      before: asAlert(pick(before, "consent/missing-reject-option")),
      after: asAlert(pick(after, "consent/missing-reject-option")),
    }),
    logicalOnly: logicalOnlyAlertShape(asAlert(pick(after, "consent/checked-checkbox"))),
  };
}

async function main() {
  const command = process.argv[2];

  // `prepare` touches no repository, so it neither needs a token nor may take a ref: a step that
  // reads a file and writes a file has no business being able to name a branch.
  if (command === "prepare") {
    const category = required("category");
    const prepared = prepareCanarySarif(JSON.parse(readFileSync(required("in"), "utf8")), {
      category,
      empty: process.argv.includes("--empty"),
      locationShape: arg("location-shape") ?? "as-emitted",
      artifactUri: arg("artifact-uri"),
    });
    writeFileSync(required("out"), `${JSON.stringify(prepared, null, 2)}\n`, "utf8");
    return {
      stage: "prepare",
      category,
      locationShape: arg("location-shape") ?? "as-emitted",
      results: prepared.runs[0].results.length,
      out: required("out"),
    };
  }

  const target = repo();
  const ref = assertCanaryRef(arg("ref"), { defaultBranch: await defaultBranch(target) });

  // Run before anything else touches the inputs. Every later step interpolates them into a shell
  // command or an API path, and a refusal that happens after the first `git checkout` is a refusal
  // that arrived too late.
  if (command === "validate") {
    return {
      stage: "validate",
      ref,
      shaBefore: assertCommitSha(arg("sha-before"), "--sha-before"),
      shaAfter: assertCommitSha(arg("sha-after"), "--sha-after"),
      categories: CANARY_CATEGORY_LIST,
    };
  }

  if (command === "upload") {
    return await upload(target, ref, assertCommitSha(arg("sha"), "--sha"), required("sarif"), {
      recordProcessingFailure: process.argv.includes("--record-processing-failure"),
    });
  }
  if (command === "observe") return await observe(target, ref);
  if (command === "compare") return compare(ref);
  if (command === "cleanup") return await cleanup(target, ref);

  throw new Error(
    `unknown command ${JSON.stringify(command)} (validate, prepare, upload, observe, compare, cleanup)`,
  );
}

main()
  .then((evidence) => {
    console.log(JSON.stringify(evidence, null, 2));
  })
  .catch((error) => {
    console.error(`sarif-canary: ${error.message}`);
    process.exitCode = 1;
  });

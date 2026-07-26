#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isBuiltinJurisdictionId, isSemver } from "../../core/dist/index.js";
import { fairuxBuiltinRulePack } from "../dist/index.js";
import { reviewedGovernance } from "./generate-reviewed-governance.mjs";
import {
  collectRuntimeRuleMetadata,
  compareCanonicalId,
  validateReviewFoundation,
} from "./review-validation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCES_PATH = join(ROOT, "packages/rules/reviews/official-sources.json");
const REVIEWS_PATH = join(ROOT, "packages/rules/reviews/built-in-rule-reviews.json");
const GENERATED_CATALOG_PATH = join(ROOT, "docs/generated/rule-catalog.json");
const RULES_DOC_PATH = join(ROOT, "docs/rules.md");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sortById(items) {
  return [...items].sort((left, right) => compareCanonicalId(left.id, right.id));
}

function formatGenerated(path, contents, rootDir) {
  if (!path.endsWith(".json") && !path.endsWith(".ts")) return contents;
  const result = spawnSync("pnpm", ["exec", "biome", "format", "--stdin-file-path", path], {
    cwd: rootDir,
    input: contents,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `Biome failed while formatting ${path}`);
  }
  return result.stdout;
}

function fullSourceReview(review, sourcesById) {
  const source = sourcesById.get(review.sourceId);
  if (!source) throw new Error(`Unknown official source ${review.sourceId}`);
  return {
    source: {
      id: source.id,
      title: source.identity.title,
      publisher: source.identity.publisher,
      url: source.identity.url,
      catalogMetadata: source.catalogMetadata,
    },
    reviewedAt: review.reviewedAt,
    jurisdictions: review.jurisdictions,
    supportKind: review.supportKind,
    sourceLocator: review.sourceLocator,
    mappingNote: review.mappingNote,
    limitations: review.limitations,
  };
}

function corpusSummary(corpusEvidence) {
  return {
    positiveCount: corpusEvidence.positive.length,
    negativeCount: corpusEvidence.negative.length,
    ambiguousCount: corpusEvidence.ambiguous?.length ?? 0,
    positive: corpusEvidence.positive,
    negative: corpusEvidence.negative,
    ...(corpusEvidence.ambiguous ? { ambiguous: corpusEvidence.ambiguous } : {}),
  };
}

function executionFromMeta(meta) {
  return {
    defaultSeverity: meta.defaultSeverity,
    defaultConfidence: meta.defaultConfidence,
    defaultEnabled: meta.defaultEnabled,
    experimental: meta.experimental === true,
    ...(meta.appliesTo ? { appliesTo: meta.appliesTo } : {}),
    ...(meta.appliesToMinConfidence ? { appliesToMinConfidence: meta.appliesToMinConfidence } : {}),
  };
}

function catalog(records, sources, pack) {
  const sourcesById = new Map(sources.sources.map((source) => [source.id, source]));
  const governance = reviewedGovernance(records, sourcesById);
  const metaByRuleId = new Map(pack.rules.map((rule) => [rule.meta.id, rule.meta]));
  const rules = [...records.rules]
    .sort((left, right) => compareCanonicalId(left.ruleId, right.ruleId))
    .map((reviewRecord) => {
      const meta = metaByRuleId.get(reviewRecord.ruleId);
      if (!meta) throw new Error(`Missing runtime rule metadata for ${reviewRecord.ruleId}`);
      const reviewed = governance[reviewRecord.ruleId];
      return {
        identity: {
          id: meta.id,
          title: meta.title,
          category: meta.category,
          tags: meta.tags,
          version: meta.version,
        },
        execution: executionFromMeta(meta),
        maturity: reviewed.maturity,
        capabilities: {
          required: meta.requiredCapabilities,
          ...(meta.optionalCapabilities ? { optional: meta.optionalCapabilities } : {}),
        },
        evidenceRequirements: meta.evidenceRequirements,
        jurisdictions: reviewed.jurisdictions,
        runtimeOfficialSources: reviewed.officialSources,
        knownLimitations: reviewed.knownLimitations,
        review: {
          status: reviewRecord.status,
          preparedBy: reviewRecord.preparedBy,
          preparedAt: reviewRecord.preparedAt,
          ...(reviewRecord.approvedBy ? { approvedBy: reviewRecord.approvedBy } : {}),
          ...(reviewRecord.approvedAt ? { approvedAt: reviewRecord.approvedAt } : {}),
        },
        officialSourceReviewProvenance: reviewRecord.officialSourceReviews.map((review) =>
          fullSourceReview(review, sourcesById),
        ),
        corpusSummary: corpusSummary(reviewRecord.corpusEvidence),
        uncoveredScenarios: reviewRecord.uncoveredScenarios,
        reviewExceptions: reviewRecord.reviewExceptions,
      };
    });
  const runtimeSourceMappingCount = rules.reduce(
    (count, rule) => count + rule.runtimeOfficialSources.length,
    0,
  );
  const fullSourceMappingCount = rules.reduce(
    (count, rule) => count + rule.officialSourceReviewProvenance.length,
    0,
  );
  const stableRuleCount = records.rules.filter((rule) => rule.maturity === "stable").length;
  const experimentalRuleCount = records.rules.filter(
    (rule) => rule.maturity === "experimental",
  ).length;
  return {
    schemaVersion: 1,
    pack: {
      id: pack.meta.id,
      version: pack.meta.version,
    },
    counts: {
      ruleCount: records.rules.length,
      stableRuleCount,
      experimentalRuleCount,
      preparedReviewCount: records.rules.filter((rule) => rule.status === "prepared").length,
      maintainerApprovedReviewCount: records.rules.filter(
        (rule) => rule.status === "maintainer-approved",
      ).length,
      sourceIdentityCount: sources.sources.length,
      runtimeSourceMappingCount,
      fullSourceMappingCount,
    },
    sources: sortById(
      sources.sources.map((source) => ({
        id: source.id,
        title: source.identity.title,
        publisher: source.identity.publisher,
        url: source.identity.url,
        catalogMetadata: source.catalogMetadata,
      })),
    ),
    rules,
  };
}

function markdownList(items) {
  if (!items || items.length === 0) return "- None recorded";
  return items.map((item) => `- ${item}`).join("\n");
}

function sourceLine(entry) {
  const status = entry.source.catalogMetadata.publicationStatus;
  return `\`${entry.source.id}\` (${status}, ${entry.supportKind}, ${entry.jurisdictions.join(
    ", ",
  )}) ${entry.source.title} — ${entry.sourceLocator}. ${entry.mappingNote} Limitations: ${
    entry.limitations
  }`;
}

function corpusLine(entry) {
  return `\`${entry.id}\` (${entry.locale}) ${entry.summary} Test: \`${entry.testRef}\` / \`${entry.testCase}\``;
}

function markdownDoc(catalogData) {
  const lines = [
    "<!-- Generated by pnpm rules:catalog. Do not edit by hand. -->",
    "",
    "# Built-in rule catalog",
    "",
    "This maintainer review catalog is generated from the reviewed built-in rule records and",
    "the built `fairuxBuiltinRulePack` runtime metadata.",
    "",
    "Generation command: `pnpm rules:catalog`.",
    "",
    "This catalog is review provenance for UX risk signals. It is not a maintainer approval,",
    "legal advice, or a legal-compliance determination.",
    "",
    `- Rule pack: \`${catalogData.pack.id}@${catalogData.pack.version}\``,
    `- Rules: ${catalogData.counts.ruleCount} (${catalogData.counts.stableRuleCount} stable, ${catalogData.counts.experimentalRuleCount} experimental)`,
    `- Reviews: ${catalogData.counts.preparedReviewCount} prepared, ${catalogData.counts.maintainerApprovedReviewCount} maintainer-approved`,
    `- Official source identities: ${catalogData.counts.sourceIdentityCount}`,
    `- Runtime source mappings: ${catalogData.counts.runtimeSourceMappingCount}`,
    `- Full catalog source mappings: ${catalogData.counts.fullSourceMappingCount}`,
    "",
    "Machine-readable catalog: [`docs/generated/rule-catalog.json`](generated/rule-catalog.json).",
    "",
    "## Runtime source policy",
    "",
    "Runtime `officialSources` include only source reviews whose source publication status is",
    "`current` and whose support kind is `direct`, `contextual`, or `standard`. Historical,",
    "vacated, and proposed records remain in the generated JSON catalog as review provenance.",
    "",
    "## Summary",
    "",
    "| Rule | Maturity | Jurisdictions | Runtime sources | Full sources | Review |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const rule of catalogData.rules) {
    lines.push(
      `| \`${rule.identity.id}\` | ${rule.maturity} | ${rule.jurisdictions.join(", ")} | ${
        rule.runtimeOfficialSources.length
      } | ${rule.officialSourceReviewProvenance.length} | ${rule.review.status} |`,
    );
  }

  lines.push("", "## Rule details", "");
  for (const rule of catalogData.rules) {
    lines.push(
      `### ${rule.identity.id}`,
      "",
      `- Title: ${rule.identity.title}`,
      `- Version: \`${rule.identity.version}\``,
      `- Category: \`${rule.identity.category}\``,
      `- Maturity: ${rule.maturity}`,
      `- Review status: ${rule.review.status} (${rule.review.preparedBy}, ${rule.review.preparedAt})`,
      `- Default enabled: ${rule.execution.defaultEnabled}`,
      `- Experimental: ${rule.execution.experimental === true}`,
      `- Severity / confidence: ${rule.execution.defaultSeverity} / ${rule.execution.defaultConfidence}`,
      "",
      "Capabilities:",
      markdownList([
        `Required: ${rule.capabilities.required.join(", ")}`,
        ...(rule.capabilities.optional
          ? [`Optional: ${rule.capabilities.optional.join(", ")}`]
          : []),
      ]),
      "",
      "Evidence requirements:",
      markdownList(rule.evidenceRequirements),
      "",
      "Runtime sources:",
      markdownList(
        rule.runtimeOfficialSources.map(
          (source) =>
            `\`${source.id}\` (${source.jurisdictions.join(", ")}) ${source.title} — ${source.publisher}`,
        ),
      ),
      "",
      "Full source provenance:",
      markdownList(rule.officialSourceReviewProvenance.map(sourceLine)),
      "",
      "Known limitations:",
      markdownList(rule.knownLimitations),
      "",
      "Corpus evidence:",
      markdownList([
        ...rule.corpusSummary.positive.map((entry) => `Positive: ${corpusLine(entry)}`),
        ...rule.corpusSummary.negative.map((entry) => `Negative: ${corpusLine(entry)}`),
        ...(rule.corpusSummary.ambiguous ?? []).map((entry) => `Ambiguous: ${corpusLine(entry)}`),
      ]),
      "",
      "Uncovered scenarios:",
      markdownList(
        rule.uncoveredScenarios.map(
          (scenario) =>
            `\`${scenario.id}\` (${scenario.locale}) ${scenario.summary} Owner: ${scenario.owner}. Reason: ${scenario.reason}. Resolution: ${scenario.resolutionCriteria}`,
        ),
      ),
      "",
      "Review exceptions:",
      markdownList(
        rule.reviewExceptions.map(
          (exception) =>
            `\`${exception.id}\` (${exception.scope}, ${exception.status}) ${exception.reason} Resolution: ${exception.resolutionCriteria}`,
        ),
      ),
      "",
    );
  }

  lines.push("## Source identities", "");
  for (const source of catalogData.sources) {
    lines.push(
      `- \`${source.id}\` (${source.catalogMetadata.publicationStatus}): ${source.title} — ${source.publisher}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderRuleCatalogArtifacts(input) {
  const rootDir = input.rootDir ?? ROOT;
  const pack = input.rulePack ?? fairuxBuiltinRulePack;
  const result = validateReviewFoundation({
    sourceCatalog: input.sourceCatalog,
    reviewRecords: input.reviewRecords,
    runtimeRules: input.runtimeRules ?? collectRuntimeRuleMetadata(pack.rules),
    isBuiltinJurisdictionId: input.isBuiltinJurisdictionId ?? isBuiltinJurisdictionId,
    isSemver: input.isSemver ?? isSemver,
    rootDir,
    requireApprovedStable: input.requireApprovedStable,
  });
  if (!result.ok) {
    throw new Error(`Rule catalog input validation failed:\n${result.errors.join("\n")}`);
  }
  const catalogData = catalog(input.reviewRecords, input.sourceCatalog, pack);
  return {
    summary: result.summary,
    catalogData,
    artifacts: [
      {
        path: input.catalogPath ?? GENERATED_CATALOG_PATH,
        contents: stableJson(catalogData),
      },
      {
        path: input.rulesDocPath ?? RULES_DOC_PATH,
        contents: markdownDoc(catalogData),
      },
    ],
  };
}

function atomicWrite(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tempPath, contents, "utf8");
  renameSync(tempPath, path);
}

function writeOrCheckArtifacts(artifacts, options) {
  let drift = false;
  for (const artifact of artifacts) {
    const formatted = formatGenerated(artifact.path, artifact.contents, options.rootDir);
    if (options.checkOnly) {
      let current;
      try {
        current = readFileSync(artifact.path, "utf8");
      } catch {
        current = undefined;
      }
      if (current !== formatted) {
        console.error(`${artifact.path} is not up to date. Run pnpm rules:catalog.`);
        drift = true;
      }
    } else {
      const current = (() => {
        try {
          return readFileSync(artifact.path, "utf8");
        } catch {
          return undefined;
        }
      })();
      if (current !== formatted) atomicWrite(artifact.path, formatted);
    }
  }
  if (drift) process.exitCode = 1;
}

function parseMode(argv) {
  const checkOnly = argv.includes("--check");
  const write = argv.includes("--write");
  if (checkOnly === write) {
    throw new Error("Usage: generate-rule-catalog.mjs --write|--check");
  }
  return { checkOnly };
}

function main() {
  const mode = parseMode(process.argv.slice(2));
  const rendered = renderRuleCatalogArtifacts({
    rootDir: ROOT,
    sourceCatalog: readJson(SOURCES_PATH),
    reviewRecords: readJson(REVIEWS_PATH),
  });
  writeOrCheckArtifacts(rendered.artifacts, { rootDir: ROOT, checkOnly: mode.checkOnly });
  if (!mode.checkOnly && process.exitCode !== 1) {
    console.log(
      `Generated rule catalog for ${rendered.catalogData.counts.ruleCount} rules, ${rendered.catalogData.counts.runtimeSourceMappingCount} runtime mappings, and ${rendered.catalogData.counts.fullSourceMappingCount} full mappings.`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

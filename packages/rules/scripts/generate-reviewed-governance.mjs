#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareCanonicalId } from "./review-validation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCES_PATH = join(ROOT, "packages/rules/reviews/official-sources.json");
const REVIEWS_PATH = join(ROOT, "packages/rules/reviews/built-in-rule-reviews.json");
const GOVERNANCE_TEMPLATE_PATH = join(ROOT, "packages/rules/src/governance.ts");
const GENERATED_RUNTIME_PATH = join(ROOT, "packages/rules/src/generated/reviewed-governance.ts");
const GENERATED_CATALOG_PATH = join(ROOT, "docs/generated/rule-catalog.json");
const RULES_DOC_PATH = join(ROOT, "docs/rules.md");
const RUNTIME_SOURCE_KINDS = new Set(["direct", "contextual", "standard"]);

const checkOnly = process.argv.includes("--check");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function toTsLiteral(value) {
  return JSON.stringify(value, null, 2).replaceAll('"', '"').replace(/\n/g, "\n");
}

function sortById(items) {
  return [...items].sort((left, right) => compareCanonicalId(left.id, right.id));
}

function objectLiteralFields(objectText, keys) {
  const fields = {};
  for (const key of keys) {
    const value = literalField(objectText, key);
    if (value !== undefined) fields[key] = value;
  }
  return fields;
}

function literalField(objectText, key) {
  const stringMatch = objectText.match(new RegExp(`\\b${key}:\\s*"([^"]*)"`, "u"));
  if (stringMatch) return stringMatch[1];
  const trueMatch = objectText.match(new RegExp(`\\b${key}:\\s*true\\b`, "u"));
  if (trueMatch) return true;
  const falseMatch = objectText.match(new RegExp(`\\b${key}:\\s*false\\b`, "u"));
  if (falseMatch) return false;
  const arrayMatch = objectText.match(new RegExp(`\\b${key}:\\s*\\[([^\\]]*)\\]`, "u"));
  if (arrayMatch) {
    return [...arrayMatch[1].matchAll(/"([^"]*)"/gu)].map((match) => match[1]);
  }
  return undefined;
}

function objectTextAfter(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Could not find marker ${marker}`);
  const start = text.indexOf("{", markerIndex);
  if (start < 0) throw new Error(`Could not find object after marker ${marker}`);
  let depth = 0;
  let quote;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`Unclosed object after marker ${marker}`);
}

function governanceTemplates() {
  const text = readFileSync(GOVERNANCE_TEMPLATE_PATH, "utf8");
  const templates = new Map();
  for (const match of text.matchAll(/export const ([a-zA-Z0-9]+) = Object\.freeze\(/gu)) {
    const [, name] = match;
    const object = objectTextAfter(text.slice(match.index), "Object.freeze(");
    templates.set(
      name,
      objectLiteralFields(object, [
        "maturity",
        "requiredCapabilities",
        "optionalCapabilities",
        "evidenceRequirements",
      ]),
    );
  }
  return templates;
}

function ruleMetaFromSource(ruleId, templates) {
  const path = join(ROOT, "packages/rules/src", `${ruleId}.ts`);
  const text = readFileSync(path, "utf8");
  const ruleConstName = ruleId
    .split("/")
    .at(-1)
    .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  const ruleObject = objectTextAfter(text, `export const ${ruleConstName}: Rule =`);
  const metaObject = objectTextAfter(ruleObject, "meta:");
  const templateFields = {};
  for (const match of metaObject.matchAll(/\.\.\.([a-zA-Z0-9]+)/gu)) {
    const template = templates.get(match[1]);
    if (template) Object.assign(templateFields, template);
  }

  return {
    ...objectLiteralFields(metaObject, [
      "id",
      "title",
      "category",
      "defaultSeverity",
      "defaultConfidence",
      "defaultEnabled",
      "experimental",
      "appliesTo",
      "appliesToMinConfidence",
      "tags",
      "version",
    ]),
    ...templateFields,
  };
}

function currentRuntimeSource(review, sourcesById) {
  const source = sourcesById.get(review.sourceId);
  if (!source) throw new Error(`Unknown official source ${review.sourceId}`);
  if (source.catalogMetadata.publicationStatus !== "current") return undefined;
  if (!RUNTIME_SOURCE_KINDS.has(review.supportKind)) return undefined;
  return {
    id: source.id,
    title: source.identity.title,
    publisher: source.identity.publisher,
    url: source.identity.url,
    reviewedAt: review.reviewedAt,
    jurisdictions: review.jurisdictions,
  };
}

function reviewedGovernance(records, sourcesById) {
  const entries = {};
  for (const rule of [...records.rules].sort((left, right) =>
    compareCanonicalId(left.ruleId, right.ruleId),
  )) {
    const officialSources = rule.officialSourceReviews
      .map((review) => currentRuntimeSource(review, sourcesById))
      .filter(Boolean)
      .sort((left, right) => compareCanonicalId(left.id, right.id));
    entries[rule.ruleId] = {
      maturity: rule.maturity,
      jurisdictions: rule.ruleJurisdictions,
      officialSources,
      knownLimitations: rule.reviewNotes.knownLimitations,
    };
  }
  return entries;
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

function catalog(records, sources, governance) {
  const templates = governanceTemplates();
  const sourcesById = new Map(sources.sources.map((source) => [source.id, source]));
  const rules = [...records.rules]
    .sort((left, right) => compareCanonicalId(left.ruleId, right.ruleId))
    .map((reviewRecord) => {
      const sourceMeta = ruleMetaFromSource(reviewRecord.ruleId, templates);
      const reviewed = governance[reviewRecord.ruleId];
      return {
        identity: {
          id: sourceMeta.id,
          title: sourceMeta.title,
          category: sourceMeta.category,
          tags: sourceMeta.tags,
          version: sourceMeta.version,
        },
        execution: {
          defaultSeverity: sourceMeta.defaultSeverity,
          defaultConfidence: sourceMeta.defaultConfidence,
          defaultEnabled: sourceMeta.defaultEnabled,
          ...(sourceMeta.experimental !== undefined
            ? { experimental: sourceMeta.experimental }
            : {}),
          ...(sourceMeta.appliesTo ? { appliesTo: sourceMeta.appliesTo } : {}),
          ...(sourceMeta.appliesToMinConfidence
            ? { appliesToMinConfidence: sourceMeta.appliesToMinConfidence }
            : {}),
        },
        maturity: reviewed.maturity,
        capabilities: {
          required: sourceMeta.requiredCapabilities,
          ...(sourceMeta.optionalCapabilities ? { optional: sourceMeta.optionalCapabilities } : {}),
        },
        evidenceRequirements: sourceMeta.evidenceRequirements,
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
        uncoveredScenarioCount: reviewRecord.uncoveredScenarios.length,
        reviewExceptionCount: reviewRecord.reviewExceptions.length,
      };
    });
  const stableRuleCount = records.rules.filter((rule) => rule.maturity === "stable").length;
  const experimentalRuleCount = records.rules.filter(
    (rule) => rule.maturity === "experimental",
  ).length;
  return {
    schemaVersion: 1,
    pack: {
      id: "@fairux/builtin",
      version: "0.1.0",
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

function runtimeSource(governance) {
  return `// Generated by packages/rules/scripts/generate-reviewed-governance.mjs. Do not edit by hand.
import type { RuleMeta } from "@fairux/core";

type ReviewedRuleGovernance = Pick<
  RuleMeta,
  "maturity" | "jurisdictions" | "officialSources" | "knownLimitations"
>;

export const reviewedGovernanceByRuleId = Object.freeze(${toTsLiteral(
    governance,
  )} as const satisfies Record<string, ReviewedRuleGovernance>);
`;
}

function markdownDoc(catalogData) {
  const lines = [
    "# Built-in rule catalog",
    "",
    "This catalog is generated from `packages/rules/reviews/official-sources.json` and",
    "`packages/rules/reviews/built-in-rule-reviews.json`. It records FairUX review",
    "provenance for UX risk signals; it is not a legal-compliance catalog.",
    "",
    `- Rule pack: \`${catalogData.pack.id}@${catalogData.pack.version}\``,
    `- Rules: ${catalogData.counts.ruleCount} (${catalogData.counts.stableRuleCount} stable, ${catalogData.counts.experimentalRuleCount} experimental)`,
    `- Reviews: ${catalogData.counts.preparedReviewCount} prepared, ${catalogData.counts.maintainerApprovedReviewCount} maintainer-approved`,
    `- Official source identities: ${catalogData.counts.sourceIdentityCount}`,
    "",
    "Machine-readable catalog: [`docs/generated/rule-catalog.json`](generated/rule-catalog.json).",
    "",
    "## Rules",
    "",
    "| Rule | Maturity | Jurisdictions | Runtime sources | Review | Corpus | Gaps |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const rule of catalogData.rules) {
    lines.push(
      `| \`${rule.identity.id}\` | ${rule.maturity} | ${rule.jurisdictions.join(", ")} | ${
        rule.runtimeOfficialSources.length
      } | ${rule.review.status} | ${rule.corpusSummary.positiveCount} positive / ${
        rule.corpusSummary.negativeCount
      } negative / ${rule.corpusSummary.ambiguousCount} ambiguous | ${
        rule.uncoveredScenarioCount
      } uncovered / ${rule.reviewExceptionCount} exceptions |`,
    );
  }
  lines.push("", "## Runtime source policy", "");
  lines.push(
    "Runtime `officialSources` include only source reviews whose source publication status is",
    "`current` and whose support kind is `direct`, `contextual`, or `standard`. Historical,",
    "vacated, and proposed records remain in the generated JSON catalog as review provenance.",
  );
  lines.push("", "## Source identities", "");
  for (const source of catalogData.sources) {
    lines.push(
      `- \`${source.id}\` (${source.catalogMetadata.publicationStatus}): ${source.title} - ${source.publisher}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function writeOrCheck(path, contents) {
  const formatted = formatGenerated(path, contents);
  if (checkOnly) {
    let current;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = undefined;
    }
    if (current !== formatted) {
      console.error(`${path} is not up to date. Run pnpm rules:governance:generate.`);
      process.exitCode = 1;
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatted, "utf8");
}

function formatGenerated(path, contents) {
  if (!path.endsWith(".json") && !path.endsWith(".ts")) return contents;
  const result = spawnSync("pnpm", ["exec", "biome", "format", "--stdin-file-path", path], {
    cwd: ROOT,
    input: contents,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `Biome failed while formatting ${path}`);
  }
  return result.stdout;
}

const sources = readJson(SOURCES_PATH);
const records = readJson(REVIEWS_PATH);
const sourcesById = new Map(sources.sources.map((source) => [source.id, source]));
const governance = reviewedGovernance(records, sourcesById);
const catalogData = catalog(records, sources, governance);

writeOrCheck(GENERATED_RUNTIME_PATH, runtimeSource(governance));
writeOrCheck(GENERATED_CATALOG_PATH, stableJson(catalogData));
writeOrCheck(RULES_DOC_PATH, markdownDoc(catalogData));

if (!checkOnly) {
  console.log(
    `Generated reviewed governance for ${catalogData.counts.ruleCount} rules and ${catalogData.counts.sourceIdentityCount} source identities.`,
  );
}

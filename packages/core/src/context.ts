import { buildFingerprint, deriveTextHint, majorVersion } from "./fingerprint.js";
import { createNodeQueries } from "./queries.js";
import { createUiSemantics } from "./semantics.js";
import { normalizeText } from "./text.js";
import type {
  CreateFindingInput,
  Finding,
  KeywordDictionary,
  Locale,
  PatternGroup,
  Rule,
  RuleContext,
  TextMatcher,
  UiDocument,
} from "./types.js";

/**
 * Merge every locale's patterns into one group per name. Detection is language-agnostic:
 * output is English-only, but a page may contain en/ja (or mixed) text, so rules match
 * against all configured locales at once. `ctx.locale` is retained for future output use.
 */
function mergeDictionary(dictionary: KeywordDictionary): PatternGroup {
  const merged: Record<string, RegExp[]> = {};
  for (const group of Object.values(dictionary)) {
    if (!group) continue;
    for (const [name, patterns] of Object.entries(group)) {
      const existing = merged[name] ?? [];
      existing.push(...patterns);
      merged[name] = existing;
    }
  }
  return merged;
}

export function createTextMatcher(): TextMatcher {
  return {
    normalize: normalizeText,
    hasAny: (text, patterns) => patterns.some((re) => re.test(text)),
    findAny: (text, patterns) => {
      for (const re of patterns) {
        // Patterns carry no /g flag, so String.match returns the full match (like a stateless exec).
        const match = text.match(re);
        if (match) return match;
      }
      return null;
    },
  };
}

export interface RuleContextDeps {
  doc: UiDocument;
  rule: Rule;
  locale: Locale;
  dictionary: KeywordDictionary;
  /** Shared across all rules in one scan so finding ids are unique report-wide. */
  counter: { value: number };
}

export function createRuleContext(deps: RuleContextDeps): RuleContext {
  const { doc, rule, locale, dictionary, counter } = deps;
  const queries = createNodeQueries(doc);
  const semantics = createUiSemantics(doc);
  const text = createTextMatcher();
  const mergedDictionary = mergeDictionary(dictionary);

  const createFinding = (input: CreateFindingInput): Finding => {
    const primary = input.evidence[0];
    const hint = input.fingerprintText ?? deriveTextHint(primary?.text ?? "");
    const fingerprint = buildFingerprint({
      ruleId: rule.meta.id,
      category: rule.meta.category,
      locator: primary?.locator,
      textHint: hint,
      ruleVersionMajor: majorVersion(rule.meta.version),
    });

    return {
      id: `${rule.meta.id}#${counter.value++}`,
      fingerprint,
      ruleId: rule.meta.id,
      category: rule.meta.category,
      severity: input.severity ?? rule.meta.defaultSeverity,
      confidence: input.confidence ?? rule.meta.defaultConfidence,
      title: input.title ?? rule.meta.title,
      description: input.description,
      evidence: input.evidence,
      whyItMatters: input.whyItMatters,
      recommendation: input.recommendation,
      references: input.references ?? rule.meta.references,
    };
  };

  return {
    doc,
    locale,
    queries,
    semantics,
    text,
    getDictionary: () => mergedDictionary,
    getPageContexts: () => doc.pageContexts,
    createFinding,
  };
}

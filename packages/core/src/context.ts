import { buildFingerprint, deriveTextHint, majorVersion } from "./fingerprint.js";
import { createNodeQueries } from "./queries.js";
import { validateCreateFindingInput } from "./rule-result.js";
import { createUiSemantics } from "./semantics.js";
import { createStringRecord, readOwnStringValue } from "./string-record.js";
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
  const mutable = createStringRecord<RegExp[]>();
  for (const group of Object.values(dictionary)) {
    if (!group) continue;
    for (const [name, patterns] of Object.entries(group)) {
      const existing = readOwnStringValue(mutable, name);
      const next = existing ?? [];
      next.push(...patterns);
      mutable[name] = next;
    }
  }
  const result = createStringRecord<readonly RegExp[]>();
  for (const [name, patterns] of Object.entries(mutable)) {
    result[name] = Object.freeze([...patterns]);
  }
  return Object.freeze(result);
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
    const validInput = validateCreateFindingInput(input, rule);
    const primary = validInput.evidence[0];
    const hint = validInput.fingerprintText ?? deriveTextHint(primary?.text ?? "");
    const fingerprint = buildFingerprint({
      ruleId: rule.meta.id,
      category: rule.meta.category,
      locator: primary?.locator,
      textHint: hint,
      ruleVersionMajor: majorVersion(rule.meta.version),
    });
    const references =
      validInput.references ??
      (rule.meta.references
        ? (Object.freeze([...rule.meta.references]) as unknown as string[])
        : undefined);

    return Object.freeze({
      id: `${rule.meta.id}#${counter.value++}`,
      fingerprint,
      ruleId: rule.meta.id,
      category: rule.meta.category,
      severity: validInput.severity ?? rule.meta.defaultSeverity,
      confidence: validInput.confidence ?? rule.meta.defaultConfidence,
      title: validInput.title ?? rule.meta.title,
      description: validInput.description,
      evidence: validInput.evidence,
      whyItMatters: validInput.whyItMatters,
      recommendation: validInput.recommendation,
      references,
    });
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

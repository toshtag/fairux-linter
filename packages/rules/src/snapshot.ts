import type {
  CategoryDefinition,
  KeywordDictionary,
  Locale,
  PageContextDefinition,
  PatternGroup,
  Rule,
  RuleMeta,
  RulePack,
  RulePackMeta,
  RulePackTaxonomy,
} from "@fairux/core";

function createStringRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function snapshotStringArray(value: readonly string[] | undefined): string[] | undefined {
  return value ? (Object.freeze([...value]) as unknown as string[]) : undefined;
}

export function snapshotRuleMeta(meta: RuleMeta): RuleMeta {
  return Object.freeze({
    ...meta,
    appliesTo: snapshotStringArray(meta.appliesTo) as RuleMeta["appliesTo"],
    tags: snapshotStringArray(meta.tags) ?? [],
    references: snapshotStringArray(meta.references),
  });
}

export function snapshotRule(rule: Rule): Rule {
  return Object.freeze({
    meta: snapshotRuleMeta(rule.meta),
    evaluate: rule.evaluate,
  });
}

function snapshotPattern(pattern: RegExp): RegExp {
  if (pattern.global || pattern.sticky) {
    throw new Error(
      `Built-in dictionary contains a stateful RegExp: /${pattern.source}/${pattern.flags}`,
    );
  }
  return Object.freeze(new RegExp(pattern.source, pattern.flags));
}

function snapshotPatternGroup(group: PatternGroup): PatternGroup {
  const next = createStringRecord<readonly RegExp[]>();
  for (const key of Reflect.ownKeys(group)) {
    if (typeof key !== "string") {
      throw new Error("Built-in dictionary contains a symbol group name");
    }
    const name = key;
    const patterns = group[name];
    if (!patterns) {
      throw new Error(`Built-in dictionary group ${name} is missing pattern arrays`);
    }
    next[name] = Object.freeze(patterns.map(snapshotPattern));
  }
  return Object.freeze(next);
}

export function snapshotDictionary(dictionary: KeywordDictionary): KeywordDictionary {
  const next = createStringRecord<PatternGroup>();
  for (const [locale, group] of Object.entries(dictionary) as [Locale, PatternGroup][]) {
    next[locale] = snapshotPatternGroup(group);
  }
  return Object.freeze(next);
}

export function snapshotRulePackMeta(meta: RulePackMeta): RulePackMeta {
  return Object.freeze({ ...meta });
}

function snapshotCategoryDefinition(category: CategoryDefinition): CategoryDefinition {
  return Object.freeze({ ...category });
}

function snapshotPageContextDefinition(pageContext: PageContextDefinition): PageContextDefinition {
  return Object.freeze({ ...pageContext });
}

function snapshotTaxonomy(taxonomy: RulePackTaxonomy): RulePackTaxonomy {
  return Object.freeze({
    ...(taxonomy.categories
      ? { categories: Object.freeze(taxonomy.categories.map(snapshotCategoryDefinition)) }
      : {}),
    ...(taxonomy.pageContexts
      ? { pageContexts: Object.freeze(taxonomy.pageContexts.map(snapshotPageContextDefinition)) }
      : {}),
  });
}

export function snapshotRulePack(pack: RulePack): RulePack {
  return Object.freeze({
    meta: snapshotRulePackMeta(pack.meta),
    taxonomy: pack.taxonomy ? snapshotTaxonomy(pack.taxonomy) : undefined,
    rules: pack.rules,
    dictionary: pack.dictionary ? snapshotDictionary(pack.dictionary) : undefined,
  });
}

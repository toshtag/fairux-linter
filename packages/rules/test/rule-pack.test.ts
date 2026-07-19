import { composeRulePacks } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { allRules, dictionary, fairuxBuiltinRulePack } from "../src/index.js";

function expectFrozenDictionary(value: unknown): void {
  expect(Object.isFrozen(value)).toBe(true);
  expect(value).toBeDefined();
  for (const localeGroup of Object.values(
    value as Record<string, Record<string, readonly RegExp[]>>,
  )) {
    expect(Object.isFrozen(localeGroup)).toBe(true);
    for (const patterns of Object.values(localeGroup)) {
      expect(Object.isFrozen(patterns)).toBe(true);
      for (const pattern of patterns) {
        expect(pattern).toBeInstanceOf(RegExp);
        expect(Object.isFrozen(pattern)).toBe(true);
        expect(pattern.global).toBe(false);
        expect(pattern.sticky).toBe(false);
      }
    }
  }
}

describe("fairuxBuiltinRulePack", () => {
  it("exposes all built-in rules in the same order", () => {
    expect(fairuxBuiltinRulePack.rules).toBe(allRules);
    expect(fairuxBuiltinRulePack.rules.map((rule) => rule.meta.id)).toEqual(
      allRules.map((rule) => rule.meta.id),
    );
  });

  it("has unique rule ids", () => {
    const ids = fairuxBuiltinRulePack.rules.map((rule) => rule.meta.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares a supported engine API version and stable pack metadata", () => {
    expect(fairuxBuiltinRulePack.meta).toMatchObject({
      id: "@fairux/builtin",
      engineApiVersion: "1",
      status: "stable",
    });
    expect(fairuxBuiltinRulePack.meta.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("freezes the exported built-in pack and rule snapshots", () => {
    expect(Object.isFrozen(fairuxBuiltinRulePack)).toBe(true);
    expect(Object.isFrozen(fairuxBuiltinRulePack.meta)).toBe(true);
    expect(Object.isFrozen(fairuxBuiltinRulePack.rules)).toBe(true);
    expect(Object.isFrozen(allRules)).toBe(true);

    for (const rule of fairuxBuiltinRulePack.rules) {
      expect(Object.isFrozen(rule)).toBe(true);
      expect(Object.isFrozen(rule.meta)).toBe(true);
      expect(Object.isFrozen(rule.meta.tags)).toBe(true);
      if (rule.meta.appliesTo) expect(Object.isFrozen(rule.meta.appliesTo)).toBe(true);
      if (rule.meta.references) expect(Object.isFrozen(rule.meta.references)).toBe(true);
    }
  });

  it("freezes a cloned built-in dictionary for the exported pack", () => {
    expect(fairuxBuiltinRulePack.dictionary).not.toBe(dictionary);
    expect(fairuxBuiltinRulePack.dictionary?.en).not.toBe(dictionary.en);
    expect(fairuxBuiltinRulePack.dictionary?.en?.accept).not.toBe(dictionary.en?.accept);
    expect(fairuxBuiltinRulePack.dictionary?.en?.accept?.[0]).not.toBe(dictionary.en?.accept?.[0]);
    expectFrozenDictionary(fairuxBuiltinRulePack.dictionary);
  });

  it("composes with the default dictionary", () => {
    const composed = composeRulePacks([fairuxBuiltinRulePack], { includeExperimental: true });

    expect(composed.rules).toEqual(allRules);
    expect(composed.dictionary).not.toBe(dictionary);
    expect(composed.dictionary.en?.accept).toEqual(dictionary.en?.accept);
  });
});

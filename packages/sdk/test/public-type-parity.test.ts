import type * as Core from "@fairux/core";
import { describe, expect, it } from "vitest";
import type * as Public from "../src/public-types.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

type Assert<T extends true> = T;

type _ReadonlyNonEmptyArray = Assert<
  Equal<Core.ReadonlyNonEmptyArray<string>, Public.ReadonlyNonEmptyArray<string>>
>;
type _RulePack = Assert<Equal<Core.RulePack, Public.RulePack>>;
type _RulePackTaxonomy = Assert<Equal<Core.RulePackTaxonomy, Public.RulePackTaxonomy>>;
type _ComposedTaxonomy = Assert<Equal<Core.ComposedTaxonomy, Public.ComposedTaxonomy>>;
type _ComposedRuleSet = Assert<Equal<Core.ComposedRuleSet, Public.ComposedRuleSet>>;
type _FairuxScanner = Assert<Equal<Core.FairuxScanner, Public.FairuxScanner>>;
type _CreateScannerOptions = Assert<Equal<Core.CreateScannerOptions, Public.CreateScannerOptions>>;
type _UiDocument = Assert<Equal<Core.UiDocument, Public.UiDocument>>;
type _RuleContext = Assert<Equal<Core.RuleContext, Public.RuleContext>>;
type _FairUxReport = Assert<Equal<Core.FairUxReport, Public.FairUxReport>>;

describe("SDK public type parity", () => {
  it("compiles only when mirrored SDK public types match core contracts", () => {
    expect(true).toBe(true);
  });
});

import type {
  CreateScannerOptions as CoreCreateScannerOptions,
  FairUxBatchReport as CoreFairUxBatchReport,
  FairUxReport as CoreFairUxReport,
  FairuxConfig as CoreFairuxConfig,
  FairuxScanner as CoreFairuxScanner,
  Finding as CoreFinding,
  ReadonlyNonEmptyArray as CoreReadonlyNonEmptyArray,
  Rule as CoreRule,
  RuleContext as CoreRuleContext,
  RuleMeta as CoreRuleMeta,
  RulePack as CoreRulePack,
  RulePackMeta as CoreRulePackMeta,
  UiDocument as CoreUiDocument,
  UiNode as CoreUiNode,
} from "@fairux/core";
import type {
  CreateScannerOptions as PublicCreateScannerOptions,
  FairUxBatchReport as PublicFairUxBatchReport,
  FairUxReport as PublicFairUxReport,
  FairuxConfig as PublicFairuxConfig,
  FairuxScanner as PublicFairuxScanner,
  Finding as PublicFinding,
  ReadonlyNonEmptyArray as PublicReadonlyNonEmptyArray,
  Rule as PublicRule,
  RuleContext as PublicRuleContext,
  RuleMeta as PublicRuleMeta,
  RulePack as PublicRulePack,
  RulePackMeta as PublicRulePackMeta,
  UiDocument as PublicUiDocument,
  UiNode as PublicUiNode,
} from "../src/index.js";

type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;
type SameKeys<A, B> = Equal<keyof A, keyof B>;
type SameProperties<A, B> =
  Exclude<
    {
      [K in keyof A & keyof B]: Equal<A[K], B[K]>;
    }[keyof A & keyof B],
    true
  > extends never
    ? true
    : false;
type Assert<T extends true> = T;

type _PublicRuleToCore = Assert<IsAssignable<PublicRule, CoreRule>>;
type _CoreRuleToPublic = Assert<IsAssignable<CoreRule, PublicRule>>;
type _PublicReadonlyNonEmptyArrayToCore = Assert<
  IsAssignable<PublicReadonlyNonEmptyArray<string>, CoreReadonlyNonEmptyArray<string>>
>;
type _CoreReadonlyNonEmptyArrayToPublic = Assert<
  IsAssignable<CoreReadonlyNonEmptyArray<string>, PublicReadonlyNonEmptyArray<string>>
>;
type _PublicRuleMetaToCore = Assert<IsAssignable<PublicRuleMeta, CoreRuleMeta>>;
type _CoreRuleMetaToPublic = Assert<IsAssignable<CoreRuleMeta, PublicRuleMeta>>;
type _PublicRuleContextToCore = Assert<IsAssignable<PublicRuleContext, CoreRuleContext>>;
type _CoreRuleContextToPublic = Assert<IsAssignable<CoreRuleContext, PublicRuleContext>>;
type _PublicPackToCore = Assert<IsAssignable<PublicRulePack, CoreRulePack>>;
type _CorePackToPublic = Assert<IsAssignable<CoreRulePack, PublicRulePack>>;
type _PublicPackMetaToCore = Assert<IsAssignable<PublicRulePackMeta, CoreRulePackMeta>>;
type _CorePackMetaToPublic = Assert<IsAssignable<CoreRulePackMeta, PublicRulePackMeta>>;
type _PublicUiNodeToCore = Assert<IsAssignable<PublicUiNode, CoreUiNode>>;
type _CoreUiNodeToPublic = Assert<IsAssignable<CoreUiNode, PublicUiNode>>;
type _PublicUiDocumentToCore = Assert<IsAssignable<PublicUiDocument, CoreUiDocument>>;
type _CoreUiDocumentToPublic = Assert<IsAssignable<CoreUiDocument, PublicUiDocument>>;
type _PublicFindingToCore = Assert<IsAssignable<PublicFinding, CoreFinding>>;
type _CoreFindingToPublic = Assert<IsAssignable<CoreFinding, PublicFinding>>;
type _PublicReportToCore = Assert<IsAssignable<PublicFairUxReport, CoreFairUxReport>>;
type _CoreReportToPublic = Assert<IsAssignable<CoreFairUxReport, PublicFairUxReport>>;
type _PublicBatchReportToCore = Assert<
  IsAssignable<PublicFairUxBatchReport, CoreFairUxBatchReport>
>;
type _CoreBatchReportToPublic = Assert<
  IsAssignable<CoreFairUxBatchReport, PublicFairUxBatchReport>
>;
type _PublicCreateScannerOptionsToCore = Assert<
  IsAssignable<PublicCreateScannerOptions, CoreCreateScannerOptions>
>;
type _CoreCreateScannerOptionsToPublic = Assert<
  IsAssignable<CoreCreateScannerOptions, PublicCreateScannerOptions>
>;
type _PublicScannerToCore = Assert<IsAssignable<PublicFairuxScanner, CoreFairuxScanner>>;
type _CoreScannerToPublic = Assert<IsAssignable<CoreFairuxScanner, PublicFairuxScanner>>;
type _PublicConfigToCore = Assert<IsAssignable<PublicFairuxConfig, CoreFairuxConfig>>;
type _CoreConfigToPublic = Assert<IsAssignable<CoreFairuxConfig, PublicFairuxConfig>>;

type _RuleKeys = Assert<SameKeys<PublicRule, CoreRule>>;
type _RuleProperties = Assert<SameProperties<PublicRule, CoreRule>>;
type _RuleMetaKeys = Assert<SameKeys<PublicRuleMeta, CoreRuleMeta>>;
type _RuleMetaProperties = Assert<SameProperties<PublicRuleMeta, CoreRuleMeta>>;
type _RuleContextKeys = Assert<SameKeys<PublicRuleContext, CoreRuleContext>>;
type _RuleContextProperties = Assert<SameProperties<PublicRuleContext, CoreRuleContext>>;
type _PackKeys = Assert<SameKeys<PublicRulePack, CoreRulePack>>;
type _PackProperties = Assert<SameProperties<PublicRulePack, CoreRulePack>>;
type _PackMetaKeys = Assert<SameKeys<PublicRulePackMeta, CoreRulePackMeta>>;
type _PackMetaProperties = Assert<SameProperties<PublicRulePackMeta, CoreRulePackMeta>>;
type _UiNodeKeys = Assert<SameKeys<PublicUiNode, CoreUiNode>>;
type _UiNodeProperties = Assert<SameProperties<PublicUiNode, CoreUiNode>>;
type _UiDocumentKeys = Assert<SameKeys<PublicUiDocument, CoreUiDocument>>;
type _UiDocumentProperties = Assert<SameProperties<PublicUiDocument, CoreUiDocument>>;
type _FindingKeys = Assert<SameKeys<PublicFinding, CoreFinding>>;
type _FindingProperties = Assert<SameProperties<PublicFinding, CoreFinding>>;
type _ReportKeys = Assert<SameKeys<PublicFairUxReport, CoreFairUxReport>>;
type _ReportProperties = Assert<SameProperties<PublicFairUxReport, CoreFairUxReport>>;
type _BatchReportKeys = Assert<SameKeys<PublicFairUxBatchReport, CoreFairUxBatchReport>>;
type _BatchReportProperties = Assert<
  SameProperties<PublicFairUxBatchReport, CoreFairUxBatchReport>
>;
type _CreateScannerOptionsKeys = Assert<
  SameKeys<PublicCreateScannerOptions, CoreCreateScannerOptions>
>;
type _CreateScannerOptionsProperties = Assert<
  SameProperties<PublicCreateScannerOptions, CoreCreateScannerOptions>
>;
type _ScannerKeys = Assert<SameKeys<PublicFairuxScanner, CoreFairuxScanner>>;
type _ScannerProperties = Assert<SameProperties<PublicFairuxScanner, CoreFairuxScanner>>;
type _ConfigKeys = Assert<SameKeys<PublicFairuxConfig, CoreFairuxConfig>>;
type _ConfigProperties = Assert<SameProperties<PublicFairuxConfig, CoreFairuxConfig>>;

type _PublicEvaluateParamsToCore = Assert<
  IsAssignable<Parameters<PublicRule["evaluate"]>, Parameters<CoreRule["evaluate"]>>
>;
type _CoreEvaluateParamsToPublic = Assert<
  IsAssignable<Parameters<CoreRule["evaluate"]>, Parameters<PublicRule["evaluate"]>>
>;
type _PublicEvaluateReturnToCore = Assert<
  IsAssignable<ReturnType<PublicRule["evaluate"]>, ReturnType<CoreRule["evaluate"]>>
>;
type _CoreEvaluateReturnToPublic = Assert<
  IsAssignable<ReturnType<CoreRule["evaluate"]>, ReturnType<PublicRule["evaluate"]>>
>;
type _PublicScanParamsToCore = Assert<
  IsAssignable<Parameters<PublicFairuxScanner["scan"]>, Parameters<CoreFairuxScanner["scan"]>>
>;
type _CoreScanParamsToPublic = Assert<
  IsAssignable<Parameters<CoreFairuxScanner["scan"]>, Parameters<PublicFairuxScanner["scan"]>>
>;
type _PublicScanReturnToCore = Assert<
  IsAssignable<ReturnType<PublicFairuxScanner["scan"]>, ReturnType<CoreFairuxScanner["scan"]>>
>;
type _CoreScanReturnToPublic = Assert<
  IsAssignable<ReturnType<CoreFairuxScanner["scan"]>, ReturnType<PublicFairuxScanner["scan"]>>
>;

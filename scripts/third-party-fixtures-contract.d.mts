export declare const ALLOWED_LICENCES: readonly string[];
export declare const REQUIRED_FIELDS: readonly string[];

export declare function fixturePathProblem(file: unknown, corpusDir: string): string | null;
export declare function reductionProblems(html: string): string[];
export declare function renderNotice(
  provenance: {
    readonly allowedLicenses?: readonly string[];
    readonly reduction: { readonly rules: readonly string[] };
    readonly fixtures: readonly Record<string, string>[];
  },
  licenceTexts: ReadonlyMap<string, string>,
): string;
export declare function thirdPartyFixtureFailures(corpusDir: string): string[];

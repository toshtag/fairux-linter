export declare const RELEASE_VIEW_FIELDS: readonly ["tagName", "isDraft", "isPrerelease"];

export interface GithubReleaseContract {
  /**
   * Decide whether an existing GitHub Release may be repaired in place.
   *
   * Repair covers notes, title, and assets. It does not cover classification: `gh release edit`
   * cannot clear a prerelease flag, and flipping it would be a publication decision rather than a
   * repair.
   *
   * @returns failures; empty means the Release is already classified as this release requires
   */
  auditExistingRelease(input: {
    expectedTag: string;
    expectedPrerelease: boolean;
    release: unknown;
  }): string[];
}

/** Bind the contract to the runbook its refusals send a reader to. */
export declare function createGithubReleaseContract(binding: {
  runbook: string;
}): GithubReleaseContract;

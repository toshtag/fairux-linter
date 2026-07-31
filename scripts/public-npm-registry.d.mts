export declare const PUBLIC_NPM_REGISTRY: string;
export declare const FAIRUX_NPM_SCOPE: string;
export declare function registryArgsForScope(
  registry: string,
  scope: string,
  options?: { preferOnline?: boolean },
): readonly string[];
export declare const NPM_SDK_VIEW_REGISTRY_ARGS: readonly string[];
export declare const NPM_SDK_PUBLISH_REGISTRY_ARGS: readonly string[];
export declare const NPM_SDK_INSTALL_REGISTRY_ARGS: readonly string[];

/** `fairux` is unscoped: `--registry` alone, with no scope key that npm would resolve first. */
export declare const NPM_CLI_VIEW_REGISTRY_ARGS: readonly string[];
export declare const NPM_CLI_PUBLISH_REGISTRY_ARGS: readonly string[];

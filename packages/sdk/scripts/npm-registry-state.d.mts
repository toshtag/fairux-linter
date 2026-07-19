export type NpmRegistryState =
  | { status: "absent" }
  | {
      status: "present";
      version: string;
      shasum: string;
      integrity: string;
    }
  | { status: "unavailable"; reason: string };

export function getNpmRegistryState(
  spec: string,
  options?: {
    run?: (command: string, args: string[]) => string;
  },
): NpmRegistryState;

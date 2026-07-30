export declare function consumerSmokeFixtureNames(profile: string): string[];
export interface RegistryConsumerContract {
  id: "sdk-registry-consumer-v1";
  minimumSdkVersion: "0.1.0-beta.2";
  files: readonly string[];
  contentSha256: string;
}
export declare function validateRegistryConsumerContract(
  fixtureDir?: string,
): RegistryConsumerContract;
export declare function runConsumerSmoke(options?: {
  work?: string;
  expectedVersion?: string;
  profile?: "release" | "registry-consumer";
}): void;

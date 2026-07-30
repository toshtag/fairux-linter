export declare function consumerSmokeFixtureNames(profile: string): string[];
export declare function runConsumerSmoke(options?: {
  work?: string;
  expectedVersion?: string;
  profile?: "release" | "registry-consumer";
}): void;

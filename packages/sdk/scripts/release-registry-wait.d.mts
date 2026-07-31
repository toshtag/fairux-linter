export type {
  RegistryReadContext,
  RegistryReader,
  RegistryReadTimeoutSignal,
  RegistryWaitAttempt,
  RegistryWaitFailureReason,
} from "../../../scripts/release-registry-wait.d.mts";

export {
  REGISTRY_WAIT_DELAYS_MS,
  REGISTRY_WAIT_FAILURES,
  REGISTRY_WAIT_MAX_ELAPSED_MS,
  RegistryWaitError,
  waitForRegistryVersion,
} from "../../../scripts/release-registry-wait.d.mts";

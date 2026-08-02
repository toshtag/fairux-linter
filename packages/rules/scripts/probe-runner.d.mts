type Behaviour = Record<string, Record<string, number>>;

/** Behaviour over the frozen probe set, scanned with the built packages from `root`. */
export function measureProbeBehaviour(root: string): Promise<Behaviour>;

/**
 * The same measurement, over modules the caller supplies.
 *
 * `root` defaults to this repository, so a caller compiled without Node type definitions can still
 * measure. The modules are `unknown` here because the two callers hold different shapes of the same
 * packages — the built entry points and the sources — and narrowing to one would reject the other.
 */
export function measureProbeBehaviourWith(input: {
  readonly root?: string;
  readonly core: unknown;
  readonly html: unknown;
  readonly rules: unknown;
}): Behaviour;

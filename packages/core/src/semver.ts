const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

interface ParsedSemver {
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
  readonly prerelease?: readonly string[];
}

export function isSemver(value: string): boolean {
  return SEMVER_RE.test(value);
}

function parseSemver(value: string): ParsedSemver {
  const match = SEMVER_RE.exec(value);
  if (!match) throw new Error(`invalid semver: ${value}`);
  return {
    major: match[1] as string,
    minor: match[2] as string,
    patch: match[3] as string,
    prerelease: match[4]?.split("."),
  };
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function comparePrerelease(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^(0|[1-9]\d*)$/.test(a);
    const bNumeric = /^(0|[1-9]\d*)$/.test(b);
    if (aNumeric && bNumeric) {
      const diff = compareNumericIdentifier(a, b);
      if (diff !== 0) return diff;
      continue;
    }
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  const major = compareNumericIdentifier(a.major, b.major);
  if (major !== 0) return major;
  const minor = compareNumericIdentifier(a.minor, b.minor);
  if (minor !== 0) return minor;
  const patch = compareNumericIdentifier(a.patch, b.patch);
  if (patch !== 0) return patch;
  return comparePrerelease(a.prerelease, b.prerelease);
}

import { describe, expect, it } from "vitest";
import type { FingerprintParts } from "../src/index.js";
import { buildFingerprint, deriveTextHint, fnv1a64, majorVersion } from "../src/index.js";

describe("fnv1a64", () => {
  it("is deterministic", () => {
    expect(fnv1a64("hello")).toBe(fnv1a64("hello"));
  });

  it("differs for different input", () => {
    expect(fnv1a64("hello")).not.toBe(fnv1a64("hellp"));
  });

  it("returns 16 lowercase hex chars", () => {
    expect(fnv1a64("anything")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("handles Japanese input without losing information", () => {
    expect(fnv1a64("無料体験")).toMatch(/^[0-9a-f]{16}$/);
    expect(fnv1a64("無料体験")).not.toBe(fnv1a64("自動更新"));
  });
});

describe("majorVersion", () => {
  it("extracts the semver major", () => {
    expect(majorVersion("1.2.3")).toBe("1");
    expect(majorVersion("12.0.0")).toBe("12");
  });

  it("falls back to 0 for non-semver input", () => {
    expect(majorVersion("v1")).toBe("0");
    expect(majorVersion("")).toBe("0");
  });
});

describe("deriveTextHint", () => {
  it("normalizes the text", () => {
    expect(deriveTextHint("  Free Trial  ")).toBe("free trial");
  });

  it("is stable under edits beyond the 48-char window", () => {
    const base = "a".repeat(48);
    expect(deriveTextHint(`${base}EXTRA`)).toBe(deriveTextHint(base));
  });
});

describe("buildFingerprint", () => {
  const parts: FingerprintParts = {
    ruleId: "consent/checked-checkbox",
    category: "consent",
    locator: { type: "css", value: "#newsletter" },
    textHint: "subscribe to our newsletter",
    ruleVersionMajor: "1",
  };

  it("is stable for identical parts", () => {
    expect(buildFingerprint(parts)).toBe(buildFingerprint({ ...parts }));
  });

  it("changes when the rule id changes", () => {
    expect(buildFingerprint(parts)).not.toBe(
      buildFingerprint({ ...parts, ruleId: "consent/other" }),
    );
  });

  it("changes when the major version changes", () => {
    expect(buildFingerprint(parts)).not.toBe(buildFingerprint({ ...parts, ruleVersionMajor: "2" }));
  });

  it("ignores the locator when absent on both sides", () => {
    const a = buildFingerprint({ ...parts, locator: undefined });
    const b = buildFingerprint({ ...parts, locator: undefined });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not accept a source line as input (cross-runtime portability contract)", () => {
    // Source line is intentionally excluded so static-HTML and DOM findings on the same element
    // share a fingerprint. Passing an extra `sourceStartLine` must not change the result.
    const withSource = buildFingerprint({
      ...parts,
      ...({ sourceStartLine: 99 } as Record<string, unknown>),
    });
    expect(withSource).toBe(buildFingerprint(parts));
  });
});

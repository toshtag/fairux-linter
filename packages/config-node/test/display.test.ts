import { describe, expect, it } from "vitest";
import { sanitizeSingleLineDisplay } from "../src/index.js";

describe("sanitizeSingleLineDisplay", () => {
  it("normalizes line breaks and strips terminal and bidi controls", () => {
    const esc = String.fromCharCode(0x1b);
    const rlo = String.fromCharCode(0x202e);
    const malicious = `unknown\n[FairUX] Config error: forged${esc}[31m${rlo}`;

    const result = sanitizeSingleLineDisplay(malicious);

    expect(result).not.toContain("\n");
    expect(result).not.toContain("\r");
    expect(result).not.toContain(esc);
    expect(result).not.toContain(rlo);
    expect(result).toContain("unknown");
    expect(result).toContain("forged");
    expect(result).toBe("unknown [FairUX] Config error: forged[31m");
  });

  it("uses Error messages and removes C1 controls", () => {
    const c1 = String.fromCharCode(0x85);
    expect(sanitizeSingleLineDisplay(new Error(`bad${c1}message`))).toBe("badmessage");
  });
});

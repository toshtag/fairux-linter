import { fairuxBuiltinRulePack } from "@fairux/sdk";
import { createDomScanner } from "@fairux/sdk/dom";

const scanner = createDomScanner({
  rulePacks: [fairuxBuiltinRulePack],
  now: () => new Date("2026-01-01T00:00:00Z"),
});

export function scanCurrentDocument(): { findings: number; reused: boolean; toolVersion: string } {
  const first = scanner.scan(document);
  const second = scanner.scan(document);
  return {
    findings: first.findings.length + second.findings.length,
    reused: true,
    toolVersion: first.toolVersion,
  };
}

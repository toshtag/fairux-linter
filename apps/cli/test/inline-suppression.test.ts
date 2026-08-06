import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FairUxReport } from "@fairux/core";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");

function scan(contents: string, extension: string): FairUxReport {
  const dir = mkdtempSync(join(tmpdir(), "fairux-inline-"));
  try {
    const file = join(dir, `page${extension}`);
    writeFileSync(file, contents, "utf8");
    return JSON.parse(
      execFileSync("node", [cliBin, "scan", file, "--format", "json", "--ignore-config"], {
        encoding: "utf8",
        timeout: 20000,
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * End to end, through the adapters that had to start carrying comments. The directive grammar is
 * covered in `@fairux/core`; what these check is that a comment written the way a user writes it
 * actually reaches the engine, in each language that has both comments and line numbers.
 */
describe("fairux-disable-next-line in HTML", () => {
  it("accepts the finding on the next line, with its reason recorded", () => {
    const report = scan(
      `<html><body>
<!-- fairux-disable-next-line scarcity/scarcity-phrase -- stock count is live -->
<p>Only 2 left in stock!</p>
<label><input type="checkbox" checked> Email me offers</label>
</body></html>`,
      ".html",
    );
    expect(report.findings.map((finding) => finding.ruleId)).toEqual(["consent/checked-checkbox"]);
    expect(report.suppressed).toEqual([
      {
        ruleId: "scarcity/scarcity-phrase",
        reason: "stock count is live",
        line: 2,
        // The identity of the finding that was removed. The rule and the line say which directive
        // fired; two identical inputs on one line are two findings of one rule, and this is the
        // only thing a reader — or a baseline — can match the accepted one on.
        fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
      },
    ]);
    // The summary is the post-suppression count, not the pre-suppression one.
    expect(report.summary.total).toBe(report.findings.length);
  });

  it("refuses a directive with no reason, and leaves the finding in place", () => {
    // Loudly, because a malformed directive that silently suppressed nothing would leave a user
    // believing a finding was accepted when it was not.
    const report = scan(
      `<html><body>
<!-- fairux-disable-next-line scarcity/scarcity-phrase -->
<p>Only 2 left in stock!</p>
</body></html>`,
      ".html",
    );
    expect(report.findings.map((finding) => finding.ruleId)).toContain("scarcity/scarcity-phrase");
    expect(report.suppressed).toBeUndefined();
    expect(report.suppressionDiagnostics?.[0]).toMatchObject({ kind: "malformed", line: 2 });
  });

  it("reports a directive that matched nothing", () => {
    const report = scan(
      `<html><body>
<!-- fairux-disable-next-line scarcity/scarcity-phrase -- was deliberate -->
<p>Nothing to see.</p>
</body></html>`,
      ".html",
    );
    expect(report.suppressionDiagnostics?.[0]).toMatchObject({ kind: "unused" });
  });

  it("leaves a report with no directives byte-identical to before", () => {
    // Both fields are absent, not empty: a consumer that never uses this feature sees no change.
    const report = scan("<html><body><p>Only 2 left in stock!</p></body></html>", ".html");
    expect(report).not.toHaveProperty("suppressed");
    expect(report).not.toHaveProperty("suppressionDiagnostics");
  });
});

describe("fairux-disable-next-line in JSX", () => {
  it("reads the braced comment form JSX users actually write", () => {
    // `{/* … */}` is a JsxExpression with no expression; the comment inside it never becomes a node,
    // and TypeScript classifies it as *trailing* trivia of the opening brace. Both facts had to be
    // handled for this to work at all.
    const report = scan(
      `export const C = () => (
  <div role="dialog">
    <p>We use cookies.</p>
    {/* fairux-disable-next-line consent/missing-reject-option -- reject lives in the footer */}
    <button>Accept</button>
  </div>
);
`,
      ".tsx",
    );
    expect(report.suppressed).toEqual([
      {
        ruleId: "consent/missing-reject-option",
        reason: "reject lives in the footer",
        line: 4,
        fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
      },
    ]);
    expect(report.findings.map((finding) => finding.ruleId)).not.toContain(
      "consent/missing-reject-option",
    );
  });

  it("still requires a reason in JSX", () => {
    const report = scan(
      `export const C = () => (
  <div role="dialog">
    <p>We use cookies.</p>
    {/* fairux-disable-next-line consent/missing-reject-option */}
    <button>Accept</button>
  </div>
);
`,
      ".tsx",
    );
    expect(report.findings.map((finding) => finding.ruleId)).toContain(
      "consent/missing-reject-option",
    );
    expect(report.suppressionDiagnostics?.[0]?.kind).toBe("malformed");
  });
});

/**
 * Scanning the probe pages, for whoever needs the behaviour digest.
 *
 * One place, because two callers need it — the approval check and the approval writer — and two
 * copies of "how a probe is scanned" would be two ways for the same digest to come out different.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { measureBehaviour } from "./behaviour-probe.mjs";

/**
 * The repository root, resolved here rather than by the caller.
 *
 * `@fairux/rules` compiles without Node type definitions on purpose — the package has to stay
 * browser-safe — so a test in it cannot name a path. Defaulting here keeps that discipline without
 * giving the test a second way to measure.
 */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Behaviour over the frozen probe set, scanned with the built packages.
 *
 * Deterministic on purpose: a fixed clock and no rule-pack options, so the only thing that can move
 * the result is the rules.
 */
export async function measureProbeBehaviour(root) {
  return measureProbeBehaviourWith({
    root,
    core: await import(pathToFileURL(join(root, "packages/core/dist/index.js")).href),
    html: await import(pathToFileURL(join(root, "packages/html/dist/index.js")).href),
    rules: await import(pathToFileURL(join(root, "packages/rules/dist/index.js")).href),
  });
}

/**
 * The same measurement, over modules the caller supplies.
 *
 * One implementation, because a test reads the sources and a workflow reads the build, and two
 * copies of "how a probe is scanned" would be two ways for the same digest to come out different —
 * which reads as "detection changed" when nothing did.
 */
export function measureProbeBehaviourWith({ root = ROOT, core, html, rules }) {
  const manifest = JSON.parse(readFileSync(join(root, "corpus/manifest.json"), "utf8"));
  const fileById = new Map(manifest.cases.map((entry) => [entry.id, entry.file]));

  const scanner = core.createScanner({
    rulePacks: [rules.fairuxBuiltinRulePack],
    includeExperimental: false,
    toolVersion: "behaviour-probe",
    now: () => new Date("1970-01-01T00:00:00.000Z"),
  });

  return measureBehaviour((caseId) => {
    const file = fileById.get(caseId);
    // A probe naming a page that is gone would otherwise silently contribute nothing, shrinking what
    // an approval covers without anybody deciding to.
    if (!file)
      throw new Error(`behaviour probe names a corpus case that no longer exists: ${caseId}`);
    const source = readFileSync(join(root, "corpus", file), "utf8");
    return scanner.scan(html.parseHtml(source, { file })).findings;
  });
}

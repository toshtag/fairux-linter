/**
 * The corpus pages, for a test that cannot name a path.
 *
 * `@fairux/dom` compiles without Node type definitions on purpose — the package has to stay
 * browser-safe — so the filesystem access lives here, untyped, the way `probe-runner.mjs` does it in
 * `@fairux/rules`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Every case in the manifest, as `{ id, source }`, in manifest order. */
export function readCorpusPages() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "corpus/manifest.json"), "utf8"));
  return manifest.cases.map((entry) => ({
    id: entry.id,
    source: readFileSync(join(ROOT, "corpus", entry.file), "utf8"),
  }));
}

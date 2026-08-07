import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNBOOKS = ["docs/maintainers/release-sdk.md", "docs/maintainers/release-cli.md"] as const;

/**
 * A checksum record is not a copy of the thing it records.
 *
 * `release-sha256.txt` is 90–94 bytes of `<sha256>␣␣<filename>`. What a closeout can prove is that
 * two tarballs hash to the same 32 bytes and that this file records that value. What it cannot
 * prove — because nothing measured it — is anything about the file's own bytes.
 *
 * Two closeout records said otherwise. `0.1.0-beta.2`'s put "the Release asset, the tarball, and the
 * value recorded in `release-sha256.txt`" in one list and called all three "the same 32 bytes",
 * which describes a 181818-byte archive as 32 bytes. `0.1.0-beta.1`'s said the registry tarball was
 * "byte-identical to the Release asset **and to** `release-sha256.txt`". `0.1.0-beta.3`'s record had
 * it right all along, separating "tarballs whose bytes were hashed" from "a value read out of a
 * file"; the later ones drifted from a correct form sitting in the same document.
 *
 * This pins the distinction and not the prose. It forbids the one sentence shape that erases it, and
 * requires each record to say the file's own digest was not measured. How the rest is worded is a
 * writer's business.
 */
describe("a checksum record is never described as a copy of the tarball", () => {
  for (const path of RUNBOOKS) {
    const text = readFileSync(join(ROOT, path), "utf8");
    /** Sentences, so a claim split across two lines is still one claim. */
    const sentences = text.replace(/\n/g, " ").split(/(?<=\.)\s+/);

    it(`${path} does not put release-sha256.txt among things that are the same bytes`, () => {
      const offending = sentences.filter(
        (sentence) =>
          sentence.includes("release-sha256.txt") &&
          /same 32 bytes|byte-identical|same bytes/.test(sentence) &&
          // The correction itself quotes the phrasing it replaced, and says so.
          !/replaced|used to claim|not a third copy|equals the digest/.test(sentence),
      );
      expect(offending, offending.join(" | ")).toEqual([]);
    });

    it(`${path} states the limit rather than leaving a reader to assume it`, () => {
      // A runbook that names the file has to say what nobody measured about it, or the next reader
      // supplies the missing claim themselves — which is how both drifted in the first place.
      expect(text).toMatch(/[Ii]ts own digest was not measured/);
    });
  }
});

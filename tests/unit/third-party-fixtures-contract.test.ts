import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALLOWED_LICENCES,
  fixturePathProblem,
  reductionProblems,
  thirdPartyFixtureFailures,
} from "../../scripts/third-party-fixtures-contract.mjs";

/**
 * The refusals that make a third-party corpus page redistributable, checked where they can fail.
 *
 * Three of these are regression tests in the strict sense: the first version of this check passed
 * them, an external review demonstrated each one, and the file they guard is a licensed copy of
 * somebody else's work. A gate that reports "licensed, attributed, reduced, and unedited" while
 * accepting an unregistered file with a tracking pixel in it is worse than no gate, because the
 * sentence is what anybody downstream would rely on.
 *
 * Every case builds a temporary corpus from the real one and changes one thing, so a passing test
 * says the check refuses that thing rather than that it refuses this repository's current contents.
 */

const REAL_CORPUS = resolve(import.meta.dirname, "../../corpus");
const temporaries: string[] = [];

/** The real corpus, copied so one thing can be changed in it. */
function corpusCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "fairux-third-party-"));
  temporaries.push(dir);
  cpSync(REAL_CORPUS, join(dir, "corpus"), { recursive: true });
  return join(dir, "corpus");
}

function readProvenance(corpus: string) {
  return JSON.parse(readFileSync(join(corpus, "third-party/provenance.json"), "utf8"));
}

function writeProvenance(corpus: string, provenance: unknown): void {
  writeFileSync(
    join(corpus, "third-party/provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
}

/** Rewrite a fixture and keep its recorded hash correct, so only the intended thing is wrong. */
function replaceFixture(corpus: string, index: number, html: string): void {
  const provenance = readProvenance(corpus);
  const fixture = provenance.fixtures[index];
  writeFileSync(join(corpus, fixture.file), html);
  fixture.reducedSha256 = createHash("sha256").update(html).digest("hex");
  writeProvenance(corpus, provenance);
}

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the third-party corpus as it is", () => {
  it("passes", () => {
    expect(thirdPartyFixtureFailures(REAL_CORPUS)).toEqual([]);
  });

  it("is checked against a licence policy that lives in code, not in the file being checked", () => {
    const provenance = readProvenance(REAL_CORPUS);
    expect([...provenance.allowedLicenses].sort()).toEqual([...ALLOWED_LICENCES]);
    expect(ALLOWED_LICENCES).not.toContain("CC-BY-4.0");
  });
});

describe("licences", () => {
  it("refuses a licence the provenance file adds to its own allowed list", () => {
    // The bypass as demonstrated: widening the policy and using the widened value were one edit.
    const corpus = corpusCopy();
    const provenance = readProvenance(corpus);
    provenance.allowedLicenses.push("Proprietary");
    provenance.fixtures[0].licenseSpdx = "Proprietary";
    writeProvenance(corpus, provenance);

    const failures = thirdPartyFixtureFailures(corpus);
    expect(failures.join("\n")).toContain("does not match the policy");
    expect(failures.join("\n")).toContain('"Proprietary" is not one of');
  });

  it("refuses a licence outside the policy even when the declared list is untouched", () => {
    const corpus = corpusCopy();
    const provenance = readProvenance(corpus);
    provenance.fixtures[0].licenseSpdx = "GPL-3.0-only";
    writeProvenance(corpus, provenance);
    expect(thirdPartyFixtureFailures(corpus).join("\n")).toContain("GPL-3.0-only");
  });

  it("refuses a fixture whose licence text is missing", () => {
    const corpus = corpusCopy();
    const provenance = readProvenance(corpus);
    rmSync(join(corpus, "third-party/licenses", provenance.fixtures[0].licenseNoticeFile));
    expect(thirdPartyFixtureFailures(corpus).join("\n")).toContain("is not stored here");
  });

  it("refuses a licence text that does not hash to what provenance records", () => {
    const corpus = corpusCopy();
    const provenance = readProvenance(corpus);
    const path = join(corpus, "third-party/licenses", provenance.fixtures[0].licenseNoticeFile);
    writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
    expect(thirdPartyFixtureFailures(corpus).join("\n")).toMatch(/licence text .* is [0-9a-f]{64}/);
  });

  it("refuses a licence text with no permission notice in it", () => {
    // A copyright line alone is what the hand-written notice used to carry, and MIT asks for both.
    const corpus = corpusCopy();
    const provenance = readProvenance(corpus);
    const name = provenance.fixtures[0].licenseNoticeFile;
    const stub = "MIT License\n\nCopyright (c) 2025 Somebody\n";
    writeFileSync(join(corpus, "third-party/licenses", name), stub);
    for (const fixture of provenance.fixtures) {
      if (fixture.licenseNoticeFile !== name) continue;
      fixture.licenseNoticeSha256 = createHash("sha256").update(stub).digest("hex");
    }
    writeProvenance(corpus, provenance);
    expect(thirdPartyFixtureFailures(corpus).join("\n")).toContain("carries no permission notice");
  });

  it("refuses a licenseNoticeFile that points outside the licences directory", () => {
    const corpus = corpusCopy();
    const provenance = readProvenance(corpus);
    provenance.fixtures[0].licenseNoticeFile = "../../../package.json";
    writeProvenance(corpus, provenance);
    expect(thirdPartyFixtureFailures(corpus).join("\n")).toContain("is not a bare file name");
  });
});

describe("disk, provenance and manifest are one set", () => {
  it("refuses an HTML file that exists only on disk", () => {
    // The bypass as demonstrated: orphans were enumerated from the manifest, so a file registered
    // nowhere was never looked at — and biome.json excludes this directory too.
    const corpus = corpusCopy();
    writeFileSync(
      join(corpus, "third-party/unregistered-third-party.html"),
      "<!doctype html><html><body><p>from somewhere</p></body></html>\n",
    );
    expect(thirdPartyFixtureFailures(corpus).join("\n")).toContain(
      "third-party/unregistered-third-party.html: on disk with no provenance record",
    );
  });

  it("refuses a fixture recorded in provenance but absent from disk", () => {
    const corpus = corpusCopy();
    rmSync(join(corpus, readProvenance(corpus).fixtures[0].file));
    expect(thirdPartyFixtureFailures(corpus).join("\n")).toContain("recorded but not on disk");
  });

  it("refuses a manifest case with no provenance record", () => {
    const corpus = corpusCopy();
    const manifest = JSON.parse(readFileSync(join(corpus, "manifest.json"), "utf8"));
    manifest.cases.push({
      id: "thirdparty-invented",
      file: "third-party/invented.html",
      locale: "en",
      summary: "Registered for evaluation and licensed by nobody.",
      expected: [],
    });
    writeFileSync(join(corpus, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    expect(thirdPartyFixtureFailures(corpus).join("\n")).toContain(
      "third-party/invented.html: in the corpus manifest with no provenance record",
    );
  });

  it("refuses the same file registered twice", () => {
    const corpus = corpusCopy();
    const provenance = readProvenance(corpus);
    provenance.fixtures.push({ ...provenance.fixtures[0], caseId: "thirdparty-other" });
    writeProvenance(corpus, provenance);
    expect(thirdPartyFixtureFailures(corpus).join("\n")).toContain(
      "registered twice in provenance",
    );
  });

  it("refuses the same caseId registered twice", () => {
    const corpus = corpusCopy();
    const provenance = readProvenance(corpus);
    provenance.fixtures.push({
      ...provenance.fixtures[1],
      caseId: provenance.fixtures[0].caseId,
    });
    writeProvenance(corpus, provenance);
    expect(thirdPartyFixtureFailures(corpus).join("\n")).toMatch(/caseId \S+ is registered twice/);
  });
});

describe("fixture paths cannot leave the directory", () => {
  it.each([
    "third-party/../README.md",
    "third-party/../../package.json",
    "third-party/nested/page.html",
    "/etc/passwd",
    "third-party/page.txt",
  ])("refuses %s", (file) => {
    expect(fixturePathProblem(file, REAL_CORPUS)).not.toBeNull();
  });

  it("accepts an ordinary fixture path", () => {
    expect(fixturePathProblem("third-party/tabler-alert-en.html", REAL_CORPUS)).toBeNull();
  });

  it("refuses a traversing path through the whole check", () => {
    const corpus = corpusCopy();
    const provenance = readProvenance(corpus);
    provenance.fixtures[0].file = "third-party/../README.md";
    writeProvenance(corpus, provenance);
    expect(thirdPartyFixtureFailures(corpus).join("\n")).toContain("is not of the form");
  });
});

describe("reduction is checked as syntax, not as text", () => {
  it.each([
    ['<img src="https://example.com/tracker">', "quoted absolute URL"],
    ["<img src=https://example.com/tracker>", "unquoted absolute URL"],
    ["<img SRC = HTTPS://EXAMPLE.COM/t>", "uppercase and spaced"],
    ['<img src="//example.com/tracker">', "protocol-relative URL"],
    ['<a href="https://example.com/">x</a>', "absolute link target"],
    ['<div onclick="steal()">x</div>', "inline event handler"],
    ["<script>1</script>", "script element"],
    ['<iframe src="/x"></iframe>', "iframe element"],
    ['<link rel="stylesheet" href="/x.css">', "link element"],
    ['<form action="/submit"></form>', "form action"],
  ])("refuses %s (%s)", (markup) => {
    expect(reductionProblems(`<!doctype html><html><body>${markup}</body></html>`)).not.toEqual([]);
  });

  it("accepts the markup a reduced page is allowed to keep", () => {
    const kept = [
      '<button type="button" aria-label="Close">×</button>',
      '<a href="#">Cancel</a>',
      '<input id="e" type="checkbox" checked disabled>',
      '<label for="e">Email me</label>',
      '<img alt="A logo">',
      '<div role="dialog" style="display: none">x</div>',
    ].join("");
    expect(reductionProblems(`<!doctype html><html><body>${kept}</body></html>`)).toEqual([]);
  });

  it("refuses an unquoted tracker through the whole check", () => {
    // The bypass as demonstrated: the pattern required quotes, and HTML does not.
    const corpus = corpusCopy();
    replaceFixture(
      corpus,
      0,
      "<!doctype html><html><body><img src=https://example.com/tracker></body></html>\n",
    );
    expect(thirdPartyFixtureFailures(corpus).join("\n")).toContain("still contains");
  });
});

describe("fixtures cannot be edited", () => {
  it("refuses content that does not hash to what provenance records", () => {
    const corpus = corpusCopy();
    const file = readProvenance(corpus).fixtures[0].file;
    writeFileSync(
      join(corpus, file),
      `${readFileSync(join(corpus, file), "utf8")}<!-- edited -->\n`,
    );
    expect(thirdPartyFixtureFailures(corpus).join("\n")).toMatch(/content is [0-9a-f]{64}/);
  });

  it("refuses modifiedForDetection being anything but false", () => {
    const corpus = corpusCopy();
    const provenance = readProvenance(corpus);
    provenance.fixtures[0].modifiedForDetection = true;
    writeProvenance(corpus, provenance);
    expect(thirdPartyFixtureFailures(corpus).join("\n")).toContain(
      "modifiedForDetection must be false",
    );
  });

  it("refuses a source commit that could move", () => {
    const corpus = corpusCopy();
    const provenance = readProvenance(corpus);
    provenance.fixtures[0].sourceCommit = "main";
    writeProvenance(corpus, provenance);
    expect(thirdPartyFixtureFailures(corpus).join("\n")).toContain("full 40-character SHA");
  });
});

describe("the notice is generated, not asserted", () => {
  it("refuses a notice edited by hand", () => {
    const corpus = corpusCopy();
    const path = join(corpus, "third-party/THIRD_PARTY_NOTICE.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("デジタル庁", "Somebody Else"));
    expect(thirdPartyFixtureFailures(corpus).join("\n")).toContain(
      "disagrees with provenance.json",
    );
  });

  it("refuses a notice that has fallen behind provenance", () => {
    const corpus = corpusCopy();
    const provenance = readProvenance(corpus);
    provenance.fixtures[0].copyrightHolder = "A Different Holder";
    writeProvenance(corpus, provenance);
    expect(thirdPartyFixtureFailures(corpus).join("\n")).toContain(
      "disagrees with provenance.json",
    );
  });
});

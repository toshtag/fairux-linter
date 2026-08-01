import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Pins the publish workflows to the configuration that lets npm Trusted Publishing work, and to
 * the privilege boundary that keeps package lifecycle code away from the OIDC token.
 *
 * The SDK's first release attempt (run 30233771956) burned the `sdk-v0.1.0-beta.1` tag: it packed,
 * smoke-tested, audited, and signed provenance for a tarball, then got `E404` from the registry
 * `PUT`. `actions/setup-node` had been given `registry-url`, which writes an unresolved
 * `${NODE_AUTH_TOKEN}` placeholder into the npm user config; npm read that as a credential and
 * never attempted the OIDC exchange.
 *
 * These assertions save neither the version number nor any work: the workflows are tag-triggered,
 * so the tag exists before any step runs, and the unprivileged `prepare` job has already built,
 * smoked, audited, and uploaded the artifact by the time the publish job's checks run. What they
 * prevent is an npm registry read or a publish attempt made with a credential state that suppresses
 * Trusted Publishing — and they keep `pnpm install` and `prepack` out of the job that can mint a
 * token.
 */

const root = resolve(import.meta.dirname, "../../..");

interface Step {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
interface Environment {
  name?: string;
  deployment?: boolean;
}
interface Job {
  // GitHub accepts either the shorthand string or the mapping; only the mapping can say
  // `deployment: false`, so the type has to admit both to catch a silent regression to the string.
  environment?: string | Environment;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const readWorkflow = (file: string): { text: string; parsed: Workflow } => {
  const text = readFileSync(resolve(root, ".github/workflows", file), "utf8");
  return { text, parsed: parse(text) as Workflow };
};

const runsOf = (job: Job | undefined) =>
  (job?.steps ?? []).map((step) => step.run ?? "").join("\n");

/**
 * The publish job's environment contract, as a checker rather than an inline assertion, so the
 * mutation controls at the bottom of this file can prove it actually rejects each way the
 * configuration could drift.
 */
const environmentContractErrors = (environment: Job["environment"]): string[] => {
  if (typeof environment !== "object" || environment === null) {
    return [`environment must be a mapping, got ${JSON.stringify(environment)}`];
  }
  const errors: string[] = [];
  if (environment.name !== "publish") {
    errors.push(`environment name must be "publish", got ${JSON.stringify(environment.name)}`);
  }
  if (environment.deployment !== false) {
    errors.push(
      `environment must set deployment: false, got ${JSON.stringify(environment.deployment)}`,
    );
  }
  for (const key of Object.keys(environment)) {
    if (key !== "name" && key !== "deployment") errors.push(`unexpected environment key: ${key}`);
  }
  return errors;
};

const PUBLISH_WORKFLOWS = ["publish-sdk.yml", "publish-cli.yml"] as const;

describe.each(PUBLISH_WORKFLOWS)("%s", (file) => {
  const { text, parsed } = readWorkflow(file);
  const publish = parsed.jobs.publish;
  const steps = publish?.steps ?? [];
  const publishCommand = steps
    .map((step) => step.run ?? "")
    .find((run) => run.includes("npm publish"));

  it("keeps OIDC and write access on the publish job only", () => {
    expect(parsed.permissions?.contents).toBe("read");
    expect(parsed.permissions?.["id-token"]).toBeUndefined();
    expect(publish?.permissions?.["id-token"]).toBe("write");

    for (const [name, job] of Object.entries(parsed.jobs)) {
      if (name === "publish") continue;
      expect(job.permissions?.["id-token"], `${name} must not mint an OIDC token`).toBeUndefined();
      expect(job.permissions?.contents, `${name} must stay read-only`).toBe("read");
    }
  });

  it("gates the publish job on the environment without writing deployment history", () => {
    // The environment is the approval gate and the OIDC identity. `name` is what npm's Trusted
    // Publisher record matches, so it is pinned as a string, not merely as "some environment".
    // `deployment: false` is what keeps the repository's deployment history out of it: the failed
    // `sdk-v0.1.0-beta.1` attempt left a red entry there purely because the job referenced an
    // environment. Reviewers, wait timers, secrets, and the `environment` claim are unaffected.
    expect(environmentContractErrors(publish?.environment)).toEqual([]);

    // Only the privileged job may reference the environment; anything else would put lifecycle
    // code inside the approval boundary.
    for (const [name, job] of Object.entries(parsed.jobs)) {
      if (name === "publish") continue;
      expect(job.environment, `${name} must not reference an environment`).toBeUndefined();
    }
  });

  it("runs no install, build, or package lifecycle in the privileged job", () => {
    // A dependency or prepack script running here could mint an OIDC token and publish on its own;
    // a final credential check cannot undo what already happened.
    const runs = runsOf(publish);
    for (const forbidden of ["pnpm install", "npm install", "pnpm pack", "npm pack", "prepack"]) {
      expect(runs, `${file} publish job`).not.toContain(forbidden);
    }
  });

  it("prepares the artifact in an unprivileged job and hands it over", () => {
    const prepare = parsed.jobs.prepare;
    expect(prepare?.permissions?.contents).toBe("read");
    expect(prepare?.permissions?.["id-token"]).toBeUndefined();
    expect(prepare?.environment).toBeUndefined();
    expect(runsOf(prepare)).toContain("pnpm install --frozen-lockfile");
    expect(runsOf(prepare)).toContain("pack --pack-destination");

    expect(
      (prepare?.steps ?? []).some((step) => step.uses?.startsWith("actions/upload-artifact@")),
    ).toBe(true);
    expect(steps.some((step) => step.uses?.startsWith("actions/download-artifact@"))).toBe(true);
  });

  it("assembles the bundle with one script instead of assembling paths in YAML", () => {
    // The SDK workflow wrote the checksum into `$RUNNER_TEMP/bundle` — a directory no step created
    // — while the upload read `$RUNNER_TEMP`. Tag-triggered workflows never run in PR CI, so only
    // a real release would have found it. One script now owns the layout, and
    // `scripts/test-release-bundle-handoff.mjs` runs it against the verifier on every PR.
    const prepare = parsed.jobs.prepare;
    expect(runsOf(prepare)).toContain("scripts/assemble-release-bundle.mjs");
    for (const flag of ["--kind", "--tarball", "--manifest", "--tag", "--commit", "--out"]) {
      expect(runsOf(prepare)).toContain(flag);
    }
    // No hand-rolled digest or metadata JSON left in the YAML.
    expect(runsOf(prepare)).not.toContain('createHash("sha512")');
    expect(runsOf(prepare)).not.toContain("release-metadata.json");
  });

  it("uploads the assembled bundle directory, and fails when it is empty", () => {
    const upload = (parsed.jobs.prepare?.steps ?? []).find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(upload?.with?.path).toBe("${{ env.BUNDLE_DIR }}");
    // Without this, a bundle that failed to assemble uploads as an empty artifact and the failure
    // surfaces in the privileged job instead of here.
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
  });

  it("classifies the version with the shared SemVer helper, not a shell regex", () => {
    // The shell test this replaced looked for a letter after the hyphen, so `1.0.0-1` read as
    // stable. No `[[ ... =~ ... ]]` version test may remain in either workflow.
    expect(text).not.toMatch(/\[\[[^\]]*=~[^\]]*\]\]/);
    const validate = runsOf(parsed.jobs.validate);
    const viaContract = validate.includes("scripts/release-version-contract.mjs");
    const viaValidator =
      validate.includes("scripts/check-sdk-release-version.mjs") ||
      validate.includes("scripts/check-cli-release-version.mjs");
    expect(viaContract || viaValidator).toBe(true);
  });

  it("re-derives the bundle's identity before trusting it", () => {
    const runs = runsOf(publish);
    expect(runs).toContain("verify-release-bundle.mjs");
    expect(runs).toContain("--kind");
    expect(runs).toContain("--commit");
    expect(runs).toContain("--tag");
    expect(runs).toContain("--github-env");
  });

  it("never evaluates anything the bundle produced", () => {
    // The verifier used to print `export KEY='value'` and this job ran `eval` on it. A crafted
    // `distTag` in the bundle then executed in the job holding id-token: write.
    expect(text).not.toMatch(/eval\s+"\$\(/);
    expect(text).not.toContain("eval ");
  });

  it("audits the tarball's contents with the checkout's own auditor, then re-checks the digest", () => {
    const steps = publish?.steps ?? [];
    const verify = steps.findIndex((step) => step.run?.includes("verify-release-bundle.mjs"));
    const audit = steps.findIndex((step) => step.name?.startsWith("Audit tarball contents"));
    const recheck = steps.findIndex((step) => step.name?.startsWith("Re-verify tarball digest"));
    const publishIndex = steps.findIndex((step) => step.run?.includes("npm publish"));

    // Matching digests only prove the bundle is self-consistent; the contents still need auditing
    // by code that did not travel with them.
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(audit).toBeGreaterThan(verify);
    expect(recheck).toBeGreaterThan(audit);
    expect(publishIndex).toBeGreaterThan(recheck);
  });

  it("leaves the checksum filename to the assembler rather than naming it per workflow", () => {
    // The CLI bundle was written as `tarball-sha256.txt` while the verifier read
    // `fairux-sdk-sha256.txt`, so the first CLI release would have failed. Neither workflow spells
    // the name any more: one script writes it and one contract expects it.
    for (const name of ["fairux-sdk-sha256.txt", "tarball-sha256.txt", "tarball-digests.mjs"]) {
      expect(text).not.toContain(name);
    }
    const assembler = readFileSync(resolve(root, "scripts/assemble-release-bundle.mjs"), "utf8");
    const contract = readFileSync(resolve(root, "scripts/release-bundle-contract.mjs"), "utf8");
    expect(assembler).toContain('"release-sha256.txt"');
    expect(contract).toContain('"release-sha256.txt"');
  });

  it("validates the tag before any job installs anything", () => {
    const validate = parsed.jobs.validate;
    expect(validate?.permissions?.contents).toBe("read");
    expect(runsOf(validate)).not.toContain("pnpm install");
    expect(parsed.jobs.prepare?.needs).toBe("validate");
    expect(publish?.needs).toContain("validate");
    expect(publish?.needs).toContain("prepare");
  });

  it("gives setup-node no registry-url, anywhere", () => {
    for (const job of Object.values(parsed.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/setup-node@")) {
          expect(step.with?.["registry-url"]).toBeUndefined();
        }
      }
    }
  });

  it("names the registry on the publish command", () => {
    expect(publishCommand).toContain("--registry=https://registry.npmjs.org/");
  });

  it("supplies no static npm credential", () => {
    // Structure, not raw text: both workflows name these variables in comments explaining why
    // they are absent.
    for (const job of Object.values(parsed.jobs)) {
      for (const step of job.steps ?? []) {
        for (const name of Object.keys(step.env ?? {})) {
          expect(name).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN/);
        }
      }
    }
    expect(text).not.toMatch(/secrets\.[A-Za-z_]*(NPM|TOKEN|npm|token)/);
  });

  it("reads and writes the same registry", () => {
    // `npm publish` named the registry; `npm view` did not, so it resolved through npm config —
    // `@fairux:registry`, `NPM_CONFIG_REGISTRY`, any of three `.npmrc` layers. The plan, the
    // publish, and the post-publish verification could each have been talking to a different host.
    const registry = readFileSync(resolve(root, "scripts/public-npm-registry.mjs"), "utf8");
    expect(registry).toContain('"https://registry.npmjs.org/"');
    expect(registry).toContain('"--prefer-online"');
    expect(publishCommand).toContain("--registry=https://registry.npmjs.org/");
  });

  it("pins the scope key too, wherever the package is scoped", () => {
    // npm resolves a scoped package through `@<scope>:registry` first and only falls back to
    // `registry`, so `--registry` alone left any `@fairux:registry=` line in charge of where the
    // SDK's traffic went. `fairux` is unscoped and has no scope key to override.
    const scoped = file === "publish-sdk.yml";
    expect(publishCommand?.includes("--@fairux:registry=https://registry.npmjs.org/")).toBe(scoped);
  });

  it("verifies the preconditions immediately before publishing", () => {
    const checkIndex = steps.findLastIndex((step) =>
      step.run?.includes("check-trusted-publishing.mjs"),
    );
    const publishIndex = steps.findIndex((step) => step.run?.includes("npm publish"));
    expect(checkIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex - checkIndex).toBe(1);
  });

  it("publishes with provenance, without scripts, from the packed tarball", () => {
    expect(publishCommand).toContain("--provenance");
    expect(publishCommand).toContain("--ignore-scripts");
    expect(publishCommand).toContain('"$TARBALL"');
  });
});

describe("publish-sdk.yml preflight ordering", () => {
  const { parsed } = readWorkflow("publish-sdk.yml");
  const steps = parsed.jobs.publish?.steps ?? [];
  const indexOf = (needle: string) => steps.findIndex((step) => step.run?.includes(needle));
  const preflights = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.run?.includes("check-trusted-publishing.mjs"))
    .map(({ index }) => index);

  it("runs the preflight before the first npm network call, and again before the publish", () => {
    // `release-registry-plan.mjs` runs `npm view`. A static credential in this job's config would
    // have reached the registry on that call, earlier than any check that used to run.
    expect(preflights).toHaveLength(2);
    expect(preflights[0]).toBeLessThan(indexOf("release-registry-plan.mjs"));
    expect(preflights[1]).toBeGreaterThan(indexOf("release-registry-plan.mjs"));
    expect(preflights[1]).toBeLessThan(indexOf("npm publish"));
  });

  it("orders the whole publish sequence", () => {
    const order = [
      indexOf("verify-release-bundle.mjs"),
      indexOf("release-check.mjs"),
      preflights[0] as number,
      indexOf("release-registry-plan.mjs"),
      preflights[1] as number,
      indexOf("npm publish"),
      indexOf("--require-present"),
    ];
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("gates only the second preflight on the publish actually happening", () => {
    // The first guards a network call that runs either way; the second guards the publish.
    expect(steps[preflights[0] as number]?.if).toBeUndefined();
    expect(steps[preflights[1] as number]?.if).toContain("PUBLISH_NEEDED");
  });
});

describe("publish-cli.yml preflight ordering", () => {
  const { parsed } = readWorkflow("publish-cli.yml");
  const steps = parsed.jobs.publish?.steps ?? [];
  const indexOf = (needle: string) => steps.findIndex((step) => step.run?.includes(needle));
  const preflights = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.run?.includes("check-trusted-publishing.mjs"))
    .map(({ index }) => index);

  it("runs the preflight before the first npm network call, and again before the publish", () => {
    // The CLI job used to make no `npm view` call, so one preflight immediately before the publish
    // was the whole contract. `release-registry-plan.mjs` reads the registry, so a static
    // credential in this job's config would now reach npm on that call — earlier than a check
    // positioned only in front of the publish.
    expect(preflights).toHaveLength(2);
    expect(preflights[0]).toBeLessThan(indexOf("release-registry-plan.mjs"));
    expect(preflights[1]).toBeGreaterThan(indexOf("release-registry-plan.mjs"));
    expect(preflights[1]).toBeLessThan(indexOf("npm publish"));
  });

  it("gates only the second preflight on the publish actually happening", () => {
    // The first guards a network call that runs either way; the second guards the publish.
    expect(steps[preflights[0] as number]?.if).toBeUndefined();
    expect(steps[preflights[1] as number]?.if).toContain("PUBLISH_NEEDED");
  });
});

describe("publish-sdk.yml release notes", () => {
  const { text, parsed } = readWorkflow("publish-sdk.yml");

  it("generates the notes in the privileged job, from its own checkout", () => {
    // The notes become the GitHub Release body. Generating them in `prepare` — where dependency
    // and `prepack` scripts run — meant that job chose the text this repository published.
    expect(runsOf(parsed.jobs.prepare)).not.toContain("release-notes.mjs");
    expect(runsOf(parsed.jobs.publish)).toContain("packages/sdk/scripts/release-notes.mjs");
  });

  it("keeps the notes out of the bundle the unprivileged job uploads", () => {
    const upload = (parsed.jobs.prepare?.steps ?? []).find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(JSON.stringify(upload?.with ?? {})).not.toContain("sdk-release-notes.md");
    expect(runsOf(parsed.jobs.publish)).toContain('"$RUNNER_TEMP/sdk-release-notes.md"');
    expect(runsOf(parsed.jobs.publish)).not.toContain("bundle/sdk-release-notes.md");
  });

  it("runs exactly this notes command, and nothing else in the step", () => {
    // Searching the step for each option name proved only that the names appear somewhere: an
    // extra option, a duplicate, a swapped pair of values, or a second command appended after the
    // generator would all have passed. The whole step is compared instead.
    //
    // `joinContinuations` handles this step's backslash line continuations and nothing more. It is
    // not a shell parser, and it would be wrong for a step containing quoted newlines or `&&`.
    const notes = (parsed.jobs.publish?.steps ?? []).find((step) =>
      step.run?.includes("release-notes.mjs"),
    );
    const joinContinuations = (run: string) =>
      run
        .split("\n")
        .map((line) => line.trim().replace(/\\$/, "").trim())
        .filter(Boolean)
        .join(" ");

    expect(joinContinuations(notes?.run ?? "")).toBe(
      [
        "node packages/sdk/scripts/release-notes.mjs",
        "--package-json packages/sdk/package.json",
        '--tag "${{ github.ref_name }}"',
        '--source-commit "${{ github.sha }}"',
        '--dist-tag "$DIST_TAG"',
        '--tarball "$TARBALL"',
        '--checksum "$RUNNER_TEMP/bundle/release-sha256.txt"',
        // Passed only because the two steps above actually ran and passed. Without them the notes
        // narrow those claims rather than asserting them (issue #83), so their presence here is
        // part of the contract rather than incidental.
        "--verified-credential-preflight",
        "--verified-provenance-attested",
        '--out "$RUNNER_TEMP/sdk-release-notes.md"',
      ].join(" "),
    );
  });

  /**
   * What the `--verified-*` flags are allowed to mean.
   *
   * The notes' credential claim used to say "immediately before `npm publish` … and again
   * afterwards". Neither held: the second credential check is conditional on `PUBLISH_NEEDED`, so a
   * rerun that finds the version already present skips it, and there is no check after publication
   * at all — while the flag is passed unconditionally. The wording was narrowed to the one check
   * that runs on every path, and this pins the workflow shape that makes that wording true.
   */
  it("runs the credential check before its first registry request, and again only if publishing", () => {
    const steps = parsed.jobs.publish?.steps ?? [];
    const credentialChecks = steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.run?.includes("check-trusted-publishing.mjs"));
    expect(credentialChecks).toHaveLength(2);

    const firstRegistryRead = steps.findIndex((step) =>
      step.run?.includes("release-registry-plan.mjs"),
    );
    expect(firstRegistryRead).toBeGreaterThanOrEqual(0);
    // The claim the notes make: before this run's first npm registry request.
    expect(credentialChecks[0]?.index).toBeLessThan(firstRegistryRead);

    // The second is defence in depth, not a fact the notes may state — it does not always run.
    expect(credentialChecks[1]?.step.if).toContain("PUBLISH_NEEDED");

    // And there is no third one after publishing, which is what "again afterwards" would have meant.
    const publish = steps.findIndex((step) => step.run?.includes("npm publish"));
    expect(publish).toBeGreaterThanOrEqual(0);
    expect(credentialChecks.every(({ index }) => index < publish)).toBe(true);
  });

  it("reads the dist-tags back before the notes tell people to install from one", () => {
    // The digest check verifies the *version*; the notes say `npm install @fairux/sdk@next`. On a
    // rerun the publish is skipped and `next` may have moved, so every digest check passes while the
    // one instruction a consumer follows is wrong.
    const steps = parsed.jobs.publish?.steps ?? [];
    const digest = steps.findIndex((step) => step.run?.includes("--require-present"));
    const distTags = steps.findIndex((step) => step.run?.includes("verify-sdk-dist-tags.mjs"));
    const notes = steps.findIndex((step) => step.run?.includes("release-notes.mjs"));
    expect(distTags).toBeGreaterThanOrEqual(0);
    expect(distTags).toBeGreaterThan(digest);
    expect(distTags).toBeLessThan(notes);
  });

  it("reads provenance back before the notes claim it", () => {
    const steps = parsed.jobs.publish?.steps ?? [];
    const provenance = steps.findIndex((step) => step.run?.includes("verify-sdk-provenance.mjs"));
    const notes = steps.findIndex((step) => step.run?.includes("release-notes.mjs"));
    expect(provenance).toBeGreaterThanOrEqual(0);
    // A claim written before the check that supports it is a claim the run has not earned.
    expect(provenance).toBeLessThan(notes);
  });

  it("writes the notes only after the published version is verified on the registry", () => {
    const steps = parsed.jobs.publish?.steps ?? [];
    const registry = steps.findIndex((step) => step.run?.includes("--require-present"));
    const notes = steps.findIndex((step) => step.run?.includes("release-notes.mjs"));
    const release = steps.findIndex((step) => step.run?.includes("gh release"));

    expect(registry).toBeGreaterThanOrEqual(0);
    expect(notes).toBeGreaterThan(registry);
    expect(release).toBeGreaterThan(notes);
  });

  it("titles the Release without duplicating the version's `v`", () => {
    // `@fairux/sdk v0.1.0-beta.2` shipped on the first SDK Release. Both branches are checked:
    // the create path and the edit path drifted apart in every earlier version of this step.
    const titles = [...text.matchAll(/--title "([^"]+)"/g)].map((match) => match[1]);
    expect(titles).toEqual(["@fairux/sdk ${VERSION}", "@fairux/sdk ${VERSION}"]);
    expect(text).not.toContain('--title "@fairux/sdk v');
  });

  it("does not introduce a second asset-upload command", () => {
    // This proves only that P20-T7 adds no additional upload path. It does not establish that
    // rerunning this workflow against an existing Release preserves asset identity — the edit
    // branch still calls `gh release upload --clobber`, which is out of scope here. The published
    // beta's body is corrected after merge by a separate `gh release edit`, with no upload at all.
    const uploads = runsOf(parsed.jobs.publish).match(/gh release upload/g) ?? [];
    expect(uploads).toHaveLength(1);
    expect(runsOf(parsed.jobs.publish)).not.toContain("gh release delete");
  });
});

describe("publish-sdk.yml specifics", () => {
  const { text, parsed } = readWorkflow("publish-sdk.yml");
  const publish = parsed.jobs.publish;
  const publishCommand = (publish?.steps ?? [])
    .map((step) => step.run ?? "")
    .find((run) => run.includes("npm publish"));

  it("publishes the SDK publicly on the next dist-tag and refuses stable versions", () => {
    expect(publishCommand).toContain("--access public");
    // The dist-tag is derived in the publish job by the verifier, from its own checkout — the
    // bundle's copy is only compared against it.
    expect(runsOf(parsed.jobs.prepare)).toContain("--kind sdk");
    expect(publishCommand).toContain('--tag "$DIST_TAG"');
    expect(runsOf(parsed.jobs.validate)).toContain("check-sdk-release-version.mjs");
  });

  it("needs the smoke matrix as well as prepare", () => {
    expect(parsed.jobs["sdk-smoke"]?.needs).toBe("validate");
    expect(publish?.needs).toContain("sdk-smoke");
  });

  it("holds contents: write only because it creates the GitHub Release", () => {
    expect(publish?.permissions?.contents).toBe("write");
    expect(runsOf(publish)).toContain("gh release");
  });

  it("attaches release assets from the verified bundle directory", () => {
    // The checksum was uploaded into `$RUNNER_TEMP/bundle/` but attached from `$RUNNER_TEMP/`,
    // so the Release step would have failed with ENOENT *after* npm publish succeeded.
    const release = runsOf(publish);
    expect(release).toContain('"$RUNNER_TEMP/bundle/release-sha256.txt"');
    expect(release).not.toMatch(/"\$RUNNER_TEMP\/release-sha256\.txt"/);
  });
});

describe("publish-cli.yml specifics", () => {
  const { parsed } = readWorkflow("publish-cli.yml");
  const publish = parsed.jobs.publish;

  it("holds contents: write only because it creates the GitHub Release", () => {
    // It was `read`, and the job created no Release — while `docs/roadmap.md` says M1 ships the
    // CLI beta with one. The write is scoped to this job; `validate` and `prepare` stay read-only,
    // which the workflow-wide assertions above cover for both workflows.
    expect(publish?.permissions?.contents).toBe("write");
    expect(runsOf(publish)).toContain("gh release");
  });

  it("attaches release assets from the verified bundle directory", () => {
    // The SDK's checksum was uploaded into `$RUNNER_TEMP/bundle/` and attached from
    // `$RUNNER_TEMP/`, so its Release step failed with ENOENT *after* npm publish succeeded.
    const release = runsOf(publish);
    expect(release).toContain('"$RUNNER_TEMP/bundle/release-sha256.txt"');
    expect(release).not.toMatch(/"\$RUNNER_TEMP\/release-sha256\.txt"/);
  });
});

describe("publish environment contract, mutated", () => {
  // A contract that only ever sees the passing case proves nothing about what it would catch. Each
  // mutation below is a way the environment could realistically drift back — the shorthand string
  // GitHub still accepts, a dropped or flipped `deployment`, a rename that would silently leave the
  // Trusted Publisher record unmatched — and each must be reported, not tolerated.
  const mutations: Array<[string, Job["environment"]]> = [
    ["reverting to the shorthand string", "publish"],
    ["dropping deployment: false", { name: "publish" }],
    ["flipping deployment back to true", { name: "publish", deployment: true }],
    ["renaming the environment", { name: "release", deployment: false }],
    ["omitting the environment entirely", undefined],
    [
      "adding an unexpected key",
      { name: "publish", deployment: false, url: "https://npmjs.com" } as Environment,
    ],
  ];

  it.each(mutations)("rejects %s", (_label, environment) => {
    expect(environmentContractErrors(environment)).not.toEqual([]);
  });

  it("accepts only the exact contract", () => {
    expect(environmentContractErrors({ name: "publish", deployment: false })).toEqual([]);
  });
});

#!/usr/bin/env node
/**
 * Prove where npm actually sends a scoped request, rather than asserting on argument strings.
 *
 * The previous round added `--registry=https://registry.npmjs.org/` to every release command and a
 * test that the flag was present. The flag was present; the guarantee was not. npm resolves a
 * **scoped** package through `@<scope>:registry` first and only falls back to `registry`
 * (`pickRegistry()` in `npm-registry-fetch`), so a `@fairux:registry=` line in any `.npmrc` still
 * decided where `@fairux/sdk` traffic went. A string assertion cannot see that — it pinned a wrong
 * assumption as if it were a fact.
 *
 * So this runs npm against two local HTTP servers, with a hostile `@fairux:registry` in a temporary
 * user config, and checks which one receives the request. No external network, no registry, no
 * credentials, no publish.
 *
 * The negative control matters as much as the positive one: it demonstrates that the old arguments
 * really did route to the wrong host, so the fix is not decoration.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  FAIRUX_NPM_SCOPE,
  NPM_SDK_VIEW_REGISTRY_ARGS,
  PUBLIC_NPM_REGISTRY,
  registryArgsForScope,
} from "./public-npm-registry.mjs";

/**
 * `execFile`, not `execFileSync`.
 *
 * The recording servers run in this process, and a synchronous child blocks this process's event
 * loop — so npm's connection sits unaccepted until the timeout and no request is ever recorded.
 * That is what made an earlier version of this file report "loopback is unavailable" on a GitHub
 * runner, where loopback plainly works.
 */
const run = promisify(execFile);

let failed = 0;
const ok = (message) => console.log(`✓ ${message}`);
const bad = (message) => {
  failed += 1;
  console.error(`✗ ${message}`);
};

/**
 * A registry that answers 404 to everything and records what it was asked for.
 *
 * Only requests for the package under test are recorded. npm's update notifier asks the fallback
 * registry about `npm` itself, which is a real request to the right host and has nothing to do with
 * where scoped traffic goes.
 */
function recordingRegistry() {
  const requests = [];
  const server = createServer((request, response) => {
    if (decodeURIComponent(request.url).includes(`${FAIRUX_NPM_SCOPE}/sdk`)) {
      requests.push(`${request.method} ${request.url}`);
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"Not found"}');
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/` });
    });
  });
}

const wrong = await recordingRegistry();
const expected = await recordingRegistry();

try {
  const home = mkdtempSync(join(tmpdir(), "fairux-registry-"));
  // The hostile configuration this exists to defeat: a scope registry pointing somewhere else.
  writeFileSync(join(home, ".npmrc"), `${FAIRUX_NPM_SCOPE}:registry=${wrong.url}\n`, "utf8");
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    npm_config_userconfig: join(home, ".npmrc"),
    npm_config_cache: join(home, "cache"),
    // npm's update notifier asks the fallback registry about `npm`; silence it so the servers see
    // only what this check is about.
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };

  /** Run `npm view` with the given registry arguments and report which server was asked. */
  async function route(args) {
    wrong.requests.length = 0;
    expected.requests.length = 0;
    try {
      await run(
        "npm",
        ["view", `${FAIRUX_NPM_SCOPE}/sdk@0.0.0-routing-fixture.0`, "version", "--json", ...args],
        { env, cwd: home, timeout: 120_000 },
      );
    } catch {
      // A 404 from the fixture server is the expected outcome; only the destination matters.
    }
    return { wrong: [...wrong.requests], expected: [...expected.requests] };
  }

  console.log(`npm ${execFileSync("npm", ["--version"], { encoding: "utf8" }).trim()}`);
  console.log(`  wrong    ${wrong.url}`);
  console.log(`  expected ${expected.url}\n`);

  // --- Negative control: what the previous round shipped ---------------------------------------
  // If npm reaches neither server, nothing below means anything, so that is a failure rather than a
  // skip. An earlier version treated it as an environment limitation and skipped; the limitation
  // was this file's own — the servers run in this process, and a synchronous child blocked them.
  const fallbackOnly = await route([`--registry=${expected.url}`, "--prefer-online"]);
  if (fallbackOnly.wrong.length === 0 && fallbackOnly.expected.length === 0) {
    bad("npm reached neither local registry — its routing was not observed, so nothing was proven");
  } else if (fallbackOnly.wrong.length > 0 && fallbackOnly.expected.length === 0) {
    ok("negative control: --registry alone still routes @fairux to the scope registry");
  } else {
    bad(
      `negative control did not reproduce: wrong=${JSON.stringify(fallbackOnly.wrong)} expected=${JSON.stringify(fallbackOnly.expected)}`,
    );
  }

  // --- The production arguments ------------------------------------------------------------
  const production = await route(
    registryArgsForScope(expected.url, FAIRUX_NPM_SCOPE, { preferOnline: true }),
  );
  if (production.expected.length > 0) {
    ok(`the release arguments route to the intended registry (${production.expected.join(", ")})`);
  } else {
    bad("the release arguments sent no request to the intended registry");
  }
  if (production.wrong.length === 0) {
    ok("no request reached the scope registry from the user config");
  } else {
    bad(`the scope registry from the user config still received ${production.wrong.join(", ")}`);
  }

  // --- And the shipped constants name the public registry, both keys ---------------------------
  const shipped = [...NPM_SDK_VIEW_REGISTRY_ARGS];
  const expectedShipped = [
    `--registry=${PUBLIC_NPM_REGISTRY}`,
    `--${FAIRUX_NPM_SCOPE}:registry=${PUBLIC_NPM_REGISTRY}`,
    "--prefer-online",
  ];
  if (JSON.stringify(shipped) === JSON.stringify(expectedShipped)) {
    ok("the shipped read arguments pin both the fallback and the scope key to public npm");
  } else {
    bad(`shipped read arguments are ${JSON.stringify(shipped)}`);
  }
} finally {
  wrong.server.close();
  expected.server.close();
}

console.log(failed ? "\n✗ scoped registry routing FAILED" : "\n✓ scoped registry routing verified");
process.exitCode = failed ? 1 : 0;

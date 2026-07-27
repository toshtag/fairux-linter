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
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FAIRUX_NPM_SCOPE,
  NPM_SDK_VIEW_REGISTRY_ARGS,
  PUBLIC_NPM_REGISTRY,
  registryArgsForScope,
} from "./public-npm-registry.mjs";

let failed = 0;
const ok = (message) => console.log(`✓ ${message}`);
const bad = (message) => {
  failed += 1;
  console.error(`✗ ${message}`);
};

/** A registry that answers 404 to everything and records what it was asked for. */
function recordingRegistry() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
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
  };

  /** Run `npm view` with the given registry arguments and report which server was asked. */
  function route(args) {
    wrong.requests.length = 0;
    expected.requests.length = 0;
    try {
      execFileSync(
        "npm",
        ["view", `${FAIRUX_NPM_SCOPE}/sdk@0.0.0-routing-fixture.0`, "version", "--json", ...args],
        { env, cwd: home, stdio: "pipe", timeout: 120_000 },
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
  // It doubles as the observability check. If npm reaches neither server, nothing below can mean
  // anything — some sandboxes allow loopback in-process but block it for spawned children. Rather
  // than probe for that separately (a second mechanism that can itself be wrong, and was), read it
  // off the first real call.
  const fallbackOnly = route([`--registry=${expected.url}`, "--prefer-online"]);
  if (fallbackOnly.wrong.length === 0 && fallbackOnly.expected.length === 0) {
    const message = "npm reached neither local registry, so its routing cannot be observed here";
    if (process.env.CI) {
      bad(`${message} — refusing to report a pass in CI`);
    } else {
      console.log(`⚠ skipped: ${message}`);
      console.log("  (loopback from a child process is unavailable; CI is authoritative)");
    }
    process.exit(failed ? 1 : 0);
  }
  if (fallbackOnly.wrong.length > 0 && fallbackOnly.expected.length === 0) {
    ok("negative control: --registry alone still routes @fairux to the scope registry");
  } else {
    bad(
      `negative control did not reproduce: wrong=${JSON.stringify(fallbackOnly.wrong)} expected=${JSON.stringify(fallbackOnly.expected)}`,
    );
  }

  // --- The production arguments ------------------------------------------------------------
  const production = route(
    registryArgsForScope(expected.url, FAIRUX_NPM_SCOPE, {
      preferOnline: true,
    }),
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

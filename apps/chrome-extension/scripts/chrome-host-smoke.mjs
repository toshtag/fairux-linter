import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

/**
 * The Chrome extension, in a real Chromium extension host.
 *
 * Everything else that tests this surface runs under happy-dom with a hand-written `chrome.*` stub:
 * `chrome.scripting.executeScript` is a `vi.fn()`, and no extension is ever loaded into a browser.
 * That cannot answer whether the packed extension loads, whether `activeTab` plus `scripting`
 * actually grants what the popup assumes, or whether a ` >>> ` locator resolves in an engine that
 * implements shadow DOM rather than models it. #272 is where that gap is written down.
 *
 * **Why Chromium and not Google Chrome.** Chrome 151 removed `--load-extension`, and
 * `Extensions.loadUnpacked` over CDP installs the extension but leaves every `chrome-extension://`
 * navigation blocked by `web_accessible_resources` — correctly, and adding the popup there to make a
 * test possible would widen what any page on the web can reach. That was measured and recorded as a
 * blocker, and the conclusion drawn from it was wrong: the blocker is branded Chrome's removal of a
 * side-loading flag, not Chromium's. Playwright's bundled Chromium still honours `--load-extension`,
 * which is the path Playwright documents for extension end-to-end tests.
 *
 * **What this drives, and what it refuses to do.** A normal HTTP page is the active tab and the
 * default action is triggered through CDP `Extensions.triggerAction`, which is what a click on the
 * toolbar button does. Navigating a tab to `popup.html` and letting the popup scan itself would be a
 * different program: the popup would be the active tab, `chrome.scripting.executeScript` would
 * target the extension's own document, and the shadow-root path would never run. Both buttons are
 * clicked with `Input.dispatchMouseEvent` at the element's own box, so the listeners under test are
 * reached the way a mouse reaches them.
 *
 * Nothing in the extension changes for this. No test-only parameter, no widened
 * `web_accessible_resources`, no relaxed permission or CSP.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const DIST = resolve(here, "../dist");
const FIXTURE = resolve(here, "../test/host/fixture.html");
const ARTIFACTS = resolve(root, ".chrome-host-smoke");

/** The name in `manifest.json`, which is how the running browser is asked which extension is ours. */
const EXTENSION_NAME = "FairUX (shell)";
/** The finding the fixture is built to produce, inside an open shadow root. */
const EXPECTED_RULE_TITLE = "Pre-checked consent box";
/** What `content.js` writes onto a highlighted element. Kept in sync by the assertion, not by hope. */
const HIGHLIGHT_OUTLINE = "rgb(214, 51, 108) solid 3px";

/** Whole-run ceiling. A hung extension host would otherwise hold a CI runner until the job cap. */
const TOTAL_TIMEOUT_MS = 120_000;
/** Per-wait ceiling, so a stage that never settles names itself rather than eating the whole budget. */
const STAGE_TIMEOUT_MS = 20_000;
/**
 * Long enough for `content.js` to put back the outline it borrowed.
 *
 * Its own timeout is 2 seconds. This waits for that rather than reaching into the page to clear it,
 * so the supplementary pointer activation is observed against the same starting state the keyboard
 * one was.
 */
const HIGHLIGHT_LAPSE_TIMEOUT_MS = 8_000;

/**
 * The stage a failure happened in.
 *
 * A smoke that drives nine steps and reports "timed out" is a smoke somebody has to re-run locally
 * to learn anything. Each stage names itself before it runs, and the failure message carries the
 * name — so a red CI job says `action-trigger` or `highlight` rather than a stack.
 */
let stage = "startup";
const facts = { focusOrder: [] };

function announce(name) {
  stage = name;
  process.stdout.write(`fairux-chrome-smoke: ${name}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`[${stage}] ${message}`);
}

/** Poll until a predicate holds. Named, so a timeout says what never happened. */
async function until(what, predicate, timeoutMs = STAGE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`[${stage}] timed out after ${timeoutMs}ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * A raw CDP connection to the browser.
 *
 * Playwright's own CDP session refuses the `Extensions` domain — it is not in the set its protocol
 * layer forwards — and `Extensions.triggerAction` is the supported way to open an action popup. So
 * the browser is launched by Playwright, which is what makes the extension load at all, and this one
 * domain is spoken directly over the DevTools endpoint.
 */
async function connectCdp(port) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const events = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    events.push(message);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { browserVersion: version.Browser, send, events, close: () => socket.close() };
}

/** Serve the fixture over HTTP. `file:` and `data:` are not pages `activeTab` treats as ordinary. */
async function serveFixture() {
  const html = readFileSync(FIXTURE, "utf8");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

/** An ephemeral port, taken and released, so two runs on one machine cannot collide. */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function run() {
  const { server, url } = await serveFixture();
  const profile = mkdtempSync(join(tmpdir(), "fairux-chrome-host-"));
  const port = await freePort();
  let context;
  let cdp;
  let popupSession;
  const consoleErrors = [];

  try {
    announce("extension-load");
    context = await chromium.launchPersistentContext(profile, {
      // `channel: "chromium"` and not the default headless shell: the shell ships without the
      // extensions subsystem, so `--load-extension` there is silently a no-op. This is the one
      // option in this file whose removal turns the whole smoke into a test of nothing.
      channel: "chromium",
      headless: true,
      timeout: STAGE_TIMEOUT_MS,
      args: [
        `--disable-extensions-except=${DIST}`,
        `--load-extension=${DIST}`,
        `--remote-debugging-port=${port}`,
      ],
    });
    cdp = await connectCdp(port);
    facts.browser = cdp.browserVersion;
    facts.playwright = JSON.parse(
      readFileSync(resolve(root, "node_modules/playwright/package.json"), "utf8"),
    ).version;

    const page = await context.newPage();
    page.on("pageerror", (error) => consoleErrors.push(`page: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(`page console: ${message.text()}`);
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: STAGE_TIMEOUT_MS });
    await page.bringToFront();

    // The id the running browser assigned, read from the browser rather than derived from the path.
    // A derivation that happens to agree with reality is not the same as having asked.
    const internals = await context.newPage();
    await internals.goto("chrome://extensions-internals", { timeout: STAGE_TIMEOUT_MS });
    const installed = JSON.parse(await internals.evaluate(() => document.body.innerText));
    await internals.close();
    await page.bringToFront();

    const extension = installed.find((entry) => entry.name === EXTENSION_NAME);
    assert(
      extension,
      `${EXTENSION_NAME} is not installed. The browser lists: ${installed
        .map((entry) => entry.name)
        .join(", ")}`,
    );
    assert(
      extension.disable_reasons?.length === 0 || extension.disable_reasons === undefined,
      `${EXTENSION_NAME} is installed but disabled: ${JSON.stringify(extension.disable_reasons)}`,
    );
    facts.extensionId = extension.id;
    facts.extensionLocation = extension.location;

    announce("action-trigger");
    // The *tab* target, not the page target. `Extensions.triggerAction` refuses a page target with
    // "Action can only be triggered on a tab target", which is the same distinction the toolbar
    // makes: an action belongs to a tab.
    const targets = (await cdp.send("Target.getTargets", { filter: [{}] })).result.targetInfos;
    const tab = targets.find((target) => target.type === "tab" && target.url.startsWith(url));
    assert(tab, `no tab target for the fixture page. Targets: ${JSON.stringify(targets)}`);
    const triggered = await cdp.send("Extensions.triggerAction", {
      id: facts.extensionId,
      targetId: tab.targetId,
    });
    assert(!triggered.error, `Extensions.triggerAction failed: ${JSON.stringify(triggered.error)}`);

    announce("popup-open");
    const popup = await until("the action popup to open", async () => {
      const open = (await cdp.send("Target.getTargets")).result.targetInfos;
      return open.find(
        (target) => target.url === `chrome-extension://${facts.extensionId}/popup.html`,
      );
    });
    popupSession = (
      await cdp.send("Target.attachToTarget", { targetId: popup.targetId, flatten: true })
    ).result.sessionId;
    await cdp.send("Runtime.enable", {}, popupSession);
    await cdp.send("Log.enable", {}, popupSession);

    const evaluate = async (expression) => {
      const response = await cdp.send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        popupSession,
      );
      const details = response.result?.exceptionDetails;
      if (details)
        throw new Error(
          `[${stage}] popup threw: ${details.text} ${details.exception?.description ?? ""}`,
        );
      return response.result.result.value;
    };
    // Sequential focus navigation needs a focused document, and a popup driven over CDP is not the
    // operating system's foreground window. Kept as insurance rather than as a measured
    // requirement, and worth stating which: on macOS this smoke passes with it removed, so it is
    // not load-bearing here — but whether a background popup keeps focus is a platform decision
    // this smoke should not be resting on. It emulates focus for the *test harness*; nothing in
    // the extension knows about it, and removing it changes no assertion below.
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, popupSession);

    /** The three keys this smoke uses, with the fields Chromium needs to treat them as real. */
    const KEYS = {
      Tab: { windowsVirtualKeyCode: 9, key: "Tab", code: "Tab" },
      Enter: { windowsVirtualKeyCode: 13, key: "Enter", code: "Enter", text: "\r" },
      Space: { windowsVirtualKeyCode: 32, key: " ", code: "Space", text: " " },
    };

    /**
     * A real key press, down and up.
     *
     * Both halves, because the two activation semantics differ and the point is to go through them
     * rather than around them: a button fires its click on Enter's *keydown* and on Space's *keyup*.
     * A helper that sent only one would pass for one key and silently not exercise the other.
     */
    const press = async (name, { shift = false } = {}) => {
      const key = KEYS[name];
      const modifiers = shift ? 8 : 0;
      await cdp.send(
        "Input.dispatchKeyEvent",
        { type: key.text ? "keyDown" : "rawKeyDown", modifiers, ...key },
        popupSession,
      );
      await cdp.send(
        "Input.dispatchKeyEvent",
        { type: "keyUp", modifiers, ...key, text: undefined },
        popupSession,
      );
    };

    /**
     * What has focus, how it got there, and whether a ring is actually painted on it.
     *
     * Two separate facts, because `:focus-visible` is only the first. It matches when the engine
     * decides this focus came from a keyboard, and it keeps matching under `outline: none` — so on
     * its own it is evidence that Tab was believed, not that anything is visible. The computed
     * outline is the other half, and it is the half the popup's stylesheet makes a claim about: a
     * tool that reports on dark patterns cannot ship a control that hides its own focus.
     */
    const ACTIVE = `(() => {
      const active = document.activeElement;
      if (!active) return null;
      const style = getComputedStyle(active);
      return {
        tag: active.tagName,
        id: active.id || null,
        className: active.className || null,
        label: (active.innerText || active.value || "").trim().split("\\n")[0].slice(0, 48),
        focusVisible: active.matches(":focus-visible"),
        outline: style.outlineStyle + " " + style.outlineWidth + " " + style.outlineColor,
        outlinePainted: style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0,
      };
    })()`;
    const activeElement = () => evaluate(ACTIVE);
    /** Tab, then say where it landed — so the focus order is a record rather than an inference. */
    const tabTo = async (what, options) => {
      await press("Tab", options);
      const active = await activeElement();
      facts.focusOrder.push({ step: what, ...active });
      return active;
    };

    /** A real click at the element's own box, so the listener is reached the way a mouse reaches it. */
    const click = async (selector) => {
      const box = await evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
      assert(box, `the popup has no ${selector} to click`);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await cdp.send(
          "Input.dispatchMouseEvent",
          { type, x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 },
          popupSession,
        );
      }
    };

    announce("keyboard-focus");
    await until("the popup to render its scan control", () =>
      evaluate("!!document.getElementById('scan')"),
    );
    const beforeAnyKey = await activeElement();
    facts.focusOrder.push({ step: "popup opened", ...beforeAnyKey });

    const onScan = await tabTo("Tab");
    assert(
      onScan?.id === "scan",
      `Tab from the popup body reached ${JSON.stringify(onScan)} rather than the Scan button`,
    );
    // The focus ring is the only thing telling a keyboard user where they are, and this popup's
    // stylesheet says in a comment that it is never removed. Asserted as two facts: the engine
    // treated this as keyboard focus, and something is actually painted.
    assert(
      onScan.focusVisible,
      "the Scan button took focus without the engine calling it keyboard focus",
    );
    assert(
      onScan.outlinePainted,
      `the Scan button has focus and no visible ring (outline: ${onScan.outline})`,
    );

    // Before a scan there is exactly one tab stop, so a second Tab has nowhere else to go. Asserted
    // because it is what makes the *third* Tab below meaningful: the finding button is a new stop
    // that did not exist a moment ago.
    const stillScan = await tabTo("Tab (no other stop yet)");
    assert(
      stillScan?.id === "scan",
      `before the scan the popup had a second tab stop: ${JSON.stringify(stillScan)}`,
    );

    announce("popup-scan");
    // Enter, not a click. A button activates on Enter's keydown, and that is the semantic under
    // test — `renderFinding` gave up a `<li>` with a click listener for a real `<button>` precisely
    // so this comes from the element rather than from re-implemented key handling.
    facts.scanActivatedWith = "Enter";
    await press("Enter");
    await until("the scan to produce a finding", () =>
      evaluate("document.querySelectorAll('.finding-activate').length > 0"),
    );
    // The live region announces the outcome without moving focus, which is the whole reason it is a
    // live region. A scan that stole focus would lose a keyboard user their place.
    const afterScan = await activeElement();
    facts.focusOrder.push({ step: "after Enter on Scan", ...afterScan });
    assert(
      afterScan?.id === "scan",
      `the scan moved focus to ${JSON.stringify(afterScan)}; the live region exists so it does not`,
    );

    const popupText = await evaluate("document.body.innerText");
    facts.popupSummary = String(popupText)
      .split("\n")
      .find((line) => line.includes("finding(s)"))
      ?.trim();
    assert(
      popupText.includes(EXPECTED_RULE_TITLE),
      `the popup does not show "${EXPECTED_RULE_TITLE}". It shows:\n${popupText}`,
    );

    announce("keyboard-finding");
    const onFinding = await tabTo("Tab");
    assert(
      onFinding?.className === "finding-activate",
      `Tab from the Scan button reached ${JSON.stringify(onFinding)} rather than the finding`,
    );
    assert(
      onFinding.focusVisible,
      "the finding took focus without the engine calling it keyboard focus",
    );
    assert(
      onFinding.outlinePainted,
      `the finding has focus and no visible ring (outline: ${onFinding.outline})`,
    );

    // Backwards too. An order that only works forwards is not an order — it is one lucky
    // `tabindex`, and a keyboard user who overshoots has to start again.
    const backOnScan = await tabTo("Shift+Tab", { shift: true });
    assert(
      backOnScan?.id === "scan",
      `Shift+Tab from the finding reached ${JSON.stringify(backOnScan)} rather than the Scan button`,
    );
    const forwardAgain = await tabTo("Tab");
    assert(
      forwardAgain?.className === "finding-activate",
      `Tab did not return to the finding: ${JSON.stringify(forwardAgain)}`,
    );

    announce("highlight");
    const outlineOf = () =>
      page.evaluate(
        () =>
          document
            .querySelector("consent-banner")
            ?.shadowRoot?.querySelector('input[type="checkbox"]')?.style.outline ?? "",
      );
    assert(
      (await outlineOf()) === "",
      "the shadow-root element was already outlined before the finding was activated",
    );
    // Space, where Scan used Enter. The two are different code paths in a browser — Enter activates
    // on keydown, Space on keyup — and using one key for both controls would leave the other
    // untested.
    facts.findingActivatedWith = "Space";
    await press("Space");
    await until(
      "the shadow-root element to be highlighted",
      async () => (await outlineOf()) === HIGHLIGHT_OUTLINE,
    );
    facts.status = await evaluate("document.getElementById('status').textContent");
    assert(
      String(facts.status).startsWith("Highlighted:"),
      `the popup reported "${facts.status}" rather than a highlight`,
    );

    announce("pointer-supplement");
    // The path this replaced, kept as a second observation and never as a substitute for the first.
    // Enter and Space reach the same listener a click does, so a green keyboard run says nothing
    // about hit areas or pointer coordinates; a green pointer run says nothing about focus order or
    // activation semantics. `content.js` restores the outline itself after its own timeout, which
    // is what makes the second activation observable at all.
    await until(
      "the highlight to lapse on its own",
      async () => (await outlineOf()) === "",
      HIGHLIGHT_LAPSE_TIMEOUT_MS,
    );
    await click(".finding-activate");
    await until(
      "the pointer path to highlight the same element",
      async () => (await outlineOf()) === HIGHLIGHT_OUTLINE,
    );

    announce("error-check");
    assert(
      consoleErrors.length === 0,
      `the page reported errors during the run:\n${consoleErrors.join("\n")}`,
    );

    process.stdout.write(`fairux-chrome-smoke: passed\n${JSON.stringify(facts, null, 2)}\n`);
  } catch (error) {
    // The artifacts a red job needs and cannot reconstruct: what the popup was showing, what the
    // page looked like, and which stage it died in.
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(
      join(ARTIFACTS, "failure.json"),
      `${JSON.stringify({ stage, message: String(error?.message ?? error), facts, consoleErrors }, null, 2)}\n`,
    );
    if (cdp && popupSession) {
      const shot = await cdp
        .send("Page.captureScreenshot", { format: "png" }, popupSession)
        .catch(() => undefined);
      if (shot?.result?.data) {
        writeFileSync(join(ARTIFACTS, "popup.png"), Buffer.from(shot.result.data, "base64"));
      }
      const text = await cdp
        .send(
          "Runtime.evaluate",
          { expression: "document.body.innerText", returnByValue: true },
          popupSession,
        )
        .catch(() => undefined);
      if (text?.result?.result?.value) {
        writeFileSync(join(ARTIFACTS, "popup.txt"), String(text.result.result.value));
      }
    }
    process.stderr.write(
      `fairux-chrome-smoke: FAILED in stage "${stage}"\n${String(error?.stack ?? error)}\n`,
    );
    throw error;
  } finally {
    cdp?.close();
    await context?.close().catch(() => undefined);
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

const guard = setTimeout(() => {
  process.stderr.write(`fairux-chrome-smoke: hard timeout in stage "${stage}"\n`);
  process.exit(1);
}, TOTAL_TIMEOUT_MS);
guard.unref();

await run();

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyConfigurationChange, ScanScheduler } from "../src/settings.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * What a settings change has to do to the editor, and when.
 *
 * `fairux.enable` and `fairux.debounceMs` were read on every scan and watched by nothing. Turning
 * FairUX off left every diagnostic already on screen exactly where it was, and an edit already in
 * flight came back and repainted them; turning it back on did nothing until a document happened to
 * change. Both read as the setting having failed.
 *
 * Driven through the two shapes this logic needs from `vscode` rather than through an extension
 * host: the behaviour is timers and bookkeeping, and an extension-host harness is infrastructure
 * this repository does not have and that these two settings would not pay for.
 */

interface Doc {
  readonly uri: string;
  readonly languageId: string;
}

const html = (uri: string): Doc => ({ uri, languageId: "html" });
const markdown = (uri: string): Doc => ({ uri, languageId: "markdown" });

/** A clock a test can advance, so nothing here waits on a real 300ms. */
function fakeTimers() {
  let next = 1;
  const scheduled = new Map<number, { fn: () => void; ms: number }>();
  return {
    api: {
      set: (fn: () => void, ms: number) => {
        const handle = next++;
        scheduled.set(handle, { fn, ms });
        return handle;
      },
      clear: (handle: unknown) => {
        scheduled.delete(handle as number);
      },
    },
    /** Fire everything outstanding, in the order it was scheduled. */
    runAll: () => {
      const entries = [...scheduled.entries()].sort(([a], [b]) => a - b);
      scheduled.clear();
      for (const [, entry] of entries) entry.fn();
    },
    delays: () => [...scheduled.values()].map((entry) => entry.ms),
    outstanding: () => scheduled.size,
  };
}

function harness(options: { enabled?: boolean; debounceMs?: number } = {}) {
  const timers = fakeTimers();
  const state = { enabled: options.enabled ?? true, debounceMs: options.debounceMs ?? 300 };
  const refreshed: string[] = [];
  const cleared: string[] = [];
  const documents: Doc[] = [];

  const scheduler = new ScanScheduler<Doc>({
    key: (doc) => doc.uri,
    debounceMs: () => state.debounceMs,
    run: (doc) => refreshed.push(doc.uri),
    timers: timers.api,
  });

  const change = () =>
    applyConfigurationChange<Doc>({
      affectsFairux: true,
      isEnabled: state.enabled,
      scheduler,
      documents: () => documents,
      isSupported: (doc) => doc.languageId === "html",
      clear: (doc) => cleared.push(doc.uri),
      refresh: (doc) => refreshed.push(doc.uri),
    });

  return { timers, state, refreshed, cleared, documents, scheduler, change };
}

describe("debounced rescans", () => {
  it("keeps one timer per document and runs the last edit only", () => {
    const h = harness();
    const doc = html("a.html");
    h.scheduler.schedule(doc);
    h.scheduler.schedule(doc);
    h.scheduler.schedule(doc);
    expect(h.scheduler.pendingCount).toBe(1);
    h.timers.runAll();
    expect(h.refreshed).toEqual(["a.html"]);
    expect(h.scheduler.pendingCount).toBe(0);
  });

  it("reads the delay when it schedules, so a changed debounce applies to the next keystroke", () => {
    const h = harness({ debounceMs: 300 });
    h.scheduler.schedule(html("a.html"));
    expect(h.timers.delays()).toEqual([300]);

    h.state.debounceMs = 50;
    h.scheduler.schedule(html("b.html"));
    expect(h.timers.delays()).toContain(50);
    // The rescan already in flight keeps the delay it was given: re-timing it would move the ground
    // under whoever is mid-keystroke.
    expect(h.timers.delays()).toContain(300);
  });

  it("cancels one document's rescan without touching the others", () => {
    const h = harness();
    h.scheduler.schedule(html("a.html"));
    h.scheduler.schedule(html("b.html"));
    h.scheduler.cancel("a.html");
    h.timers.runAll();
    expect(h.refreshed).toEqual(["b.html"]);
  });

  it("leaves nothing scheduled after cancelAll", () => {
    const h = harness();
    h.scheduler.schedule(html("a.html"));
    h.scheduler.schedule(html("b.html"));
    h.scheduler.cancelAll();
    expect(h.scheduler.pendingCount).toBe(0);
    expect(h.timers.outstanding()).toBe(0);
    h.timers.runAll();
    expect(h.refreshed).toEqual([]);
  });
});

describe("disabling fairux", () => {
  it("clears every open document's diagnostics immediately", () => {
    const h = harness();
    h.documents.push(html("a.html"), html("b.html"), markdown("c.md"));
    h.state.enabled = false;

    const outcome = h.change();
    expect(outcome).toEqual({ handled: true, cleared: 3, rescanned: 0 });
    // Including the unsupported one: a document that was supported when it was scanned is the
    // document whose diagnostics are on screen, and asking again at clear-time leaves some behind.
    expect(h.cleared).toEqual(["a.html", "b.html", "c.md"]);
  });

  it("cancels the rescans already in flight, so nothing repaints what it just cleared", () => {
    const h = harness();
    h.documents.push(html("a.html"));
    h.scheduler.schedule(html("a.html"));
    h.state.enabled = false;

    h.change();
    expect(h.scheduler.pendingCount).toBe(0);
    h.timers.runAll();
    expect(h.refreshed).toEqual([]);
  });
});

describe("enabling fairux", () => {
  it("rescans the supported open documents now, not on the next edit", () => {
    const h = harness();
    h.documents.push(html("a.html"), markdown("c.md"), html("b.html"));

    const outcome = h.change();
    expect(outcome).toEqual({ handled: true, cleared: 0, rescanned: 2 });
    expect(h.refreshed).toEqual(["a.html", "b.html"]);
    // Now, rather than scheduled: the user asked, and a debounce is for keystrokes.
    expect(h.scheduler.pendingCount).toBe(0);
  });
});

describe("the extension actually wires this up", () => {
  /**
   * `extension.ts` imports `vscode`, which does not exist outside an extension host, so it cannot be
   * imported here. Everything above could therefore be correct and unused — which is the failure
   * this reads the source to rule out. Structural, not a prose snapshot: four names, each of which
   * is the thing that makes one of the behaviours above reach a user.
   */
  const source = readFileSync(resolve(here, "../src/extension.ts"), "utf8");

  it("subscribes to configuration changes and hands them to this module", () => {
    expect(source).toContain("vscode.workspace.onDidChangeConfiguration");
    expect(source).toContain("applyConfigurationChange");
    expect(source).toContain('event.affectsConfiguration("fairux")');
  });

  it("schedules through the scheduler and cancels everything on disposal", () => {
    expect(source).toContain("new ScanScheduler");
    expect(source).toContain("scheduler.cancelAll()");
    // A closed document's pending rescan would repaint diagnostics on a URI the editor has dropped.
    expect(source).toContain("scheduler.cancel(doc.uri.toString())");
  });
});

describe("a change to something else", () => {
  it("does nothing at all", () => {
    const h = harness();
    h.documents.push(html("a.html"));
    const outcome = applyConfigurationChange<Doc>({
      affectsFairux: false,
      isEnabled: true,
      scheduler: h.scheduler,
      documents: () => h.documents,
      isSupported: () => true,
      clear: (doc) => h.cleared.push(doc.uri),
      refresh: (doc) => h.refreshed.push(doc.uri),
    });
    expect(outcome).toEqual({ handled: false, cleared: 0, rescanned: 0 });
    expect(h.refreshed).toEqual([]);
    expect(h.cleared).toEqual([]);
  });
});

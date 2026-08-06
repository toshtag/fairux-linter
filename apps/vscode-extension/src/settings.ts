/**
 * What happens between a setting changing and the editor agreeing with it.
 *
 * `fairux.enable` and `fairux.debounceMs` were read on every scan and never watched, so turning the
 * extension off left every diagnostic already on screen exactly where it was — for the rest of the
 * session on a file nobody touched again — and any edit already in flight came back and repainted
 * them. Turning it back on did nothing until something happened to a document. The setting looked
 * like it had failed.
 *
 * Nothing here imports `vscode`. The types are the two shapes this logic needs from it, so the
 * behaviour can be driven by a test in the ordinary suite rather than by an extension host, which is
 * infrastructure this repository does not have and would not be paid for by these two settings.
 */

/** The one thing a scheduler needs from a document: something to key its timer on. */
export type DocumentKey = string;

export interface SchedulerOptions<Doc> {
  readonly key: (doc: Doc) => DocumentKey;
  /**
   * Read at schedule time, never cached. A user who lowers the debounce and types expects the next
   * keystroke to use the new value, not the one that was in effect when the extension activated.
   */
  readonly debounceMs: () => number;
  readonly run: (doc: Doc) => void;
  /** Injected so a test can drive time. Defaults to the global timers. */
  readonly timers?: {
    readonly set: (fn: () => void, ms: number) => unknown;
    readonly clear: (handle: unknown) => void;
  };
}

/**
 * Debounced per-document rescans, and a way to stop every one of them at once.
 *
 * The map used to live inside `activate()` where only disposal could reach it, so "cancel what is
 * pending" was not something any other code path could ask for — which is exactly what disabling
 * the extension has to do.
 */
export class ScanScheduler<Doc> {
  private readonly pending = new Map<DocumentKey, unknown>();
  private readonly timers: NonNullable<SchedulerOptions<Doc>["timers"]>;

  constructor(private readonly options: SchedulerOptions<Doc>) {
    this.timers = options.timers ?? {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  /** How many rescans are waiting. Zero after {@link cancelAll}, and a test can say so. */
  get pendingCount(): number {
    return this.pending.size;
  }

  schedule(doc: Doc): void {
    const key = this.options.key(doc);
    this.cancel(key);
    const handle = this.timers.set(() => {
      this.pending.delete(key);
      this.options.run(doc);
    }, this.options.debounceMs());
    this.pending.set(key, handle);
  }

  cancel(key: DocumentKey): void {
    const existing = this.pending.get(key);
    if (existing === undefined) return;
    this.timers.clear(existing);
    this.pending.delete(key);
  }

  /** Drop every pending rescan. Called on disable and on disposal, for the same reason. */
  cancelAll(): void {
    for (const handle of this.pending.values()) this.timers.clear(handle);
    this.pending.clear();
  }
}

export interface ConfigurationChangeOptions<Doc> {
  /** Whether the change touched a `fairux.*` setting at all. */
  readonly affectsFairux: boolean;
  /** The value of `fairux.enable` **after** the change. */
  readonly isEnabled: boolean;
  readonly scheduler: ScanScheduler<Doc>;
  /** Every open document, supported or not. */
  readonly documents: () => readonly Doc[];
  readonly isSupported: (doc: Doc) => boolean;
  /** Remove a document's diagnostics. */
  readonly clear: (doc: Doc) => void;
  /** Rescan a document now, without waiting for the debounce. */
  readonly refresh: (doc: Doc) => void;
}

/** What a configuration change did, so a caller can log it and a test can read it. */
export interface ConfigurationChangeOutcome {
  readonly handled: boolean;
  readonly cleared: number;
  readonly rescanned: number;
}

/**
 * Bring the editor into line with the settings, immediately.
 *
 * Disabling clears **every** document's diagnostics, not only the supported ones: a document that
 * was supported when it was scanned is the document whose diagnostics are on screen, and asking
 * whether it still is at clear-time is a way to leave some behind. Pending rescans are cancelled in
 * the same breath, because a timer that fires after the user turns the extension off repaints what
 * was just cleared — which is how a setting reads as broken rather than as slow.
 *
 * Enabling rescans the supported open documents now rather than scheduling them: the user asked, and
 * a debounce is for keystrokes.
 *
 * A change to `fairux.debounceMs` needs nothing here. The scheduler reads it per schedule, so the
 * next one already uses the new value; a change that also re-timed the rescan in flight would
 * surprise whoever was mid-keystroke.
 */
export function applyConfigurationChange<Doc>(
  options: ConfigurationChangeOptions<Doc>,
): ConfigurationChangeOutcome {
  if (!options.affectsFairux) return { handled: false, cleared: 0, rescanned: 0 };

  if (!options.isEnabled) {
    options.scheduler.cancelAll();
    let cleared = 0;
    for (const doc of options.documents()) {
      options.clear(doc);
      cleared += 1;
    }
    return { handled: true, cleared, rescanned: 0 };
  }

  let rescanned = 0;
  for (const doc of options.documents()) {
    if (!options.isSupported(doc)) continue;
    options.refresh(doc);
    rescanned += 1;
  }
  return { handled: true, cleared: 0, rescanned };
}

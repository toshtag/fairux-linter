/**
 * A journey file: an ordered flow, named as documents that already exist on disk.
 *
 * JSON only, and data only. A `.ts` or `.mjs` journey file would be executable code loaded to
 * describe an input, which is the same mistake config auto-discovery already stopped making — and
 * there is nothing a journey needs to compute.
 *
 * **Nothing here fetches anything.** A step names a path, never a URL, and the CLI does not launch a
 * browser, follow a link, or resolve a redirect. `url` is metadata about where the caller captured
 * the step, so a report can say where it came from; it is not an instruction to go there.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { JourneyTransition } from "@fairux/core";

/** A journey file that cannot be read as one. Refused before any step is parsed. */
export class JourneyFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JourneyFileError";
  }
}

/** One step, after the file has been validated and its path resolved. */
export interface JourneyFileStep {
  readonly id: string;
  readonly order: number;
  /** Absolute path the file is read from. */
  readonly path: string;
  /** The path as the journey file wrote it, which is what the report shows. */
  readonly reportPath: string;
  readonly url?: string;
  readonly location?: string;
  readonly actionLabel?: string;
  readonly transition?: JourneyTransition;
}

export interface ParsedJourneyFile {
  readonly steps: readonly JourneyFileStep[];
}

const TOP_LEVEL_KEYS = new Set(["steps"]);
const STEP_KEYS = new Set(["id", "order", "file", "url", "location", "actionLabel", "transition"]);
const TRANSITION_KEYS = new Set(["kind", "note"]);
const TRANSITION_KINDS = new Set(["navigation", "in-page", "unknown"]);

// A scheme is what separates "a file called `https:`" from an instruction to go and get something.
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, at: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new JourneyFileError(`${at}: unknown field "${key}"`);
    }
  }
}

function readOptionalString(
  step: Record<string, unknown>,
  key: string,
  at: string,
): string | undefined {
  const value = step[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new JourneyFileError(`${at}: ${key} must be a non-empty string`);
  }
  return value;
}

function readTransition(value: unknown, at: string): JourneyTransition | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) throw new JourneyFileError(`${at}: transition must be an object`);
  assertKnownKeys(value, TRANSITION_KEYS, `${at}.transition`);
  const kind = value.kind;
  if (typeof kind !== "string" || !TRANSITION_KINDS.has(kind)) {
    throw new JourneyFileError(
      `${at}: transition.kind must be one of navigation, in-page, unknown`,
    );
  }
  const note = readOptionalString(value, "note", `${at}.transition`);
  return Object.freeze({
    kind: kind as JourneyTransition["kind"],
    ...(note !== undefined ? { note } : {}),
  });
}

/**
 * Read a journey file into resolved steps.
 *
 * Duplicate ids and duplicate orders are **not** checked here. The engine refuses both, and a second
 * copy of that rule in the CLI would be a second place for it to drift — the engine's message is the
 * one a reader should see, because the engine is what would have been wrong.
 */
export function parseJourneyFile(contents: string, journeyPath: string): ParsedJourneyFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new JourneyFileError(
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isPlainRecord(parsed)) throw new JourneyFileError("a journey file must be a JSON object");
  assertKnownKeys(parsed, TOP_LEVEL_KEYS, "journey");

  const rawSteps = parsed.steps;
  if (!Array.isArray(rawSteps)) throw new JourneyFileError("journey.steps must be an array");
  if (rawSteps.length === 0) {
    // The engine refuses this too. Refused here as well because the message can name the file, and
    // "a journey with no steps" is the one input a user is most likely to produce by generating one.
    throw new JourneyFileError("a journey must have at least one step");
  }

  const base = dirname(resolve(journeyPath));
  const steps = rawSteps.map((raw, index) => {
    const at = `journey.steps[${index}]`;
    if (!isPlainRecord(raw)) throw new JourneyFileError(`${at}: must be an object`);
    assertKnownKeys(raw, STEP_KEYS, at);

    const id = readOptionalString(raw, "id", at);
    if (id === undefined) throw new JourneyFileError(`${at}: id is required`);
    if (!Number.isInteger(raw.order)) {
      throw new JourneyFileError(`${at}: order must be an integer`);
    }
    const file = readOptionalString(raw, "file", at);
    if (file === undefined) throw new JourneyFileError(`${at}: file is required`);
    if (SCHEME.test(file)) {
      throw new JourneyFileError(
        `${at}: file "${file}" looks like a URL. A journey names documents already on disk — ` +
          `the CLI does not fetch anything or launch a browser`,
      );
    }

    const path = isAbsolute(file) ? file : resolve(base, file);
    if (!existsSync(path) || !statSync(path).isFile()) {
      // Checked before any step is scanned. A flow that reported three of four steps and then
      // failed would have already printed a partial journey as if it were one.
      throw new JourneyFileError(`${at}: file "${file}" does not exist`);
    }

    const url = readOptionalString(raw, "url", at);
    const location = readOptionalString(raw, "location", at);
    const actionLabel = readOptionalString(raw, "actionLabel", at);
    const transition = readTransition(raw.transition, at);

    return Object.freeze({
      id,
      order: raw.order as number,
      path,
      reportPath: file,
      ...(url !== undefined ? { url } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(actionLabel !== undefined ? { actionLabel } : {}),
      ...(transition !== undefined ? { transition } : {}),
    });
  });

  return Object.freeze({ steps: Object.freeze(steps) });
}

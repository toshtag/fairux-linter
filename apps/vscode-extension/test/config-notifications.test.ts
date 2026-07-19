import { describe, expect, it } from "vitest";
import {
  type ConfigNotification,
  ConfigNotificationTracker,
  configNotificationKey,
  formatConfigNotification,
  sanitizeConfigNotification,
} from "../src/config-notifications.js";

const esc = String.fromCharCode(0x1b);
const rlo = String.fromCharCode(0x202e);
const malicious = `unknown\n[FairUX] Config error: forged${esc}[31m${rlo}`;

describe("sanitizeConfigNotification", () => {
  it("sanitizes path and message for one-line VS Code display", () => {
    const result = sanitizeConfigNotification({
      level: "error",
      path: `/tmp/${malicious}`,
      message: malicious,
    });

    for (const value of [result.path, result.message]) {
      expect(value).not.toContain("\n");
      expect(value).not.toContain("\r");
      expect(value).not.toContain(esc);
      expect(value).not.toContain(rlo);
      expect(value).toContain("unknown");
      expect(value).toContain("forged");
    }
  });
});

describe("config notification formatting and keys", () => {
  it("formats a single safe output-channel line", () => {
    const notification = sanitizeConfigNotification({
      level: "warn",
      path: malicious,
      message: malicious,
    });

    const line = formatConfigNotification(notification);
    expect(line).toContain("[FairUX] Config warning:");
    expect(line).not.toContain("\n");
    expect(line).not.toContain(esc);
    expect(line).not.toContain(rlo);
  });

  it("keys by level, path, and message", () => {
    const base: ConfigNotification = { level: "error", path: "a", message: "b" };
    expect(configNotificationKey(base)).not.toBe(
      configNotificationKey({ level: "warn", path: "a", message: "b" }),
    );
    expect(configNotificationKey(base)).not.toBe(
      configNotificationKey({ level: "error", path: "other", message: "b" }),
    );
    expect(configNotificationKey(base)).not.toBe(
      configNotificationKey({ level: "error", path: "a", message: "other" }),
    );
  });
});

describe("ConfigNotificationTracker", () => {
  it("deduplicates warnings and errors until reset", () => {
    const tracker = new ConfigNotificationTracker();
    const warning: ConfigNotification = { level: "warn", path: "p", message: "m" };
    const error: ConfigNotification = { level: "error", path: "p", message: "m" };

    expect(tracker.shouldShow(warning)).toBe(true);
    expect(tracker.shouldShow(warning)).toBe(false);
    expect(tracker.shouldShow(error)).toBe(true);
    expect(tracker.shouldShow(error)).toBe(false);

    tracker.reset();
    expect(tracker.shouldShow(error)).toBe(true);
  });

  it("treats different paths and messages as separate notifications", () => {
    const tracker = new ConfigNotificationTracker();
    expect(tracker.shouldShow({ level: "error", path: "a", message: "m" })).toBe(true);
    expect(tracker.shouldShow({ level: "error", path: "b", message: "m" })).toBe(true);
    expect(tracker.shouldShow({ level: "error", path: "a", message: "n" })).toBe(true);
  });
});

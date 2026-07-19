import { sanitizeSingleLineDisplay } from "@fairux/config-node";

/** Config-related diagnostics surfaced to the user via VS Code notifications. */
export interface ConfigNotification {
  level: "warn" | "error";
  message: string;
  path: string;
}

export function sanitizeConfigNotification(notification: ConfigNotification): ConfigNotification {
  return {
    level: notification.level,
    path: sanitizeSingleLineDisplay(notification.path),
    message: sanitizeSingleLineDisplay(notification.message),
  };
}

export function configNotificationKey(notification: ConfigNotification): string {
  return JSON.stringify([notification.level, notification.path, notification.message]);
}

export function formatConfigNotification(notification: ConfigNotification): string {
  const kind = notification.level === "error" ? "error" : "warning";
  return `[FairUX] Config ${kind}: ${notification.path} - ${notification.message}`;
}

export class ConfigNotificationTracker {
  readonly #shown = new Set<string>();

  shouldShow(notification: ConfigNotification): boolean {
    const key = configNotificationKey(notification);
    if (this.#shown.has(key)) return false;
    this.#shown.add(key);
    return true;
  }

  reset(): void {
    this.#shown.clear();
  }
}

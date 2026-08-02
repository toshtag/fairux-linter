import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function readManifest(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/**
 * The permissions that would turn this from "scan the page I clicked on" into something that watches
 * a person browse.
 *
 * Named rather than left to the `toEqual` above, because a diff of two arrays does not say which
 * addition was the serious one. Observing requests needs one of these, and the decision not to ask
 * for any of them is what keeps the `network` capability unavailable — see
 * docs/reference/security-boundary.md#the-network-capability-and-why-it-stays-unavailable.
 */
const REFUSED_PERMISSIONS = [
  "webRequest",
  "webRequestBlocking",
  "declarativeNetRequest",
  "declarativeNetRequestFeedback",
  "debugger",
  "<all_urls>",
  "tabs",
  "webNavigation",
  "cookies",
  "history",
];

function expectLeastPrivilegeManifest(manifest: Record<string, unknown>): void {
  expect(manifest.permissions).toEqual(["activeTab", "scripting"]);
  expect(manifest).not.toHaveProperty("content_scripts");
  expect(manifest).not.toHaveProperty("host_permissions");
  expect(manifest).not.toHaveProperty("optional_host_permissions");
  expect(manifest).not.toHaveProperty("optional_permissions");
  expect(manifest.action).toMatchObject({ default_popup: "popup.html" });

  const declared = JSON.stringify(manifest);
  for (const permission of REFUSED_PERMISSIONS) {
    expect(declared, `manifest declares refused permission "${permission}"`).not.toContain(
      `"${permission}"`,
    );
  }
}

describe("Chrome extension build contract", () => {
  it("keeps the source manifest least-privilege", () => {
    expectLeastPrivilegeManifest(readManifest(resolve(root, "static/manifest.json")));
  });

  it("keeps the built manifest least-privilege", () => {
    expectLeastPrivilegeManifest(readManifest(resolve(root, "dist/manifest.json")));
  });

  it("produces a loadable popup and programmatically injectable content script", () => {
    expect(existsSync(resolve(root, "dist/content.js"))).toBe(true);
    expect(existsSync(resolve(root, "dist/popup.js"))).toBe(true);
    expect(existsSync(resolve(root, "dist/popup.html"))).toBe(true);

    const popupHtml = readFileSync(resolve(root, "dist/popup.html"), "utf8");
    expect(popupHtml).toContain('<script src="popup.js"></script>');
  });
});

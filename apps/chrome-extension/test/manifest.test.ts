import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function readManifest(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function expectLeastPrivilegeManifest(manifest: Record<string, unknown>): void {
  expect(manifest.permissions).toEqual(["activeTab", "scripting"]);
  expect(manifest).not.toHaveProperty("content_scripts");
  expect(manifest).not.toHaveProperty("host_permissions");
  expect(manifest).not.toHaveProperty("optional_host_permissions");
  expect(manifest.action).toMatchObject({ default_popup: "popup.html" });
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

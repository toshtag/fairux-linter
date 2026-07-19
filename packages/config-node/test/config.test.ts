import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverConfig, parseJsonConfig } from "../src/index.js";

const discoverIn = (scanDir: string) => {
  const page = resolve(scanDir, "page.html");
  if (!existsSync(page)) writeFileSync(page, "<html></html>", "utf8");
  return discoverConfig(page);
};

describe("@fairux/config-node discovery", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "fairux-config-node-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads nearest regular fairux.config.json and returns descriptor-read contents", () => {
    mkdirSync(resolve(dir, ".git"));
    writeFileSync(resolve(dir, "fairux.config.json"), '{"includeExperimental":true}', "utf8");
    const result = discoverIn(dir);
    expect(result.configPath).toBe(resolve(dir, "fairux.config.json"));
    expect(result.contents).toBe('{"includeExperimental":true}');
  });

  it("warns about executable config but does not auto-load it", () => {
    mkdirSync(resolve(dir, ".git"));
    writeFileSync(resolve(dir, "fairux.config.ts"), "export default {};\n", "utf8");
    const result = discoverIn(dir);
    expect(result.configPath).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "warn",
        path: resolve(dir, "fairux.config.ts"),
      }),
    );
  });

  it("fails closed on symlink and dangling symlink JSON configs", () => {
    mkdirSync(resolve(dir, ".git"));
    writeFileSync(resolve(dir, "real.json"), "{}", "utf8");
    symlinkSync(resolve(dir, "real.json"), resolve(dir, "fairux.config.json"));
    expect(discoverIn(dir).diagnostics).toContainEqual(expect.objectContaining({ level: "error" }));

    rmSync(resolve(dir, "fairux.config.json"));
    symlinkSync(resolve(dir, "missing.json"), resolve(dir, "fairux.config.json"));
    expect(discoverIn(dir).diagnostics).toContainEqual(expect.objectContaining({ level: "error" }));
  });

  it("fails closed on non-regular or oversized JSON configs", () => {
    mkdirSync(resolve(dir, ".git"));
    mkdirSync(resolve(dir, "fairux.config.json"));
    expect(discoverIn(dir).diagnostics).toContainEqual(expect.objectContaining({ level: "error" }));

    rmSync(resolve(dir, "fairux.config.json"), { recursive: true, force: true });
    writeFileSync(resolve(dir, "fairux.config.json"), "{}".padEnd(1024 * 1024 + 1, " "), "utf8");
    expect(discoverIn(dir).diagnostics).toContainEqual(
      expect.objectContaining({ level: "error", message: expect.stringMatching(/limit/i) }),
    );
  });

  it("bounds upward discovery at package.json unless a repo root is found", () => {
    writeFileSync(resolve(dir, "fairux.config.json"), "{}", "utf8");
    const project = resolve(dir, "project");
    mkdirSync(resolve(project, "sub"), { recursive: true });
    writeFileSync(resolve(project, "package.json"), "{}", "utf8");
    expect(discoverIn(resolve(project, "sub")).configPath).toBeUndefined();

    mkdirSync(resolve(dir, ".git"));
    expect(discoverIn(resolve(project, "sub")).configPath).toBe(resolve(dir, "fairux.config.json"));
  });
});

describe("@fairux/config-node strict validation", () => {
  it("rejects top-level arrays and rule override arrays", () => {
    expect(() => parseJsonConfig("[]", "s")).toThrow(/must export an object.*array/i);
    expect(() => parseJsonConfig('{"rules":{"consent/checked-checkbox":[]}}', "s")).toThrow(
      /must be a boolean or an object.*array/i,
    );
  });

  it("rejects invalid config structure", () => {
    expect(() => parseJsonConfig('{"unknownKey":1}', "s")).toThrow(/unknown top-level/i);
    expect(() => parseJsonConfig('{"rules":[]}', "s")).toThrow(/"rules" must be an object/i);
    expect(() => parseJsonConfig('{"configVersion":99}', "s")).toThrow(/configVersion/i);
    expect(() => parseJsonConfig('{"rules":{"nonexistent/rule":false}}', "s")).toThrow(
      /unknown rule id/i,
    );
    expect(() =>
      parseJsonConfig('{"rules":{"consent/checked-checkbox":{"severity":"critical"}}}', "s"),
    ).toThrow(/severity must be one of/i);
    expect(() =>
      parseJsonConfig('{"rules":{"consent/checked-checkbox":{"enabled":"yes"}}}', "s"),
    ).toThrow(/enabled must be a boolean/i);
    expect(() =>
      parseJsonConfig('{"rules":{"consent/checked-checkbox":{"color":"red"}}}', "s"),
    ).toThrow(/unknown key "color"/i);
  });

  it("rejects prototype-pollution keys at any depth", () => {
    expect(() => parseJsonConfig('{"__proto__":{"x":1}}', "s")).toThrow(/forbidden key/i);
    expect(() => parseJsonConfig('{"rules":{"constructor":{}}}', "s")).toThrow(/forbidden key/i);
    expect(() => parseJsonConfig('{"a":{"b":{"prototype":1}}}', "s")).toThrow(/forbidden key/i);
  });

  it("accepts boolean and object rule overrides", () => {
    expect(
      parseJsonConfig('{"rules":{"consent/checked-checkbox":false}}', "s").rules?.[
        "consent/checked-checkbox"
      ],
    ).toBe(false);
    expect(
      parseJsonConfig(
        '{"configVersion":1,"includeExperimental":true,"rules":{"consent/checked-checkbox":{"severity":"low","enabled":true}}}',
        "s",
      ).rules?.["consent/checked-checkbox"],
    ).toEqual({ severity: "low", enabled: true });
  });
});

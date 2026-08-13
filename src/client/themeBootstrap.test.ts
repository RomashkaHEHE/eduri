import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const indexHtml = readFileSync(
  new URL("../../index.html", import.meta.url),
  "utf8",
);
const bootstrapMatch = indexHtml.match(
  /<script data-eduri-theme-bootstrap>([\s\S]*?)<\/script>/u,
);
if (!bootstrapMatch) throw new Error("inline theme bootstrap is missing");
const bootstrapSource = bootstrapMatch[1];
const bootstrapCspHash = `sha256-${createHash("sha256")
  .update(bootstrapSource, "utf8")
  .digest("base64")}`;
const nginxConfig = readFileSync(
  new URL("../../ops/nginx/eduri.ru.conf", import.meta.url),
  "utf8",
);

interface BootstrapOptions {
  legacy?: string;
  matchMediaThrows?: boolean;
  matchMediaUnavailable?: boolean;
  migrationDenied?: boolean;
  prefersDark?: boolean;
  readDeniedKeys?: readonly string[];
  removeDeniedKeys?: readonly string[];
  saved?: string;
  storageUnavailable?: boolean;
}

function runBootstrap(options: BootstrapOptions = {}) {
  const values = new Map<string, string>();
  if (options.saved !== undefined) values.set("eduri-theme-v1", options.saved);
  if (options.legacy !== undefined) {
    values.set("eduri-board-theme", options.legacy);
  }
  const storage = {
    getItem: vi.fn((key: string) => {
      if (options.readDeniedKeys?.includes(key)) {
        throw new Error(`storage read denied for ${key}`);
      }
      return values.get(key) ?? null;
    }),
    removeItem: vi.fn((key: string) => {
      if (options.removeDeniedKeys?.includes(key)) {
        throw new Error(`storage removal denied for ${key}`);
      }
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      if (options.migrationDenied) throw new Error("storage write denied");
      values.set(key, value);
    }),
  };
  const root = {
    dataset: {} as Record<string, string>,
    style: { backgroundColor: "", colorScheme: "" },
  };
  const themeColor = { content: "", name: "" };
  const appendChild = vi.fn();
  const createElement = vi.fn(() => themeColor);
  const matchMedia = vi.fn(() => {
    if (options.matchMediaThrows) throw new Error("media query unavailable");
    return { matches: options.prefersDark ?? false };
  });
  const windowObject: Record<string, unknown> = {};
  Object.defineProperty(windowObject, "localStorage", {
    get() {
      if (options.storageUnavailable) throw new Error("storage unavailable");
      return storage;
    },
  });
  if (!options.matchMediaUnavailable) windowObject.matchMedia = matchMedia;

  vm.runInNewContext(bootstrapSource, {
    document: {
      createElement,
      documentElement: root,
      head: { appendChild },
    },
    window: windowObject,
  });

  return {
    appendChild,
    createElement,
    matchMedia,
    root,
    storage,
    themeColor,
    values,
  };
}

describe("inline theme bootstrap", () => {
  it("is synchronous, self-contained, and precedes the application entry point", () => {
    const bootstrapIndex = indexHtml.indexOf("<script data-eduri-theme-bootstrap>");
    const applicationIndex = indexHtml.indexOf(
      '<script type="module" src="/src/client/main.tsx"></script>',
    );

    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(applicationIndex).toBeGreaterThan(bootstrapIndex);
    expect(indexHtml).not.toContain("/theme-init.js");
    expect(indexHtml).not.toContain('<meta name="theme-color"');
  });

  it("is explicitly allowed by the production content security policy", () => {
    expect(nginxConfig).toContain(`'${bootstrapCspHash}'`);
  });

  it("applies the saved dark theme before the application starts", () => {
    const result = runBootstrap({ saved: "dark" });

    expect(result.root.dataset.theme).toBe("dark");
    expect(result.root.style.colorScheme).toBe("dark");
    expect(result.root.style.backgroundColor).toBe("#171816");
    expect(result.themeColor.name).toBe("theme-color");
    expect(result.themeColor.content).toBe("#171816");
    expect(result.createElement).toHaveBeenCalledWith("meta");
    expect(result.appendChild).toHaveBeenCalledWith(result.themeColor);
    expect(result.matchMedia).not.toHaveBeenCalled();
  });

  it("migrates the legacy preference without changing the selected theme", () => {
    const result = runBootstrap({ legacy: "light", prefersDark: true });

    expect(result.root.dataset.theme).toBe("light");
    expect(result.values.get("eduri-theme-v1")).toBe("light");
    expect(result.values.has("eduri-board-theme")).toBe(false);
    expect(result.matchMedia).not.toHaveBeenCalled();
  });

  it("removes a legacy value when the canonical preference is valid", () => {
    const result = runBootstrap({ saved: "dark", legacy: "light" });

    expect(result.root.dataset.theme).toBe("dark");
    expect(result.values.get("eduri-theme-v1")).toBe("dark");
    expect(result.values.has("eduri-board-theme")).toBe(false);
  });

  it("keeps using a readable legacy preference when migration is denied", () => {
    const result = runBootstrap({ legacy: "dark", migrationDenied: true });

    expect(result.root.dataset.theme).toBe("dark");
    expect(result.values.has("eduri-theme-v1")).toBe(false);
    expect(result.values.get("eduri-board-theme")).toBe("dark");
  });

  it("uses the operating-system theme when storage has no valid preference", () => {
    const result = runBootstrap({ saved: "invalid", prefersDark: true });

    expect(result.root.dataset.theme).toBe("dark");
    expect(result.root.style.colorScheme).toBe("dark");
    expect(result.themeColor.content).toBe("#171816");
    expect(result.matchMedia).toHaveBeenCalledWith(
      "(prefers-color-scheme: dark)",
    );
    expect(result.values.has("eduri-theme-v1")).toBe(false);
  });

  it("cleans invalid canonical and legacy values before using the OS theme", () => {
    const result = runBootstrap({ saved: "invalid", legacy: "invalid" });

    expect(result.root.dataset.theme).toBe("light");
    expect(result.values.size).toBe(0);
  });

  it("cleans invalid values independently when one removal is denied", () => {
    const result = runBootstrap({
      saved: "invalid",
      legacy: "invalid",
      removeDeniedKeys: ["eduri-theme-v1"],
    });

    expect(result.root.dataset.theme).toBe("light");
    expect(result.values.get("eduri-theme-v1")).toBe("invalid");
    expect(result.values.has("eduri-board-theme")).toBe(false);
  });

  it("falls back without throwing when the legacy preference cannot be read", () => {
    const result = runBootstrap({
      saved: "invalid",
      legacy: "dark",
      prefersDark: false,
      readDeniedKeys: ["eduri-board-theme"],
    });

    expect(result.root.dataset.theme).toBe("light");
    expect(result.values.has("eduri-theme-v1")).toBe(false);
    expect(result.values.get("eduri-board-theme")).toBe("dark");
  });

  it("still applies the operating-system theme when storage is unavailable", () => {
    const result = runBootstrap({ prefersDark: true, storageUnavailable: true });

    expect(result.root.dataset.theme).toBe("dark");
    expect(result.root.style.colorScheme).toBe("dark");
    expect(result.themeColor.content).toBe("#171816");
  });

  it.each([
    { matchMediaUnavailable: true },
    { matchMediaThrows: true },
  ])("falls back to light when the OS preference cannot be read", (options) => {
    const result = runBootstrap(options);

    expect(result.root.dataset.theme).toBe("light");
    expect(result.root.style.backgroundColor).toBe("#f5f7f9");
    expect(result.themeColor.content).toBe("#f5f7f9");
  });
});

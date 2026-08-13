// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const siteStyles = readFileSync(
  resolve(process.cwd(), "src", "client", "styles.css"),
  "utf8",
);
const codeStyles = readFileSync(
  resolve(process.cwd(), "src", "client", "components", "CodeWorkspace.css"),
  "utf8",
);

function declarationsFrom(text: string, selectorStart: string) {
  const selectorIndex = text.indexOf(selectorStart);
  if (selectorIndex < 0) throw new Error(`Missing CSS selector: ${selectorStart}`);
  const blockStart = text.indexOf("{", selectorIndex);
  const blockEnd = text.indexOf("}", blockStart);
  if (blockStart < 0 || blockEnd < 0) {
    throw new Error(`Incomplete CSS block: ${selectorStart}`);
  }
  return new Map(
    [...text.slice(blockStart + 1, blockEnd).matchAll(
      /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi,
    )].map((match) => [match[1], match[2].trim()]),
  );
}

function hexChannels(value: string) {
  const match = /^#([\da-f]{6})$/i.exec(value);
  if (!match) throw new Error(`Expected a six-digit hex color, received ${value}`);
  return [0, 2, 4].map((offset) =>
    Number.parseInt(match[1].slice(offset, offset + 2), 16) / 255);
}

function luminance(value: string) {
  const [red, green, blue] = hexChannels(value).map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string) {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function channelSpread(value: string) {
  const channels = hexChannels(value).map((channel) => channel * 255);
  return Math.max(...channels) - Math.min(...channels);
}

function token(tokens: Map<string, string>, name: string) {
  const value = tokens.get(name);
  if (!value) throw new Error(`Missing CSS token ${name}`);
  return value;
}

describe("site theme CSS contract", () => {
  it("keeps large dark surfaces on a neutral graphite scale", () => {
    const dark = declarationsFrom(siteStyles, ':root[data-theme="dark"] {');
    const call = declarationsFrom(
      siteStyles,
      '[data-theme="dark"] .guest-room__call,',
    );
    const board = declarationsFrom(siteStyles, ".board-v2--dark {");
    const code = declarationsFrom(
      codeStyles,
      '.full-code-workspace[data-code-theme="dark"],',
    );
    const surfaces = [
      [dark, [
        "--background",
        "--surface",
        "--control-bg",
        "--sidebar",
        "--sidebar-hover",
        "--sidebar-active",
        "--surface-raised",
        "--surface-hover",
        "--surface-subtle",
      ]],
      [call, [
        "--call-shell-bg",
        "--call-stage-bg",
        "--call-participant-bg",
        "--call-placeholder-bg",
        "--call-icon-bg",
        "--call-control-bg",
        "--call-control-hover-bg",
      ]],
      [board, [
        "--board-style-panel",
        "--board-style-panel-muted",
        "--board-style-panel-subtle",
        "--board-style-checker-a",
        "--board-style-checker-b",
      ]],
      [code, [
        "--code-workspace-bg",
        "--code-explorer-bg",
        "--code-console-bg",
        "--code-surface",
        "--code-surface-muted",
        "--code-surface-hover",
        "--code-surface-active",
      ]],
    ] as const;

    for (const [tokens, names] of surfaces) {
      for (const name of names) {
        const value = token(tokens, name);
        expect(channelSpread(value), `${name} (${value})`).toBeLessThanOrEqual(6);
      }
    }
  });

  it("keeps global actions and sidebar text readable in both themes", () => {
    const light = declarationsFrom(siteStyles, ":root {");
    const dark = declarationsFrom(siteStyles, ':root[data-theme="dark"] {');

    for (const tokens of [light, dark]) {
      expect(contrast(token(tokens, "--on-accent"), token(tokens, "--accent-fill")))
        .toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(tokens, "--on-accent"), token(tokens, "--accent-fill-hover")))
        .toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(tokens, "--on-danger"), token(tokens, "--danger-fill")))
        .toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(tokens, "--sidebar-text"), token(tokens, "--sidebar")))
        .toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(tokens, "--sidebar-muted"), token(tokens, "--sidebar")))
        .toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(tokens, "--sidebar-active-text"), token(tokens, "--sidebar-active")))
        .toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(tokens, "--sidebar-hover-text"), token(tokens, "--sidebar-hover")))
        .toBeGreaterThanOrEqual(4.5);
    }

    expect(contrast(token(light, "--control-text-muted"), "#edf1f5"))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrast(token(dark, "--control-text-muted"), token(dark, "--surface-subtle")))
      .toBeGreaterThanOrEqual(4.5);
    expect(siteStyles).toContain(
      ".button--primary { color: var(--on-accent); background: var(--accent-fill); }",
    );
    expect(siteStyles).toContain(
      ".button--danger { color: var(--on-danger); background: var(--danger-fill); }",
    );
  });

  it("preserves themed form states, card affordances, and the light sidebar", () => {
    expect(siteStyles).toContain(
      "border: 1px solid var(--control-border)",
    );
    expect(siteStyles).toContain(
      ".field input:hover, .field textarea:hover, .field select:hover { border-color: var(--control-border-hover); }",
    );
    expect(siteStyles).toContain(
      ".field input:focus, .field textarea:focus, .field select:focus { border-color: var(--control-border-focus); }",
    );
    expect(siteStyles).toContain(
      ".field--error input, .field--error textarea { border-color: var(--control-border-error); }",
    );
    expect(siteStyles).not.toContain('[data-theme="dark"] .field input,');
    expect(siteStyles).toContain(
      ".student-material-card:hover { border-color: var(--border-hover); box-shadow: var(--shadow-card-hover); }",
    );
    expect(siteStyles).toContain("box-shadow: var(--shadow-side-panel)");
    expect(siteStyles).toContain("box-shadow: var(--shadow-dock)");
    expect(siteStyles).toContain("color: var(--sidebar-text); background: var(--sidebar)");
    expect(siteStyles).toContain(
      ".room-resource-gate span { color: var(--muted); font-size: 12px; }",
    );
  });
});

describe("Code workspace theme CSS contract", () => {
  it("keeps small text and interactive boundaries visible", () => {
    const light = declarationsFrom(
      codeStyles,
      '.full-code-workspace[data-code-theme="light"],',
    );
    const dark = declarationsFrom(
      codeStyles,
      '.full-code-workspace[data-code-theme="dark"],',
    );

    for (const tokens of [light, dark]) {
      const muted = token(tokens, "--code-muted");
      for (const surface of [
        "--code-workspace-bg",
        "--code-explorer-bg",
        "--code-console-bg",
        "--code-surface",
      ]) {
        expect(contrast(muted, token(tokens, surface)))
          .toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(token(tokens, "--code-accent"), token(tokens, "--code-accent-soft")))
        .toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(tokens, "--code-border-strong"), token(tokens, "--code-surface")))
        .toBeGreaterThanOrEqual(3);
      expect(contrast(token(tokens, "--code-border-strong"), token(tokens, "--code-console-bg")))
        .toBeGreaterThanOrEqual(3);
    }
  });

  it("does not suppress keyboard focus on menus or lesson output actions", () => {
    expect(codeStyles).not.toMatch(
      /\.code-explorer-menu\s*>\s*button:focus-visible\s*\{[^}]*outline\s*:\s*0/isu,
    );
    expect(codeStyles).not.toMatch(
      /\.lesson-code-workspace[^{}]*\.code-output__head button:focus-visible\s*\{[^}]*outline\s*:\s*0/isu,
    );
  });
});

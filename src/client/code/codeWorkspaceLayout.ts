export interface CodeWorkspaceLayout {
  readonly version: 1;
  readonly explorerWidth: number;
  readonly explorerHeight: number;
  readonly consoleHeight: number;
  readonly testsWidth: number;
  readonly testsHeight: number;
}

export interface CodeWorkspaceLayoutReadableStorage {
  getItem(key: string): string | null;
}

export interface CodeWorkspaceLayoutWritableStorage {
  setItem(key: string, value: string): void;
}

export interface CodeWorkspacePanelConstraints {
  readonly minimumSize?: number;
  readonly minimumRemainingSize?: number;
  readonly maximumSize?: number;
  readonly maximumFraction?: number;
  readonly dividerSize?: number;
}

export interface CodeWorkspaceLayoutDimensions {
  readonly workspaceWidth: number;
  readonly workspaceHeight: number;
  readonly consoleWidth?: number;
  readonly consoleHeight?: number;
  readonly compactExplorerAvailableHeight?: number;
}

export interface CodeWorkspaceLayoutConstraints {
  readonly explorerWidth?: CodeWorkspacePanelConstraints;
  readonly explorerHeight?: CodeWorkspacePanelConstraints;
  readonly consoleHeight?: CodeWorkspacePanelConstraints;
  readonly testsWidth?: CodeWorkspacePanelConstraints;
  readonly testsHeight?: CodeWorkspacePanelConstraints;
}

export const CODE_WORKSPACE_LAYOUT_STORAGE_KEY =
  "eduri-code-workspace-layout-v1";

export const DEFAULT_CODE_WORKSPACE_LAYOUT: CodeWorkspaceLayout = Object.freeze({
  version: 1,
  explorerWidth: 220,
  explorerHeight: 110,
  consoleHeight: 220,
  testsWidth: 360,
  testsHeight: 240,
});

const STORAGE_VERSION = 1;
const MAX_SERIALIZED_LENGTH = 1_024;
const MAX_STORED_PANEL_SIZE = 100_000;
const LAYOUT_KEYS = [
  "version",
  "explorerWidth",
  "explorerHeight",
  "consoleHeight",
  "testsWidth",
  "testsHeight",
] as const;

interface ResolvedPanelConstraints {
  readonly minimumSize: number;
  readonly minimumRemainingSize: number;
  readonly maximumSize?: number;
  readonly maximumFraction?: number;
  readonly dividerSize: number;
}

const EXPLORER_WIDTH_CONSTRAINTS: ResolvedPanelConstraints = {
  minimumSize: 150,
  minimumRemainingSize: 320,
  maximumSize: 420,
  maximumFraction: 0.4,
  dividerSize: 8,
};
const EXPLORER_HEIGHT_CONSTRAINTS: ResolvedPanelConstraints = {
  minimumSize: 80,
  minimumRemainingSize: 220,
  maximumSize: 320,
  dividerSize: 8,
};
const CONSOLE_HEIGHT_CONSTRAINTS: ResolvedPanelConstraints = {
  minimumSize: 180,
  minimumRemainingSize: 260,
  dividerSize: 8,
};
const TESTS_WIDTH_CONSTRAINTS: ResolvedPanelConstraints = {
  minimumSize: 300,
  minimumRemainingSize: 340,
  dividerSize: 8,
};
const TESTS_HEIGHT_CONSTRAINTS: ResolvedPanelConstraints = {
  minimumSize: 190,
  minimumRemainingSize: 150,
  dividerSize: 8,
};

function copyDefaults(): CodeWorkspaceLayout {
  return { ...DEFAULT_CODE_WORKSPACE_LAYOUT };
}

function hasExactKeys(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record);
  return keys.length === LAYOUT_KEYS.length
    && LAYOUT_KEYS.every((key) => Object.hasOwn(record, key));
}

function isStoredPanelSize(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_STORED_PANEL_SIZE;
}

export function parseCodeWorkspaceLayout(
  serialized: string | null,
): CodeWorkspaceLayout | null {
  if (!serialized || serialized.length > MAX_SERIALIZED_LENGTH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    !hasExactKeys(record)
    || record.version !== STORAGE_VERSION
    || !isStoredPanelSize(record.explorerWidth)
    || !isStoredPanelSize(record.explorerHeight)
    || !isStoredPanelSize(record.consoleHeight)
    || !isStoredPanelSize(record.testsWidth)
    || !isStoredPanelSize(record.testsHeight)
  ) {
    return null;
  }
  return {
    version: 1,
    explorerWidth: record.explorerWidth,
    explorerHeight: record.explorerHeight,
    consoleHeight: record.consoleHeight,
    testsWidth: record.testsWidth,
    testsHeight: record.testsHeight,
  };
}

function browserStorage(): (CodeWorkspaceLayoutReadableStorage
  & CodeWorkspaceLayoutWritableStorage) | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadCodeWorkspaceLayout(
  storage?: CodeWorkspaceLayoutReadableStorage | null,
): CodeWorkspaceLayout {
  const target = storage === undefined ? browserStorage() : storage;
  if (!target) return copyDefaults();
  try {
    return parseCodeWorkspaceLayout(
      target.getItem(CODE_WORKSPACE_LAYOUT_STORAGE_KEY),
    ) ?? copyDefaults();
  } catch {
    return copyDefaults();
  }
}

function serializedLayout(layout: CodeWorkspaceLayout): string | null {
  if (
    layout.version !== STORAGE_VERSION
    || !isStoredPanelSize(layout.explorerWidth)
    || !isStoredPanelSize(layout.explorerHeight)
    || !isStoredPanelSize(layout.consoleHeight)
    || !isStoredPanelSize(layout.testsWidth)
    || !isStoredPanelSize(layout.testsHeight)
  ) {
    return null;
  }
  return JSON.stringify({
    version: STORAGE_VERSION,
    explorerWidth: layout.explorerWidth,
    explorerHeight: layout.explorerHeight,
    consoleHeight: layout.consoleHeight,
    testsWidth: layout.testsWidth,
    testsHeight: layout.testsHeight,
  });
}

export function persistCodeWorkspaceLayout(
  layout: CodeWorkspaceLayout,
  storage?: CodeWorkspaceLayoutWritableStorage | null,
): boolean {
  const serialized = serializedLayout(layout);
  if (serialized === null) return false;
  const target = storage === undefined ? browserStorage() : storage;
  if (!target) return false;
  try {
    target.setItem(CODE_WORKSPACE_LAYOUT_STORAGE_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}

function finiteNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function resolveConstraints(
  defaults: ResolvedPanelConstraints,
  overrides: CodeWorkspacePanelConstraints | undefined,
): ResolvedPanelConstraints {
  const maximumSize = overrides?.maximumSize === undefined
    ? defaults.maximumSize
    : finiteNonNegative(overrides.maximumSize, defaults.maximumSize ?? 0);
  const maximumFraction = overrides?.maximumFraction === undefined
    ? defaults.maximumFraction
    : Math.min(1, finiteNonNegative(
        overrides.maximumFraction,
        defaults.maximumFraction ?? 1,
      ));
  return {
    minimumSize: finiteNonNegative(
      overrides?.minimumSize ?? defaults.minimumSize,
      defaults.minimumSize,
    ),
    minimumRemainingSize: finiteNonNegative(
      overrides?.minimumRemainingSize ?? defaults.minimumRemainingSize,
      defaults.minimumRemainingSize,
    ),
    maximumSize,
    maximumFraction,
    dividerSize: finiteNonNegative(
      overrides?.dividerSize ?? defaults.dividerSize,
      defaults.dividerSize,
    ),
  };
}

function clampPanelSize(
  value: number,
  fallback: number,
  availableSize: number,
  defaults: ResolvedPanelConstraints,
  overrides?: CodeWorkspacePanelConstraints,
): number {
  const available = Math.max(0, Math.floor(
    finiteNonNegative(availableSize, 0),
  ));
  if (available === 0) return 0;
  const constraints = resolveConstraints(defaults, overrides);
  const divider = Math.min(available, Math.ceil(constraints.dividerSize));
  const capacity = available - divider;
  const minimum = Math.min(capacity, Math.ceil(constraints.minimumSize));
  const remainingMaximum = Math.max(
    0,
    capacity - Math.ceil(constraints.minimumRemainingSize),
  );
  const absoluteMaximum = constraints.maximumSize === undefined
    ? capacity
    : Math.min(capacity, Math.floor(constraints.maximumSize));
  const fractionalMaximum = constraints.maximumFraction === undefined
    ? capacity
    : Math.min(
        capacity,
        Math.floor(available * constraints.maximumFraction),
      );
  // When both pane minima cannot fit, the resized pane keeps its minimum and
  // the remaining pane receives all space left after that minimum.
  const maximum = Math.max(
    minimum,
    Math.min(remainingMaximum, absoluteMaximum, fractionalMaximum),
  );
  const candidate = Math.round(finiteNonNegative(value, fallback));
  return Math.max(minimum, Math.min(maximum, candidate));
}

export function clampExplorerWidth(
  value: number,
  availableWidth: number,
  constraints?: CodeWorkspacePanelConstraints,
): number {
  return clampPanelSize(
    value,
    DEFAULT_CODE_WORKSPACE_LAYOUT.explorerWidth,
    availableWidth,
    EXPLORER_WIDTH_CONSTRAINTS,
    constraints,
  );
}

export function clampExplorerHeight(
  value: number,
  availableHeight: number,
  constraints?: CodeWorkspacePanelConstraints,
): number {
  return clampPanelSize(
    value,
    DEFAULT_CODE_WORKSPACE_LAYOUT.explorerHeight,
    availableHeight,
    EXPLORER_HEIGHT_CONSTRAINTS,
    constraints,
  );
}

export function clampConsoleHeight(
  value: number,
  availableHeight: number,
  constraints?: CodeWorkspacePanelConstraints,
): number {
  return clampPanelSize(
    value,
    DEFAULT_CODE_WORKSPACE_LAYOUT.consoleHeight,
    availableHeight,
    CONSOLE_HEIGHT_CONSTRAINTS,
    constraints,
  );
}

export function clampTestsWidth(
  value: number,
  availableWidth: number,
  constraints?: CodeWorkspacePanelConstraints,
): number {
  return clampPanelSize(
    value,
    DEFAULT_CODE_WORKSPACE_LAYOUT.testsWidth,
    availableWidth,
    TESTS_WIDTH_CONSTRAINTS,
    constraints,
  );
}

export function clampTestsHeight(
  value: number,
  availableHeight: number,
  constraints?: CodeWorkspacePanelConstraints,
): number {
  return clampPanelSize(
    value,
    DEFAULT_CODE_WORKSPACE_LAYOUT.testsHeight,
    availableHeight,
    TESTS_HEIGHT_CONSTRAINTS,
    constraints,
  );
}

export function clampCodeWorkspaceLayout(
  layout: CodeWorkspaceLayout,
  dimensions: CodeWorkspaceLayoutDimensions,
  constraints: CodeWorkspaceLayoutConstraints = {},
): CodeWorkspaceLayout {
  const consoleHeight = clampConsoleHeight(
    layout.consoleHeight,
    dimensions.workspaceHeight,
    constraints.consoleHeight,
  );
  return {
    version: 1,
    explorerWidth: clampExplorerWidth(
      layout.explorerWidth,
      dimensions.workspaceWidth,
      constraints.explorerWidth,
    ),
    explorerHeight: clampExplorerHeight(
      layout.explorerHeight,
      dimensions.compactExplorerAvailableHeight ?? dimensions.workspaceHeight,
      constraints.explorerHeight,
    ),
    consoleHeight,
    testsWidth: clampTestsWidth(
      layout.testsWidth,
      dimensions.consoleWidth ?? dimensions.workspaceWidth,
      constraints.testsWidth,
    ),
    testsHeight: clampTestsHeight(
      layout.testsHeight,
      dimensions.consoleHeight ?? consoleHeight,
      constraints.testsHeight,
    ),
  };
}

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { Moon, Sun } from "lucide-react";

export type AppTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "eduri-theme-v1";
export const LEGACY_BOARD_THEME_STORAGE_KEY = "eduri-board-theme";

const THEME_COLORS: Readonly<Record<AppTheme, string>> = {
  light: "#f5f7f9",
  dark: "#171816",
};

interface ThemeContextValue {
  readonly theme: AppTheme;
  readonly setTheme: (theme: AppTheme) => void;
  readonly toggleTheme: () => void;
}

interface ThemeToggleProps {
  readonly className?: string;
  readonly variant?: "icon" | "nav";
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function parseTheme(value: unknown): AppTheme | null {
  return value === "light" || value === "dark" ? value : null;
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function removeStoredValue(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Storage cleanup is best-effort.
  }
}

export function storedTheme(storage: Storage | null): AppTheme | null {
  if (!storage) return null;

  let currentValue: string | null;
  try {
    currentValue = storage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }

  const currentTheme = parseTheme(currentValue);
  if (currentTheme) {
    try {
      if (storage.getItem(LEGACY_BOARD_THEME_STORAGE_KEY) !== null) {
        removeStoredValue(storage, LEGACY_BOARD_THEME_STORAGE_KEY);
      }
    } catch {
      // A readable current preference remains authoritative when cleanup fails.
    }
    return currentTheme;
  }

  let legacyValue: string | null;
  try {
    legacyValue = storage.getItem(LEGACY_BOARD_THEME_STORAGE_KEY);
  } catch {
    if (currentValue !== null) removeStoredValue(storage, THEME_STORAGE_KEY);
    return null;
  }

  const legacyTheme = parseTheme(legacyValue);
  if (legacyTheme) {
    try {
      storage.setItem(THEME_STORAGE_KEY, legacyTheme);
      removeStoredValue(storage, LEGACY_BOARD_THEME_STORAGE_KEY);
    } catch {
      // Keep using the readable legacy preference when migration is denied.
    }
    return legacyTheme;
  }

  if (currentValue !== null) removeStoredValue(storage, THEME_STORAGE_KEY);
  if (legacyValue !== null) {
    removeStoredValue(storage, LEGACY_BOARD_THEME_STORAGE_KEY);
  }
  return null;
}

function systemTheme(): AppTheme {
  if (
    typeof window === "undefined"
    || typeof window.matchMedia !== "function"
  ) return "light";
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

export function initialTheme(storage = browserStorage()): AppTheme {
  return storedTheme(storage) ?? systemTheme();
}

export function applyTheme(
  theme: AppTheme,
  target: Document | null = typeof document === "undefined" ? null : document,
): void {
  if (!target) return;
  const root = target.documentElement;
  const color = THEME_COLORS[theme];
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.style.backgroundColor = color;

  let meta = target.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = target.createElement("meta");
    meta.name = "theme-color";
    target.head.append(meta);
  }
  meta.content = color;
}

export function ThemeProvider({ children }: PropsWithChildren) {
  const [theme, setThemeState] = useState<AppTheme>(initialTheme);

  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useLayoutEffect(() => {
    if (typeof window === "undefined") return undefined;
    let media: MediaQueryList | null = null;
    try {
      media = typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    } catch {
      // A missing media-query implementation falls back to the light theme.
    }

    const reconcileTheme = () => {
      const nextTheme = initialTheme(browserStorage());
      applyTheme(nextTheme);
      setThemeState((currentTheme) =>
        currentTheme === nextTheme ? currentTheme : nextTheme);
    };
    const handleSystemChange = () => {
      reconcileTheme();
    };
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key !== null
        && event.key !== THEME_STORAGE_KEY
        && event.key !== LEGACY_BOARD_THEME_STORAGE_KEY
      ) return;
      reconcileTheme();
    };
    const handlePageShow = () => {
      reconcileTheme();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") reconcileTheme();
    };

    if (typeof media?.addEventListener === "function") {
      media.addEventListener("change", handleSystemChange);
    } else if (typeof media?.addListener === "function") {
      media.addListener(handleSystemChange);
    }
    window.addEventListener("storage", handleStorage);
    window.addEventListener("pageshow", handlePageShow);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    reconcileTheme();

    return () => {
      if (typeof media?.removeEventListener === "function") {
        media.removeEventListener("change", handleSystemChange);
      } else if (typeof media?.removeListener === "function") {
        media.removeListener(handleSystemChange);
      }
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("pageshow", handlePageShow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const setTheme = useCallback((nextTheme: AppTheme) => {
    applyTheme(nextTheme);
    setThemeState(nextTheme);
    const storage = browserStorage();
    try {
      storage?.setItem(THEME_STORAGE_KEY, nextTheme);
      storage?.removeItem(LEGACY_BOARD_THEME_STORAGE_KEY);
    } catch {
      // Theme changes remain available for the current tab.
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [setTheme, theme]);

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    setTheme,
    toggleTheme,
  }), [setTheme, theme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useOptionalTheme(): ThemeContextValue | null {
  return useContext(ThemeContext);
}

export function useTheme(): ThemeContextValue {
  const value = useOptionalTheme();
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}

export function ThemeToggle({
  className = "",
  variant = "icon",
}: ThemeToggleProps) {
  const { theme, toggleTheme } = useTheme();
  const dark = theme === "dark";
  const label = dark ? "Включить светлую тему" : "Включить тёмную тему";
  return (
    <button
      type="button"
      className={`${variant === "nav" ? "nav-link" : "icon-button"} theme-toggle ${className}`.trim()}
      aria-label={label}
      title={label}
      onClick={toggleTheme}
    >
      {dark ? <Sun size={18} /> : <Moon size={18} />}
      {variant === "nav" && <span>{dark ? "Светлая тема" : "Тёмная тема"}</span>}
    </button>
  );
}

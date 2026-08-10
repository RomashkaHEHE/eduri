import { useCallback, useEffect } from "react";

const HISTORY_GUARD_KEY = "__eduriBoardRiskGuard";
const DEFAULT_MESSAGE =
  "Локальная копия доски может быть потеряна при выходе. Сначала скачайте аварийную копию с панели доски. Всё равно выйти?";

function nextGuardState(guardId: string): Record<string, unknown> {
  const current =
    window.history.state
    && typeof window.history.state === "object"
    && !Array.isArray(window.history.state)
      ? window.history.state as Record<string, unknown>
      : {};
  const index = typeof current.idx === "number" && Number.isSafeInteger(current.idx)
    ? current.idx + 1
    : undefined;
  return {
    ...current,
    ...(index === undefined ? {} : { idx: index }),
    [HISTORY_GUARD_KEY]: guardId,
  };
}

export function useCriticalDataGuard(
  active: boolean,
  message = DEFAULT_MESSAGE,
): (action: () => void) => boolean {
  useEffect(() => {
    if (!active) return;
    const guardId = crypto.randomUUID();
    let leaving = false;
    window.history.pushState(
      nextGuardState(guardId),
      "",
      window.location.href,
    );

    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const popState = () => {
      if (leaving) return;
      if (window.confirm(message)) {
        leaving = true;
        // The first Back only removes the same-URL guard entry.
        window.history.back();
      } else {
        window.history.pushState(
          nextGuardState(guardId),
          "",
          window.location.href,
        );
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("popstate", popState);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("popstate", popState);
      if (
        !leaving
        && window.history.state?.[HISTORY_GUARD_KEY] === guardId
      ) {
        leaving = true;
        window.history.back();
      }
    };
  }, [active, message]);

  return useCallback((action: () => void) => {
    if (active && !window.confirm(message)) return false;
    action();
    return true;
  }, [active, message]);
}

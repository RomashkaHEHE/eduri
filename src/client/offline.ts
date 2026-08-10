export interface LocalStorageHealth {
  readonly persisted: boolean | null;
  readonly usage: number | null;
  readonly quota: number | null;
}

export async function requestDurableBrowserStorage(): Promise<LocalStorageHealth> {
  if (!navigator.storage) return { persisted: null, usage: null, quota: null };
  let persisted = typeof navigator.storage.persisted === "function"
    ? await navigator.storage.persisted()
    : null;
  if (!persisted && typeof navigator.storage.persist === "function") {
    persisted = await navigator.storage.persist();
  }
  const estimate = typeof navigator.storage.estimate === "function"
    ? await navigator.storage.estimate()
    : {};
  return {
    persisted,
    usage: typeof estimate.usage === "number" ? estimate.usage : null,
    quota: typeof estimate.quota === "number" ? estimate.quota : null,
  };
}

export function registerOfflineAppShell(): void {
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) return;
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    }).catch((error: unknown) => {
      console.error("Offline application cache could not be registered", error);
    });
  }, { once: true });
}

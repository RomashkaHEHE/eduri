import { describe, expect, it, vi } from "vitest";
import { deleteIndexedDb, openIndexedDb } from "./indexedDbLifecycle.js";

interface ControlledOpenRequest {
  result: IDBDatabase;
  error: DOMException | null;
  transaction: IDBTransaction | null;
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null;
  onsuccess: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onblocked: ((event: IDBVersionChangeEvent) => void) | null;
}

function controlledDatabase(): {
  readonly database: IDBDatabase;
  readonly close: ReturnType<typeof vi.fn>;
  getVersionChangeHandler(): ((event: IDBVersionChangeEvent) => void) | null;
} {
  const close = vi.fn();
  const value = {
    close,
    onversionchange: null as ((event: IDBVersionChangeEvent) => void) | null,
  };
  return {
    database: value as unknown as IDBDatabase,
    close,
    getVersionChangeHandler: () => value.onversionchange,
  };
}

function controlledOpenRequest(database: IDBDatabase): ControlledOpenRequest {
  return {
    result: database,
    error: null,
    transaction: null,
    onupgradeneeded: null,
    onsuccess: null,
    onerror: null,
    onblocked: null,
  };
}

function openFactory(request: ControlledOpenRequest): IDBFactory {
  return {
    open: vi.fn(() => request as unknown as IDBOpenDBRequest),
  } as unknown as IDBFactory;
}

describe("Board IndexedDB lifecycle", () => {
  it("keeps a blocked open pending until its eventual success", async () => {
    const controlled = controlledDatabase();
    const request = controlledOpenRequest(controlled.database);
    const opened = openIndexedDb({
      factory: openFactory(request),
      name: "controlled-open",
      version: 1,
      errorMessage: "open failed",
      upgrade: vi.fn(),
    });
    let outcome: "pending" | "fulfilled" | "rejected" = "pending";
    void opened.then(
      () => {
        outcome = "fulfilled";
      },
      () => {
        outcome = "rejected";
      },
    );

    request.onblocked?.({} as IDBVersionChangeEvent);
    await Promise.resolve();
    expect(outcome).toBe("pending");

    request.onsuccess?.(new Event("success"));
    await expect(opened).resolves.toBe(controlled.database);
    expect(outcome).toBe("fulfilled");

    controlled.getVersionChangeHandler()?.({} as IDBVersionChangeEvent);
    expect(controlled.close).toHaveBeenCalledTimes(1);
  });

  it("closes a late success handle after a terminal open error", async () => {
    const controlled = controlledDatabase();
    const request = controlledOpenRequest(controlled.database);
    const opened = openIndexedDb({
      factory: openFactory(request),
      name: "controlled-late-success",
      version: 1,
      errorMessage: "open failed",
      upgrade: vi.fn(),
    });
    const terminalError = new DOMException("terminal", "UnknownError");
    request.error = terminalError;

    request.onerror?.(new Event("error"));
    await expect(opened).rejects.toBe(terminalError);
    request.onsuccess?.(new Event("success"));

    expect(controlled.close).toHaveBeenCalledTimes(1);
  });

  it("keeps a blocked deletion pending until success", async () => {
    const request: ControlledOpenRequest = controlledOpenRequest(
      controlledDatabase().database,
    );
    const factory = {
      deleteDatabase: vi.fn(
        () => request as unknown as IDBOpenDBRequest,
      ),
    } as unknown as IDBFactory;
    const deleted = deleteIndexedDb(
      factory,
      "controlled-delete",
      "delete failed",
    );
    let settled = false;
    void deleted.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    request.onblocked?.({} as IDBVersionChangeEvent);
    await Promise.resolve();
    expect(settled).toBe(false);

    request.onsuccess?.(new Event("success"));
    await expect(deleted).resolves.toBeUndefined();
  });
});

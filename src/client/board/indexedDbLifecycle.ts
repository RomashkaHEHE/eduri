export interface OpenIndexedDbOptions {
  readonly factory: IDBFactory;
  readonly name: string;
  readonly version: number;
  readonly errorMessage: string;
  readonly upgrade: (
    database: IDBDatabase,
    event: IDBVersionChangeEvent,
  ) => void;
  readonly onVersionChange?: () => void;
}

/**
 * A blocked IndexedDB request is still live and may later succeed. Only a
 * success or error settles this promise, and a success arriving after a
 * terminal failure is closed instead of leaking a connection.
 */
export function openIndexedDb(
  options: OpenIndexedDbOptions,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = options.factory.open(options.name, options.version);
    let settled = false;
    let upgradeError: unknown;

    request.onupgradeneeded = (event) => {
      if (settled) return;
      try {
        options.upgrade(request.result, event);
      } catch (error) {
        upgradeError = error;
        try {
          request.transaction?.abort();
        } catch {
          // The terminal rejection below still prevents a late handle leak.
        }
        settled = true;
        reject(error);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        try {
          options.onVersionChange?.();
        } catch {
          // The connection is already closed; teardown cannot be undone.
        }
      };
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      resolve(database);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(
        upgradeError
        ?? request.error
        ?? new Error(options.errorMessage),
      );
    };
    request.onblocked = () => {
      // Another connection may close after receiving versionchange.
    };
  });
}

export function deleteIndexedDb(
  factory: IDBFactory,
  name: string,
  errorMessage: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    let settled = false;
    request.onsuccess = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error(errorMessage));
    };
    request.onblocked = () => {
      // Deletion remains pending until every older connection closes.
    };
  });
}

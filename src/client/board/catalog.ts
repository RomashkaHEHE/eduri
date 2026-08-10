import type { LessonSummary } from "../../shared/types";
import { deleteIndexedDb, openIndexedDb } from "./indexedDbLifecycle.js";

export interface BoardCatalogEntry {
  readonly key: string;
  readonly userId: string;
  readonly lessonId: string;
  readonly boardId: string;
  readonly generation: number;
  readonly schemaVersion: number;
  readonly capabilities: number;
  readonly permissions: number;
  readonly manifestDocumentKey: "manifest";
  readonly pageId: string;
  readonly pageDocumentKey: string;
  readonly lesson?: LessonSummary;
  readonly updatedAt: string;
}

interface BoardNamespaceEntry {
  readonly name: string;
  readonly userId: string;
  readonly boardId: string;
  readonly generation: number;
}

const CATALOG_DATABASE = "eduri-board-v2-catalog";
const CATALOG_VERSION = 1;
const BOARD_STORE = "boards";
const NAMESPACE_STORE = "namespaces";

function catalogKey(userId: string, lessonId: string): string {
  return `${userId}:${lessonId}`;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

async function openCatalog(): Promise<IDBDatabase> {
  return openIndexedDb({
    factory: indexedDB,
    name: CATALOG_DATABASE,
    version: CATALOG_VERSION,
    errorMessage: "Unable to open the Board catalog",
    upgrade: (database) => {
      if (!database.objectStoreNames.contains(BOARD_STORE)) {
        const boards = database.createObjectStore(BOARD_STORE, { keyPath: "key" });
        boards.createIndex("userId", "userId");
      }
      if (!database.objectStoreNames.contains(NAMESPACE_STORE)) {
        const namespaces = database.createObjectStore(NAMESPACE_STORE, { keyPath: "name" });
        namespaces.createIndex("userId", "userId");
      }
    },
  });
}

export async function getBoardCatalogEntry(
  userId: string,
  lessonId: string,
): Promise<BoardCatalogEntry | null> {
  const database = await openCatalog();
  try {
    const transaction = database.transaction(BOARD_STORE, "readonly");
    const completed = transactionComplete(transaction);
    const result = await requestResult(
      transaction.objectStore(BOARD_STORE).get(catalogKey(userId, lessonId)),
    ) as BoardCatalogEntry | undefined;
    await completed;
    return result ?? null;
  } finally {
    database.close();
  }
}

export async function putBoardCatalogEntry(
  entry: Omit<BoardCatalogEntry, "key" | "updatedAt">,
): Promise<BoardCatalogEntry> {
  const stored: BoardCatalogEntry = {
    ...entry,
    key: catalogKey(entry.userId, entry.lessonId),
    updatedAt: new Date().toISOString(),
  };
  const database = await openCatalog();
  try {
    const transaction = database.transaction(BOARD_STORE, "readwrite");
    transaction.objectStore(BOARD_STORE).put(stored);
    await transactionComplete(transaction);
    return stored;
  } finally {
    database.close();
  }
}

export async function registerBoardNamespace(
  identity: { userId: string; boardId: string; generation: number },
  name: string,
): Promise<void> {
  const database = await openCatalog();
  try {
    const transaction = database.transaction(NAMESPACE_STORE, "readwrite");
    const entry: BoardNamespaceEntry = {
      name,
      userId: identity.userId,
      boardId: identity.boardId,
      generation: identity.generation,
    };
    transaction.objectStore(NAMESPACE_STORE).put(entry);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function forgetBoardNamespace(name: string): Promise<void> {
  const database = await openCatalog();
  try {
    const transaction = database.transaction(NAMESPACE_STORE, "readwrite");
    transaction.objectStore(NAMESPACE_STORE).delete(name);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

function deleteDatabase(name: string): Promise<void> {
  return deleteIndexedDb(
    indexedDB,
    name,
    `IndexedDB database '${name}' could not be deleted`,
  );
}

export async function clearBoardDataForUser(userId: string): Promise<void> {
  const database = await openCatalog();
  let boardKeys: IDBValidKey[] = [];
  let namespaceNames: string[] = [];
  try {
    const readTransaction = database.transaction([BOARD_STORE, NAMESPACE_STORE], "readonly");
    const readCompleted = transactionComplete(readTransaction);
    const boards = readTransaction.objectStore(BOARD_STORE).index("userId");
    const namespaces = readTransaction.objectStore(NAMESPACE_STORE).index("userId");
    const boardKeysRequest = requestResult(boards.getAllKeys(IDBKeyRange.only(userId)));
    const namespaceRequest = requestResult(
      namespaces.getAll(IDBKeyRange.only(userId)),
    ) as Promise<BoardNamespaceEntry[]>;
    const [storedBoardKeys, namespaceEntries] = await Promise.all([
      boardKeysRequest,
      namespaceRequest,
    ]);
    await readCompleted;
    boardKeys = storedBoardKeys;
    namespaceNames = namespaceEntries.map((entry) => entry.name);
    const writeTransaction = database.transaction(BOARD_STORE, "readwrite");
    for (const key of boardKeys) writeTransaction.objectStore(BOARD_STORE).delete(key);
    await transactionComplete(writeTransaction);
  } finally {
    database.close();
  }

  const deletionResults = await Promise.allSettled(namespaceNames.map(deleteDatabase));
  const deletedNames = namespaceNames.filter(
    (_name, index) => deletionResults[index]?.status === "fulfilled",
  );

  if (deletedNames.length > 0) {
    const cleanupDatabase = await openCatalog();
    try {
      const transaction = cleanupDatabase.transaction(NAMESPACE_STORE, "readwrite");
      for (const name of deletedNames) {
        transaction.objectStore(NAMESPACE_STORE).delete(name);
      }
      await transactionComplete(transaction);
    } finally {
      cleanupDatabase.close();
    }
  }

  const failures = deletionResults
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} local Board database(s) could not be deleted`,
    );
  }
}

export async function clearBoardCatalogForTests(): Promise<void> {
  await deleteDatabase(CATALOG_DATABASE);
}

import {
  deleteIndexedDb,
  openIndexedDb,
} from "../board/indexedDbLifecycle";
import type { CodeWorkspaceBlobIdentity } from "../../code/core";

const BLOB_STORE = "blobs";
const DATABASE_VERSION = 1;

interface StoredCodeBlob {
  blob: Blob;
  byteSize: number;
  mimeType: string;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error("Code blob request failed"),
    );
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(
      transaction.error ?? new Error("Code blob transaction was aborted"),
    );
    transaction.onerror = () => reject(
      transaction.error ?? new Error("Code blob transaction failed"),
    );
  });
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function codeBlobIdentity(blob: Blob): Promise<CodeWorkspaceBlobIdentity> {
  if (blob.size < 1) throw new Error("Пустой файл нельзя добавить");
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return {
    sha256: hex(new Uint8Array(digest)),
    byteSize: blob.size,
    mimeType: blob.type.trim().toLowerCase() || "application/octet-stream",
  };
}

export class CodeBlobStore {
  readonly whenReady: Promise<boolean>;

  private readonly database: Promise<IDBDatabase | null>;
  private readonly memory = new Map<string, StoredCodeBlob>();
  private closed = false;

  constructor(readonly name: string) {
    this.database = openIndexedDb({
      factory: indexedDB,
      name,
      version: DATABASE_VERSION,
      errorMessage: "Unable to open Code blob storage",
      upgrade: (database) => {
        if (!database.objectStoreNames.contains(BLOB_STORE)) {
          database.createObjectStore(BLOB_STORE);
        }
      },
    }).then((database) => database, () => null);
    this.whenReady = this.database.then((database) => database !== null);
  }

  async put(blob: Blob): Promise<CodeWorkspaceBlobIdentity> {
    this.assertOpen();
    const identity = await codeBlobIdentity(blob);
    const stored: StoredCodeBlob = {
      blob,
      byteSize: identity.byteSize,
      mimeType: identity.mimeType,
    };
    const database = await this.database;
    if (!database) {
      this.memory.set(identity.sha256, stored);
      return identity;
    }
    const transaction = database.transaction(BLOB_STORE, "readwrite");
    transaction.objectStore(BLOB_STORE).put(stored, identity.sha256);
    await transactionComplete(transaction);
    return identity;
  }

  async get(identity: CodeWorkspaceBlobIdentity): Promise<Blob | null> {
    this.assertOpen();
    const database = await this.database;
    const stored = database
      ? await this.readDatabase(database, identity.sha256)
      : this.memory.get(identity.sha256);
    if (
      !stored
      || stored.byteSize !== identity.byteSize
      || stored.mimeType !== identity.mimeType
      || stored.blob.size !== identity.byteSize
    ) {
      return null;
    }
    return stored.blob;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const database = await this.database;
    database?.close();
    this.memory.clear();
  }

  async clearData(): Promise<void> {
    await this.close();
    await deleteIndexedDb(
      indexedDB,
      this.name,
      "Unable to delete Code blob storage",
    );
  }

  private async readDatabase(
    database: IDBDatabase,
    sha256: string,
  ): Promise<StoredCodeBlob | undefined> {
    const transaction = database.transaction(BLOB_STORE, "readonly");
    const completed = transactionComplete(transaction);
    const value = await requestResult(
      transaction.objectStore(BLOB_STORE).get(sha256),
    ) as StoredCodeBlob | undefined;
    await completed;
    return value;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Code blob storage is closed");
  }
}

export function codeBlobStoreName(persistenceName: string): string {
  return `${persistenceName}:content-blobs:v1`;
}

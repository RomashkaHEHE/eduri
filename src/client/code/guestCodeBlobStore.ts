import type { CodeWorkspaceBlobIdentity } from "../../code/core/index.js";
export interface GuestCodeLocalBlobCache {
  readonly whenReady: Promise<boolean>;
  put(blob: Blob): Promise<CodeWorkspaceBlobIdentity>;
  get(identity: CodeWorkspaceBlobIdentity): Promise<Blob | null>;
  close(): Promise<void>;
  clearData(): Promise<void>;
}

export interface GuestCodeRemoteBlobStore {
  upload(identity: CodeWorkspaceBlobIdentity, blob: Blob): Promise<void>;
  download(identity: CodeWorkspaceBlobIdentity): Promise<Blob>;
}

function sameIdentity(
  left: CodeWorkspaceBlobIdentity,
  right: CodeWorkspaceBlobIdentity,
): boolean {
  return left.sha256 === right.sha256
    && left.byteSize === right.byteSize
    && left.mimeType === right.mimeType;
}

/**
 * Durable local cache plus capability-scoped remote storage. put() resolves
 * only after finalize, so callers can publish the CRDT reference afterward.
 */
export class GuestCodeBlobStore {
  readonly whenReady: Promise<boolean>;

  constructor(
    private readonly local: GuestCodeLocalBlobCache,
    private readonly remote: GuestCodeRemoteBlobStore,
  ) {
    this.whenReady = local.whenReady;
  }

  async put(blob: Blob): Promise<CodeWorkspaceBlobIdentity> {
    const identity = await this.local.put(blob);
    await this.remote.upload(identity, blob);
    return identity;
  }

  async get(identity: CodeWorkspaceBlobIdentity): Promise<Blob | null> {
    const cached = await this.local.get(identity);
    if (cached) return cached;
    const downloaded = await this.remote.download(identity);
    const stored = await this.local.put(downloaded);
    if (!sameIdentity(stored, identity)) {
      throw new Error("Downloaded Code blob cache identity does not match");
    }
    return downloaded;
  }

  async close(): Promise<void> {
    await this.local.close();
  }

  async clearData(): Promise<void> {
    await this.local.clearData();
  }
}

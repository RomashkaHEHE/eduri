// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { CodeWorkspaceBlobIdentity } from "../../code/core/index.js";
import { codeBlobIdentity } from "./codeBlobStore.js";
import {
  GuestCodeBlobStore,
  type GuestCodeLocalBlobCache,
  type GuestCodeRemoteBlobStore,
} from "./guestCodeBlobStore.js";

function cache(events: string[]): GuestCodeLocalBlobCache & {
  readonly values: Map<string, Blob>;
} {
  const values = new Map<string, Blob>();
  return {
    values,
    whenReady: Promise.resolve(true),
    async put(blob) {
      events.push("local-put");
      const identity = await codeBlobIdentity(blob);
      values.set(identity.sha256, blob);
      return identity;
    },
    async get(identity) {
      events.push("local-get");
      return values.get(identity.sha256) ?? null;
    },
    close: vi.fn(async () => undefined),
    clearData: vi.fn(async () => values.clear()),
  };
}

describe("GuestCodeBlobStore", () => {
  it("durably caches before upload and returns an identity only after publish", async () => {
    const events: string[] = [];
    const local = cache(events);
    const remote: GuestCodeRemoteBlobStore = {
      async upload() {
        events.push("remote-upload");
      },
      async download() {
        throw new Error("not used");
      },
    };
    const store = new GuestCodeBlobStore(local, remote);
    const blob = new Blob([Uint8Array.of(1, 2, 3)], {
      type: "application/octet-stream",
    });

    const identity = await store.put(blob);
    expect(events).toEqual(["local-put", "remote-upload"]);
    expect(local.values.has(identity.sha256)).toBe(true);
  });

  it("verifies through the HTTP client contract, caches a remote miss, and reuses it", async () => {
    const events: string[] = [];
    const local = cache(events);
    const blob = new Blob(["remote"], { type: "text/plain" });
    const identity: CodeWorkspaceBlobIdentity = await codeBlobIdentity(blob);
    const download = vi.fn(async () => {
      events.push("remote-download");
      return blob;
    });
    const store = new GuestCodeBlobStore(local, {
      upload: vi.fn(async () => undefined),
      download,
    });

    expect(await store.get(identity)).toBe(blob);
    expect(await store.get(identity)).toBe(blob);
    expect(download).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "local-get",
      "remote-download",
      "local-put",
      "local-get",
    ]);
  });
});

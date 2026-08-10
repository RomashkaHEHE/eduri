import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodeBlobStore,
  codeBlobIdentity,
} from "./codeBlobStore";

const stores: CodeBlobStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe("CodeBlobStore", () => {
  it("stores binary bytes by content hash and restores them", async () => {
    const name = `code-blobs-${crypto.randomUUID()}`;
    const first = new CodeBlobStore(name);
    stores.push(first);
    const source = new Blob([new Uint8Array([0, 255, 1, 2])], {
      type: "application/octet-stream",
    });
    const identity = await first.put(source);
    expect(identity).toEqual(await codeBlobIdentity(source));
    await first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = new CodeBlobStore(name);
    stores.push(reopened);
    const restored = await reopened.get(identity);
    expect([...new Uint8Array(await restored!.arrayBuffer())])
      .toEqual([0, 255, 1, 2]);
  });
});

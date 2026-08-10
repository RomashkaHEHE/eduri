import { describe, expect, it } from "vitest";

import { serverListenHost } from "./index.js";

describe("server network binding", () => {
  it("keeps known development credentials off the LAN by default", () => {
    expect(serverListenHost("development")).toBe("127.0.0.1");
    expect(serverListenHost("test")).toBe("127.0.0.1");
    expect(serverListenHost("production")).toBe("0.0.0.0");
  });
});

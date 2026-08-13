import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  PYTHON_RUNNER_PROTOCOL_VERSION,
  PYTHON_RUNNER_SOURCE_REVISION,
  PYTHON_RUNNER_WORKER_URL,
  PYTHON_TERMINAL_PROTOCOL_VERSION,
  PYTHON_TERMINAL_SOURCE_REVISION,
  PYTHON_TERMINAL_WORKER_URL,
} from "../pythonRunnerContract.js";

interface FetchRequest {
  method: string;
  url: string;
  mode: string;
  destination: string;
}

interface FetchEvent {
  request: FetchRequest;
  respondWith(response: Promise<Response>): void;
}

interface ExtendableEvent {
  waitUntil(operation: Promise<unknown>): void;
}

type WorkerListener = (event: FetchEvent | ExtendableEvent) => void;

function serviceWorkerHarness() {
  const listeners = new Map<string, WorkerListener>();
  const cachedShell = new Response("<!doctype html><main>cached eduri</main>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  const cache = {
    match: vi.fn().mockImplementation((request: FetchRequest | string) => {
      const path = typeof request === "string"
        ? request
        : new URL(request.url).pathname;
      return Promise.resolve(path === "/index.html" ? cachedShell : new Response("asset"));
    }),
    put: vi.fn().mockResolvedValue(undefined),
  };
  const cacheStorage = {
    open: vi.fn().mockResolvedValue(cache),
    keys: vi.fn().mockResolvedValue([
      "eduri-shell-v2-2",
      "eduri-shell-v3-current",
      "another-application",
    ]),
    delete: vi.fn().mockResolvedValue(true),
  };
  const fetch = vi.fn().mockImplementation((request: Request) => {
    const path = new URL(request.url).pathname;
    const contentType = path.endsWith(".html")
      ? "text/html; charset=utf-8"
      : "text/javascript; charset=utf-8";
    const response = new Response(path, {
      status: 200,
      headers: { "content-type": contentType },
    });
    Object.defineProperty(response, "type", { value: "basic" });
    return Promise.resolve(response);
  });
  const manifest = {
    version: "v3-current",
    urls: [
      "/index.html",
      "/assets/index-current.js",
      PYTHON_RUNNER_WORKER_URL,
      PYTHON_TERMINAL_WORKER_URL,
    ],
  };
  const worker = {
    __EDURI_PRECACHE_MANIFEST__: undefined as typeof manifest | undefined,
    location: { origin: "https://eduri.test" },
    clients: { claim: vi.fn().mockResolvedValue(undefined) },
    skipWaiting: vi.fn().mockResolvedValue(undefined),
    addEventListener(type: string, listener: WorkerListener) {
      listeners.set(type, listener);
    },
  };

  const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    URL,
    Request,
    Response,
    Promise,
    caches: cacheStorage,
    fetch,
    importScripts: vi.fn(() => {
      worker.__EDURI_PRECACHE_MANIFEST__ = manifest;
    }),
    self: worker,
  });

  const fetchListener = listeners.get("fetch");
  if (!fetchListener) throw new Error("service worker did not register a fetch listener");
  const installListener = listeners.get("install");
  const activateListener = listeners.get("activate");
  if (!installListener || !activateListener) {
    throw new Error("service worker did not register lifecycle listeners");
  }
  return {
    activateListener,
    cache,
    cacheStorage,
    fetch,
    fetchListener,
    installListener,
    manifest,
    worker,
  };
}

function lifecyclePromise(
  listener: WorkerListener,
): Promise<unknown> {
  let operation: Promise<unknown> | undefined;
  listener({
    request: {
      method: "GET",
      url: "https://eduri.test/",
      mode: "navigate",
      destination: "document",
    },
    respondWith() {
      throw new Error("unexpected respondWith");
    },
    waitUntil(value) {
      operation = value;
    },
  });
  if (!operation) throw new Error("listener did not call waitUntil");
  return operation;
}

describe("Board v2 offline app shell", () => {
  it("pre-caches the versioned Python worker without a standalone theme bootstrap", () => {
    const harness = serviceWorkerHarness();
    expect(PYTHON_RUNNER_WORKER_URL).toBe(
      `/python-runner.worker.js?protocol=${PYTHON_RUNNER_PROTOCOL_VERSION}`
        + `&revision=${PYTHON_RUNNER_SOURCE_REVISION}`,
    );
    expect(harness.manifest.urls).toContain(PYTHON_RUNNER_WORKER_URL);
    expect(PYTHON_TERMINAL_WORKER_URL).toBe(
      `/python-terminal.worker.js?protocol=${PYTHON_TERMINAL_PROTOCOL_VERSION}`
        + `&revision=${PYTHON_TERMINAL_SOURCE_REVISION}`,
    );
    expect(harness.manifest.urls).toContain(PYTHON_TERMINAL_WORKER_URL);
    expect(harness.manifest.urls).not.toContain("/python-runner.worker.js");
    expect(harness.manifest.urls).not.toContain("/python-terminal.worker.js");
    expect(harness.manifest.urls).not.toContain("/theme-init.js");
  });

  it("pre-caches the complete generated build without taking over old tabs", async () => {
    const harness = serviceWorkerHarness();

    await lifecyclePromise(harness.installListener);

    expect(harness.cacheStorage.open).toHaveBeenCalledWith("eduri-shell-v3-current");
    expect(harness.fetch).toHaveBeenCalledTimes(harness.manifest.urls.length);
    expect(harness.cache.put).toHaveBeenCalledTimes(harness.manifest.urls.length);
    expect(harness.cache.match).toHaveBeenCalledTimes(harness.manifest.urls.length);
    expect(harness.worker.skipWaiting).not.toHaveBeenCalled();
  });

  it("rejects an HTML fallback returned for a missing JavaScript asset", async () => {
    const harness = serviceWorkerHarness();
    harness.fetch.mockImplementation((request: Request) => {
      const response = new Response("<!doctype html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
      Object.defineProperty(response, "type", { value: "basic" });
      return Promise.resolve(response);
    });

    await expect(lifecyclePromise(harness.installListener)).rejects.toThrow(
      "offline resource is invalid",
    );

    expect(harness.cacheStorage.delete).not.toHaveBeenCalled();
    expect(harness.worker.skipWaiting).not.toHaveBeenCalled();
  });

  it("does not activate or delete the previous cache after an incomplete install", async () => {
    const harness = serviceWorkerHarness();
    harness.cache.match.mockResolvedValueOnce(undefined);

    await expect(lifecyclePromise(harness.installListener)).rejects.toThrow(
      "offline cache is incomplete",
    );

    expect(harness.worker.skipWaiting).not.toHaveBeenCalled();
    expect(harness.cacheStorage.delete).not.toHaveBeenCalled();
  });

  it("keeps the previous cache when activation finds an incomplete replacement", async () => {
    const harness = serviceWorkerHarness();
    harness.cache.match.mockResolvedValueOnce(undefined);

    await expect(lifecyclePromise(harness.activateListener)).rejects.toThrow(
      "offline cache is incomplete",
    );

    expect(harness.cacheStorage.delete).not.toHaveBeenCalled();
    expect(harness.worker.clients.claim).not.toHaveBeenCalled();
  });

  it("deletes only superseded Eduri caches after verifying the replacement", async () => {
    const harness = serviceWorkerHarness();

    await lifecyclePromise(harness.activateListener);

    expect(harness.cacheStorage.delete).toHaveBeenCalledTimes(1);
    expect(harness.cacheStorage.delete).toHaveBeenCalledWith("eduri-shell-v2-2");
    expect(harness.cacheStorage.delete).not.toHaveBeenCalledWith("another-application");
    expect(harness.worker.clients.claim).toHaveBeenCalledOnce();
  });

  it.each(["/api", "/api/auth/me", "/api/board-v2/boards/board-a/assets/asset-a"])(
    "never intercepts or caches private API request %s",
    (path) => {
      const harness = serviceWorkerHarness();
      const respondWith = vi.fn();

      harness.fetchListener({
        request: {
          method: "GET",
          url: `https://eduri.test${path}`,
          mode: "cors",
          destination: "image",
        },
        respondWith,
      });

      expect(respondWith).not.toHaveBeenCalled();
      expect(harness.cache.match).not.toHaveBeenCalled();
      expect(harness.cache.put).not.toHaveBeenCalled();
      expect(harness.fetch).not.toHaveBeenCalled();
    },
  );

  it("serves the cached application shell when an opened route is reloaded offline", async () => {
    const harness = serviceWorkerHarness();
    harness.fetch.mockRejectedValue(new TypeError("network unavailable"));
    let responsePromise: Promise<Response> | undefined;

    harness.fetchListener({
      request: {
        method: "GET",
        url: "https://eduri.test/lessons/lesson-a",
        mode: "navigate",
        destination: "document",
      },
      respondWith(response) {
        responsePromise = response;
      },
    });

    expect(responsePromise).toBeDefined();
    const response = await responsePromise;
    expect(await response?.text()).toContain("cached eduri");
    expect(harness.cache.match).toHaveBeenCalledWith("/index.html");
    expect(harness.cache.put).not.toHaveBeenCalled();
  });

  it("does not poison the runtime cache with an HTML fallback for JavaScript", async () => {
    const harness = serviceWorkerHarness();
    harness.cache.match.mockResolvedValueOnce(undefined);
    harness.fetch.mockImplementation(() => {
      const response = new Response("<!doctype html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
      Object.defineProperty(response, "type", { value: "basic" });
      return Promise.resolve(response);
    });
    let responsePromise: Promise<Response> | undefined;

    harness.fetchListener({
      request: {
        method: "GET",
        url: "https://eduri.test/assets/missing-build-chunk.js",
        mode: "cors",
        destination: "script",
      },
      respondWith(response) {
        responsePromise = response;
      },
    });

    expect(await (await responsePromise)?.text()).toContain("<!doctype html>");
    expect(harness.cache.put).not.toHaveBeenCalled();
  });

  it("never writes a network navigation response into the active cache", async () => {
    const harness = serviceWorkerHarness();
    harness.fetch.mockResolvedValue(new Response("<!doctype html><main>new build</main>"));
    let responsePromise: Promise<Response> | undefined;

    harness.fetchListener({
      request: {
        method: "GET",
        url: "https://eduri.test/lessons/lesson-a",
        mode: "navigate",
        destination: "document",
      },
      respondWith(response) {
        responsePromise = response;
      },
    });

    expect(await (await responsePromise)?.text()).toContain("new build");
    expect(harness.cache.put).not.toHaveBeenCalled();
  });
});

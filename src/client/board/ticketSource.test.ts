import { describe, expect, it, vi } from "vitest";
import {
  BoardTicketRequestError,
  BOARD_BROWSER_CAPABILITIES,
  createBootstrappedBoardTicketSource,
  createHttpBoardTicketSource,
  requestHttpBoardBootstrap,
  type FetchLike,
} from "./ticketSource.js";

const scope = {
  boardId: "board-1",
  generation: 7,
  documentKey: "page:default",
};

describe("Board HTTP ticket source", () => {
  it("uses a CSRF-protected POST and keeps the ticket out of the WebSocket URL", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        boardId: scope.boardId,
        generation: scope.generation,
        documentKey: scope.documentKey,
        ticket: "single-use-ticket",
        expiresAt: "2030-01-01T00:00:00.000Z",
        wsPath: "/api/board-v2/socket",
      }),
    });
    const source = createHttpBoardTicketSource({
      endpoint: "/api/board-v2/ticket",
      scope,
      csrfToken: () => "csrf-value",
      fetch,
      baseUrl: "https://eduri.test/lesson/1",
    });

    await expect(source()).resolves.toEqual({
      ticket: "single-use-ticket",
      socketUrl: "wss://eduri.test/api/board-v2/socket",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(fetch).toHaveBeenCalledWith("/api/board-v2/ticket", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": "csrf-value",
      },
      body: JSON.stringify(scope),
    });
    expect((await source()).socketUrl).not.toContain("single-use-ticket");
  });

  it("bootstraps the actual lesson-scoped server contract", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ticket: "initial-ticket",
        expiresAt: "2030-01-01T00:00:00.000Z",
        boardId: "board-1",
        generation: 1,
        protocolVersion: 1,
        schemaVersion: 1,
        capabilities: 19,
        permissions: 3,
        manifestDocKey: "manifest",
        defaultPageId: "10000000-0000-4000-8000-000000000001",
        defaultPageDocKey: "page:10000000-0000-4000-8000-000000000001",
        websocketPath: "/api/board-v2/sync",
      }),
    });

    await expect(requestHttpBoardBootstrap({
      endpoint: "/api/board-v2/sync-ticket",
      lessonId: "20000000-0000-4000-8000-000000000001",
      csrfToken: () => "csrf",
      fetch,
      baseUrl: "https://eduri.test/lesson/1",
    })).resolves.toMatchObject({
      boardId: "board-1",
      defaultPageDocumentKey: "page:10000000-0000-4000-8000-000000000001",
      socketUrl: "wss://eduri.test/api/board-v2/sync",
      capabilities: 19,
    });
    expect(fetch).toHaveBeenCalledWith("/api/board-v2/sync-ticket", expect.objectContaining({
      body: JSON.stringify({
        lessonId: "20000000-0000-4000-8000-000000000001",
        minSchemaVersion: 1,
        maxSchemaVersion: 1,
        capabilities: BOARD_BROWSER_CAPABILITIES,
      }),
    }));
  });

  it("resolves a dynamic request body for every fresh ticket", async () => {
    let profile = { displayName: "Alice", color: "#2563eb" };
    const fetch = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        boardId: scope.boardId,
        generation: scope.generation,
        documentKey: scope.documentKey,
        ticket: "ticket",
        wsPath: "/api/board-v2/socket",
      }),
    });
    const source = createHttpBoardTicketSource({
      endpoint: "/api/board-v2/ticket",
      scope,
      requestBody: () => ({ ...scope, profile }),
      csrfToken: () => "csrf",
      fetch,
      baseUrl: "https://eduri.test/lesson/1",
    });

    await source();
    profile = { displayName: "Bob", color: "#dc2626" };
    await source();

    expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
      { ...scope, profile: { displayName: "Alice", color: "#2563eb" } },
      { ...scope, profile: { displayName: "Bob", color: "#dc2626" } },
    ]);
  });

  it("skips a bootstrap ticket invalidated before local hydration completes", async () => {
    let profile = { displayName: "Alice", color: "#2563eb" };
    let profileKey = "Alice\u0000#2563eb";
    const bootstrapProfileKey = profileKey;
    const isInitialTicketValid = vi.fn(() => profileKey === bootstrapProfileKey);
    const fetch = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ticket: "fresh-ticket",
        boardId: scope.boardId,
        generation: scope.generation,
        protocolVersion: 1,
        schemaVersion: 1,
        capabilities: BOARD_BROWSER_CAPABILITIES,
        permissions: 3,
        manifestDocKey: "manifest",
        defaultPageId: "10000000-0000-4000-8000-000000000001",
        defaultPageDocKey: scope.documentKey,
        websocketPath: "/api/board-v2/sync",
      }),
    });
    const source = createBootstrappedBoardTicketSource({
      endpoint: "/api/board-v2/sync-ticket",
      requestBody: () => ({ profile }),
      csrfToken: () => "csrf",
      fetch,
      baseUrl: "https://eduri.test/lesson/1",
    }, scope, {
      ticket: "stale-bootstrap-ticket",
      socketUrl: "wss://eduri.test/api/board-v2/sync",
      boardId: scope.boardId,
      generation: scope.generation,
      protocolVersion: 1,
      schemaVersion: 1,
      capabilities: BOARD_BROWSER_CAPABILITIES,
      permissions: 3,
      manifestDocumentKey: "manifest",
      defaultPageId: "10000000-0000-4000-8000-000000000001",
      defaultPageDocumentKey: scope.documentKey,
    }, isInitialTicketValid);

    profile = { displayName: "Bob", color: "#dc2626" };
    profileKey = "Bob\u0000#dc2626";

    await expect(source()).resolves.toMatchObject({ ticket: "fresh-ticket" });
    expect(isInitialTicketValid).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
      profile: { displayName: "Bob", color: "#dc2626" },
    });
  });

  it("classifies access denial as terminal and rejects ticket query parameters", async () => {
    const denied = createHttpBoardTicketSource({
      endpoint: "/ticket",
      scope,
      csrfToken: () => "csrf",
      fetch: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    });
    await expect(denied()).rejects.toMatchObject({
      status: 403,
      terminal: true,
    });

    const unsafe = createHttpBoardTicketSource({
      endpoint: "/ticket",
      scope,
      csrfToken: () => "csrf",
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ticket: "secret",
          websocketUrl: "wss://eduri.test/socket?access_token=secret",
        }),
      }),
    });
    await expect(unsafe()).rejects.toBeInstanceOf(BoardTicketRequestError);
    await expect(unsafe()).rejects.toMatchObject({ terminal: true });
  });

  it("preserves and parses a structured compatibility error response", async () => {
    const responseBody = {
      code: "SCHEMA_MISMATCH",
      error: "Board schema is outside the requested range",
      details: {
        requested: { min: 1, max: 1 },
        actual: 2,
      },
    };
    const source = createHttpBoardTicketSource({
      endpoint: "/ticket",
      scope,
      csrfToken: () => "csrf",
      fetch: async () => ({
        ok: false,
        status: 422,
        json: async () => responseBody,
      }),
    });

    await expect(source()).rejects.toMatchObject({
      message: responseBody.error,
      status: 422,
      terminal: true,
      retryable: false,
      code: "SCHEMA_MISMATCH",
      details: responseBody.details,
      responseBody,
    });
  });

  it("keeps temporary server failures retryable while retaining their code", async () => {
    const responseBody = {
      code: "BOARD_V2_DISABLED",
      error: "Board v2 is temporarily disabled",
    };
    const source = createHttpBoardTicketSource({
      endpoint: "/ticket",
      scope,
      csrfToken: () => "csrf",
      fetch: async () => ({
        ok: false,
        status: 503,
        json: async () => responseBody,
      }),
    });

    await expect(source()).rejects.toMatchObject({
      status: 503,
      terminal: false,
      retryable: true,
      code: "BOARD_V2_DISABLED",
      responseBody,
    });
  });
});

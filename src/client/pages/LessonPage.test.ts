// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LessonSummary } from "../../shared/types";
import {
  ONLINE_PROFILE_STORAGE_KEY,
  resetOnlineProfileMemoryForTests,
} from "../onlineProfile";
import { ThemeProvider } from "../theme";

const LESSON_ID = "00000000-0000-4000-8000-000000000501";
const USER_ID = "00000000-0000-4000-8000-000000000502";
const cachedLesson: LessonSummary = {
  id: LESSON_ID,
  title: "Cached Board v2",
  studentId: "00000000-0000-4000-8000-000000000503",
  studentName: "Offline student",
  scheduledAt: "2026-07-28T08:00:00.000Z",
  durationMinutes: 60,
  status: "active",
  startedAt: "2026-07-28T08:00:00.000Z",
};

const networkLesson = vi.fn();
const networkMaterials = vi.fn();
const readCatalog = vi.fn();
const navigate = vi.fn();
const socket = {
  on: vi.fn(),
  emit: vi.fn(),
  disconnect: vi.fn(),
};
interface CodeWorkspaceProps {
  lessonId: string;
  userId: string;
  profile: { displayName: string; color: string };
  readOnly: boolean;
}
let codeWorkspaceProps: CodeWorkspaceProps | undefined;

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigate,
  useParams: () => ({ lessonId: LESSON_ID }),
}));

vi.mock("../auth", () => ({
  homeForRole: () => "/tutor",
  useAuth: () => ({
    user: {
      id: USER_ID,
      role: "tutor",
      displayName: "Offline tutor",
      status: "active",
    },
  }),
}));

vi.mock("../api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api")>();
  return {
    ...original,
    api: {
      assignments: {},
      lessons: {
        get: (...args: unknown[]) => networkLesson(...args),
      },
      materials: {
        list: (...args: unknown[]) => networkMaterials(...args),
      },
    },
  };
});

vi.mock("../board/catalog", () => ({
  getBoardCatalogEntry: (...args: unknown[]) => readCatalog(...args),
}));

vi.mock("../board/LessonBoard", () => ({
  LessonBoard: ({ lesson }: { lesson: LessonSummary }) =>
    createElement("div", { "data-testid": "board-v2-probe" }, lesson.title),
}));

vi.mock("../components/LessonCall", () => ({
  LessonCall: () => createElement("div", null, "call"),
}));

vi.mock("../components/LessonCodeWorkspace", () => ({
  LessonCodeWorkspace: (props: CodeWorkspaceProps) => {
    codeWorkspaceProps = props;
    return createElement(
      "div",
      { "data-testid": "python-workspace" },
      props.lessonId,
    );
  },
}));

vi.mock("socket.io-client", () => ({
  io: () => socket,
}));

import { LessonPage } from "./LessonPage";

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  networkLesson.mockReset();
  networkMaterials.mockReset();
  readCatalog.mockReset();
  navigate.mockReset();
  socket.on.mockReset();
  socket.emit.mockReset();
  socket.disconnect.mockReset();
  codeWorkspaceProps = undefined;
  resetOnlineProfileMemoryForTests();
  window.localStorage.clear();
  window.localStorage.setItem(ONLINE_PROFILE_STORAGE_KEY, JSON.stringify({
    version: 1,
    displayName: "Offline tutor",
    color: "#2563eb",
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  window.localStorage.clear();
  resetOnlineProfileMemoryForTests();
  vi.restoreAllMocks();
});

describe("LessonPage local-first bootstrap", () => {
  it("suggests the first online profile while mounting collaboration with its default", async () => {
    window.localStorage.clear();
    resetOnlineProfileMemoryForTests();
    networkLesson.mockResolvedValue({
      ...cachedLesson,
      materials: [],
      notes: "",
    });
    networkMaterials.mockResolvedValue([]);
    readCatalog.mockResolvedValue(null);

    await act(async () => {
      root?.render(createElement(
        ThemeProvider,
        null,
        createElement(LessonPage),
      ));
    });
    await act(async () => vi.waitFor(() => {
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    }));

    expect(document.body.textContent).toContain("Display Name");
    expect(container?.querySelector('[data-testid="board-v2-probe"]')).not.toBeNull();
    expect(container?.textContent).toContain("call");

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(
        '[role="dialog"] [aria-label="Закрыть"]',
      )?.click();
    });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(container?.textContent).toContain("call");
  });

  it("does not request a profile when the lesson cannot be opened", async () => {
    window.localStorage.clear();
    resetOnlineProfileMemoryForTests();
    networkLesson.mockRejectedValue(new Error("Lesson missing"));
    readCatalog.mockResolvedValue(null);

    await act(async () => {
      root?.render(createElement(
        ThemeProvider,
        null,
        createElement(LessonPage),
      ));
    });
    await act(async () => vi.waitFor(() => {
      expect(container?.textContent).toContain("Lesson missing");
    }));

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("places Profile immediately before the theme control", async () => {
    networkLesson.mockResolvedValue({
      ...cachedLesson,
      materials: [],
      notes: "",
    });
    networkMaterials.mockResolvedValue([]);
    readCatalog.mockResolvedValue(null);

    await act(async () => {
      root?.render(createElement(
        ThemeProvider,
        null,
        createElement(LessonPage),
      ));
    });
    await act(async () => vi.waitFor(() => {
      expect(container?.querySelector(".lesson-header__profile")).not.toBeNull();
    }));
    const profileButton = container?.querySelector(".lesson-header__profile");
    expect(profileButton?.nextElementSibling?.classList.contains("lesson-header__theme")).toBe(true);
  });

  it("mounts a cached Board v2 lesson while the network request is still pending", async () => {
    networkLesson.mockReturnValue(new Promise(() => undefined));
    readCatalog.mockResolvedValue({
      key: `${USER_ID}:${LESSON_ID}`,
      userId: USER_ID,
      lessonId: LESSON_ID,
      boardId: "00000000-0000-4000-8000-000000000504",
      generation: 1,
      schemaVersion: 1,
      capabilities: 15,
      permissions: 3,
      manifestDocumentKey: "manifest",
      pageId: "00000000-0000-4000-8000-000000000505",
      pageDocumentKey: "page:00000000-0000-4000-8000-000000000505",
      lesson: cachedLesson,
      updatedAt: "2026-07-28T08:00:00.000Z",
    });

    await act(async () => {
      root?.render(createElement(
        ThemeProvider,
        null,
        createElement(LessonPage),
      ));
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(
          container?.querySelector('[data-testid="board-v2-probe"]')?.textContent,
        ).toBe("Cached Board v2");
      });
    });

    expect(networkLesson).toHaveBeenCalledWith(LESSON_ID);
    expect(networkMaterials).not.toHaveBeenCalled();
    expect(readCatalog).toHaveBeenCalledWith(USER_ID, LESSON_ID);
    expect(socket.on.mock.calls.map(([event]) => event)).not.toContain(
      "lesson:scene",
    );
  });

  it("mounts the authenticated collaborative workspace without a legacy code writer", async () => {
    networkLesson.mockResolvedValue({
      ...cachedLesson,
      code: {
        language: "python",
        value: "print('initial')",
      },
      materials: [],
      notes: "",
    });
    networkMaterials.mockResolvedValue([]);
    readCatalog.mockResolvedValue(null);

    await act(async () => {
      root?.render(createElement(
        ThemeProvider,
        null,
        createElement(LessonPage),
      ));
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(container?.querySelector('button[title="Код"]')).not.toBeNull();
      });
      container?.querySelector<HTMLButtonElement>('button[title="Код"]')
        ?.click();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(codeWorkspaceProps).toEqual({
          lessonId: LESSON_ID,
          userId: USER_ID,
          profile: { displayName: "Offline tutor", color: "#2563eb" },
          readOnly: false,
        });
      });
    });

    expect(socket.on.mock.calls.map(([event]) => event)).not.toContain(
      "lesson:code",
    );
    expect(socket.emit.mock.calls.map(([event]) => event)).not.toContain(
      "lesson:code",
    );
  });
});

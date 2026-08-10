// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LessonSummary } from "../../shared/types";
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
  code: string;
  onCodeChange(value: string | undefined): void;
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
      props.code,
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  vi.restoreAllMocks();
});

describe("LessonPage local-first bootstrap", () => {
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

  it("keeps initial, remote, and outgoing workspace state Python-only", async () => {
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
        expect(codeWorkspaceProps?.code).toBe("print('initial')");
      });
    });

    const receiveCode = socket.on.mock.calls.find(
      ([event]) => event === "lesson:code",
    )?.[1] as ((payload: unknown) => void) | undefined;
    expect(receiveCode).toBeDefined();
    await act(async () => {
      receiveCode?.({
        lessonId: LESSON_ID,
        code: {
          language: "javascript",
          value: "console.log('legacy source')",
        },
      });
    });
    expect(codeWorkspaceProps?.code).toBe("console.log('legacy source')");

    await act(async () => {
      codeWorkspaceProps?.onCodeChange("print('canonical')");
    });
    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith("lesson:code", {
        lessonId: LESSON_ID,
        code: {
          language: "python",
          value: "print('canonical')",
        },
      });
    });
  });
});

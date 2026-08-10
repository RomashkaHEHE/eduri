import { afterEach, describe, expect, it, vi } from "vitest";
import { api, normalizeLessonCode } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeLessonCode", () => {
  it("normalizes legacy JavaScript payloads without dropping their source", () => {
    expect(normalizeLessonCode({
      language: "javascript",
      code: "console.log('legacy');",
    })).toEqual({
      language: "python",
      value: "console.log('legacy');",
    });
  });

  it("accepts canonical, language-less, and string payloads", () => {
    expect(normalizeLessonCode({
      language: "python",
      value: "print('current')",
    })).toEqual({
      language: "python",
      value: "print('current')",
    });
    expect(normalizeLessonCode({ code: "print('old shape')" })).toEqual({
      language: "python",
      value: "print('old shape')",
    });
    expect(normalizeLessonCode("print('string shape')")).toEqual({
      language: "python",
      value: "print('string shape')",
    });
  });

  it("ignores payloads without source text", () => {
    expect(normalizeLessonCode(undefined)).toBeUndefined();
    expect(normalizeLessonCode({ language: "javascript" })).toBeUndefined();
    expect(normalizeLessonCode({ value: 42 })).toBeUndefined();
  });

  it("normalizes a legacy lesson response at the API boundary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      lesson: {
        id: "lesson-a",
        title: "Legacy code state",
        codeState: {
          language: "javascript",
          value: "console.log('preserved')",
        },
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    await expect(api.lessons.get("lesson-a")).resolves.toMatchObject({
      code: {
        language: "python",
        value: "console.log('preserved')",
      },
    });
  });
});

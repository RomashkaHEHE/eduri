import type {
  AssignmentSummary,
  CurrentUser,
  LessonSummary,
  MaterialSummary,
  StudentSummary,
  TutorSummary,
} from "../shared/types";
import type { CollaborationProfile } from "../shared/collaborationProfile";
import type { CallLobbyParticipant } from "../shared/call";

export class ApiError extends Error {
  status: number;
  details?: Record<string, string[]>;

  constructor(message: string, status: number, details?: Record<string, string[]>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

export interface AuthResponse {
  user: CurrentUser;
  csrfToken: string;
}

export interface InvitePreview {
  displayName: string;
  loginName?: string;
  role?: "tutor" | "student";
  tutorName: string | null;
  purpose?: string;
  expiresAt?: string;
}

export interface StudentDetail extends StudentSummary {
  tutorName?: string;
  createdAt?: string;
}

export interface LessonDetail extends LessonSummary {
  notes?: string;
  materials?: MaterialDetail[];
  scene?: unknown[];
  code?: LessonCode;
}

export interface LessonCode {
  language: "python";
  value: string;
}

export interface MaterialDetail extends MaterialSummary {
  progressStatus?: "assigned" | "covered" | "completed";
  progressLessonId?: string;
  studentIds?: string[];
}

export interface MaterialProgressUpdate {
  materialId: string;
  studentId: string;
  progressStatus: NonNullable<MaterialDetail["progressStatus"]>;
  lessonId?: string | null;
  updatedAt: string;
}

export interface CallCredentials {
  url: string;
  token: string;
  roomName: string;
  expiresAt?: string;
}

export type GuestResourceKind = "board" | "code" | "call";

export interface GuestRoomResource {
  id: string;
  kind: GuestResourceKind;
  ordinal: number;
  url: string;
  createdAt: string;
  lastActivityAt: string;
}

export interface GuestRoom {
  shareId: string;
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string;
  roomUrl: string;
  resources: GuestRoomResource[];
}

export interface GuestRoomDraft {
  room: GuestRoom;
  initializationToken: string;
}

export interface CreateStudentResult {
  student: StudentSummary;
  inviteUrl?: string;
  inviteToken?: string;
}

export interface CreateTutorResult {
  tutor: TutorSummary;
  inviteUrl?: string;
  temporaryPassword?: string;
}

interface BackendInvite<T extends object> {
  invite: T & { token?: string; url?: string };
}

type QueryValue = string | number | boolean | null | undefined;

let csrfToken: string | null = null;

export function currentCsrfToken(): string {
  return csrfToken ?? "";
}

function rememberCsrf(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    "csrfToken" in value &&
    typeof value.csrfToken === "string"
  ) {
    csrfToken = value.csrfToken;
  }
}

function queryString(values?: Record<string, QueryValue>) {
  if (!values) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

async function readResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const message =
      typeof body === "object" && body && "error" in body
        ? String(body.error)
        : "Не удалось выполнить запрос";
    const details =
      typeof body === "object" && body && "details" in body
        ? (body.details as Record<string, string[]>)
        : undefined;
    throw new ApiError(message, response.status, details);
  }

  rememberCsrf(body);
  return body as T;
}

interface RequestOptions extends RequestInit {
  skipCsrf?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { skipCsrf = false, headers, body, ...init } = options;
  const requestHeaders = new Headers(headers);
  if (body && !(body instanceof FormData) && !requestHeaders.has("content-type")) {
    requestHeaders.set("content-type", "application/json");
  }
  const method = (init.method ?? "GET").toUpperCase();
  if (!skipCsrf && !["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) {
    requestHeaders.set("x-csrf-token", csrfToken);
  }
  const response = await fetch(path, {
    ...init,
    body,
    headers: requestHeaders,
    credentials: "include",
  });
  return readResponse<T>(response);
}

function jsonBody(value: unknown) {
  return JSON.stringify(value);
}

function listFrom<T>(payload: T[] | Record<string, unknown>): T[] {
  if (Array.isArray(payload)) return payload;
  for (const key of ["items", "students", "lessons", "materials", "assignments", "tutors"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

function entityFrom<T>(payload: T | Record<string, unknown>, key: string): T {
  const record = payload as Record<string, unknown>;
  if (payload && typeof payload === "object" && key in record) return record[key] as T;
  return payload as T;
}

export function normalizeLessonCode(payload: unknown): LessonCode | undefined {
  if (typeof payload === "string") {
    return { language: "python", value: payload };
  }
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const value = typeof record.value === "string"
    ? record.value
    : typeof record.code === "string"
      ? record.code
      : undefined;
  if (value === undefined) return undefined;
  return { language: "python", value };
}

function normalizeLesson(payload: LessonDetail | Record<string, unknown>): LessonDetail {
  const lesson = entityFrom<LessonDetail & {
    boardState?: { elements?: unknown[] } | unknown[];
    codeState?: unknown;
  }>(payload, "lesson");
  const boardState = lesson.boardState;
  const elements = Array.isArray(boardState) ? boardState : boardState?.elements;
  return {
    ...lesson,
    scene: elements,
    code: normalizeLessonCode(lesson.codeState)
      ?? normalizeLessonCode(lesson.code),
  };
}

export const api = {
  guestRooms: {
    create(initialResource: GuestResourceKind) {
      return request<{ room: GuestRoom }>("/api/guest/rooms", {
        method: "POST",
        body: jsonBody({ initialResource }),
        skipCsrf: true,
      }).then((result) => result.room);
    },
    createDraft(initialResource: GuestResourceKind) {
      return request<GuestRoomDraft>("/api/guest/rooms", {
        method: "POST",
        body: jsonBody({ initialResource, draft: true }),
        skipCsrf: true,
      });
    },
    finalizeDraft(shareId: string, initializationToken: string) {
      return request<{ room: GuestRoom }>(
        `/api/guest/rooms/${encodeURIComponent(shareId)}/initialization/finalize`,
        {
          method: "POST",
          body: jsonBody({ initializationToken }),
          skipCsrf: true,
        },
      ).then((result) => result.room);
    },
    cancelDraft(shareId: string, initializationToken: string) {
      return request<{ cancelled: true }>(
        `/api/guest/rooms/${encodeURIComponent(shareId)}/initialization`,
        {
          method: "DELETE",
          body: jsonBody({ initializationToken }),
          skipCsrf: true,
        },
      ).then(() => undefined);
    },
    get(shareId: string) {
      return request<{ room: GuestRoom }>(
        `/api/guest/rooms/${encodeURIComponent(shareId)}`,
        { skipCsrf: true },
      ).then((result) => result.room);
    },
    ensureResource(shareId: string, kind: GuestResourceKind) {
      return request<{ room: GuestRoom; created: boolean }>(
        `/api/guest/rooms/${encodeURIComponent(shareId)}/resources/${kind}`,
        { method: "PUT", skipCsrf: true },
      );
    },
    callToken(
      shareId: string,
      options: {
        readonly deviceId?: string;
        readonly profile?: CollaborationProfile;
      } = {},
    ) {
      return request<CallCredentials>(
        `/api/guest/rooms/${encodeURIComponent(shareId)}/call-token`,
        {
          method: "POST",
          body: jsonBody(options),
          skipCsrf: true,
        },
      );
    },
    callParticipants(shareId: string) {
      return request<{ participants: CallLobbyParticipant[] }>(
        `/api/guest/rooms/${encodeURIComponent(shareId)}/call-participants`,
        { skipCsrf: true },
      ).then((result) => result.participants);
    },
    updateCallProfile(
      shareId: string,
      deviceId: string,
      profile: CollaborationProfile,
    ) {
      return request<void>(
        `/api/guest/rooms/${encodeURIComponent(shareId)}/call-profile`,
        {
          method: "PATCH",
          body: jsonBody({ deviceId, profile }),
          skipCsrf: true,
        },
      );
    },
  },
  auth: {
    async me() {
      const result = await request<AuthResponse>("/api/auth/me");
      return result.user;
    },
    async loginStudent(loginName: string, codeword: string) {
      return request<AuthResponse>("/api/auth/login/student", {
        method: "POST",
        body: jsonBody({ loginName, codeWord: codeword }),
        skipCsrf: true,
      });
    },
    async loginStaff(loginName: string, password: string) {
      return request<AuthResponse>("/api/auth/login/staff", {
        method: "POST",
        body: jsonBody({ loginName, password }),
        skipCsrf: true,
      });
    },
    async previewInvite(token: string) {
      const result = await request<InvitePreview | BackendInvite<InvitePreview>>("/api/auth/activate/preview", {
        method: "POST",
        body: jsonBody({ token }),
        skipCsrf: true,
      });
      return "invite" in result ? result.invite : result;
    },
    async activate(token: string, secret: string, staff = false) {
      return request<AuthResponse>("/api/auth/activate", {
        method: "POST",
        body: jsonBody(staff ? { token, password: secret } : { token, codeWord: secret }),
        skipCsrf: true,
      });
    },
    async logout() {
      await request<void>("/api/auth/logout", { method: "POST" });
      csrfToken = null;
    },
  },
  students: {
    async list() {
      return listFrom(
        await request<StudentSummary[] | Record<string, unknown>>("/api/students"),
      );
    },
    get(id: string) {
      return request<StudentDetail | { student: StudentDetail }>(`/api/students/${encodeURIComponent(id)}`)
        .then((result) => entityFrom<StudentDetail>(result, "student"));
    },
    create(payload: { displayName: string; loginName?: string; note?: string }) {
      return request<CreateStudentResult | ({ student: StudentSummary } & BackendInvite<object>)>("/api/students", {
        method: "POST",
        body: jsonBody(payload),
      }).then((result) => "invite" in result ? {
        student: result.student,
        inviteUrl: result.invite.url,
        inviteToken: result.invite.token,
      } : result);
    },
    update(id: string, payload: Partial<Pick<StudentSummary, "displayName" | "note" | "status">>) {
      return request<StudentSummary | { student: StudentSummary }>(`/api/students/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: jsonBody(payload),
      }).then((result) => entityFrom<StudentSummary>(result, "student"));
    },
    invite(id: string) {
      return request<{ invite?: { url?: string; token?: string }; inviteUrl?: string; inviteToken?: string }>(
        `/api/students/${encodeURIComponent(id)}/invite`,
        { method: "POST" },
      ).then((result) => result.invite ? { inviteUrl: result.invite.url, inviteToken: result.invite.token } : result);
    },
  },
  lessons: {
    async list(filters?: { studentId?: string; scope?: "today" | "upcoming" | "all" }) {
      const range: Record<string, QueryValue> = { studentId: filters?.studentId };
      if (filters?.scope === "today") {
        const start = new Date(); start.setHours(0, 0, 0, 0);
        const end = new Date(start); end.setDate(end.getDate() + 1);
        range.from = start.toISOString(); range.to = end.toISOString();
      } else if (filters?.scope === "upcoming") {
        range.from = new Date().toISOString();
      }
      const payload = await request<LessonSummary[] | Record<string, unknown>>(
        `/api/lessons${queryString(range)}`,
      );
      return listFrom(payload);
    },
    get(id: string) {
      return request<LessonDetail | Record<string, unknown>>(`/api/lessons/${encodeURIComponent(id)}`)
        .then(normalizeLesson);
    },
    create(payload: {
      title: string;
      studentId: string;
      scheduledAt: string;
      durationMinutes: number;
    }) {
      return request<LessonSummary | { lesson: LessonSummary }>("/api/lessons", {
        method: "POST",
        body: jsonBody(payload),
      }).then((result) => entityFrom<LessonSummary>(result, "lesson"));
    },
    update(id: string, payload: Partial<LessonSummary>) {
      return request<LessonSummary | { lesson: LessonSummary }>(`/api/lessons/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: jsonBody(payload),
      }).then((result) => entityFrom<LessonSummary>(result, "lesson"));
    },
    saveNotes(id: string, notes: string) {
      return request<{ lesson: LessonDetail }>(`/api/lessons/${encodeURIComponent(id)}/notes`, {
        method: "PATCH",
        body: jsonBody({ notes }),
      }).then((result) => result.lesson);
    },
    start(id: string) {
      return request<{ lesson: LessonSummary }>(`/api/lessons/${encodeURIComponent(id)}/start`, { method: "POST" })
        .then((result) => result.lesson);
    },
    finish(id: string) {
      return request<{ lesson: LessonSummary }>(`/api/lessons/${encodeURIComponent(id)}/finish`, { method: "POST" })
        .then((result) => result.lesson);
    },
    callToken(id: string, profile?: CollaborationProfile) {
      return request<CallCredentials>(`/api/lessons/${encodeURIComponent(id)}/call-token`, {
        method: "POST",
        body: jsonBody(profile ? { profile } : {}),
      });
    },
    callParticipants(id: string) {
      return request<{ participants: CallLobbyParticipant[] }>(
        `/api/lessons/${encodeURIComponent(id)}/call-participants`,
      ).then((result) => result.participants);
    },
    updateCallProfile(id: string, profile: CollaborationProfile) {
      return request<void>(`/api/lessons/${encodeURIComponent(id)}/call-profile`, {
        method: "PATCH",
        body: jsonBody({ profile }),
      });
    },
    attachMaterial(id: string, materialId: string, position: number) {
      return request<{ materials: MaterialDetail[] }>(
        `/api/lessons/${encodeURIComponent(id)}/materials/${encodeURIComponent(materialId)}`,
        { method: "PUT", body: jsonBody({ position }) },
      );
    },
  },
  materials: {
    async list(filters?: { studentId?: string; search?: string; kind?: string }) {
      const payload = await request<MaterialDetail[] | Record<string, unknown>>(
        `/api/materials${queryString(filters)}`,
      );
      return listFrom<MaterialDetail>(payload);
    },
    create(payload: (Pick<MaterialSummary, "title" | "kind"> & Partial<MaterialSummary>) | FormData) {
      return request<MaterialDetail | { material: MaterialDetail }>("/api/materials", {
        method: "POST",
        body: payload instanceof FormData ? payload : jsonBody(payload),
      }).then((result) => entityFrom<MaterialDetail>(result, "material"));
    },
    get(id: string) {
      return request<MaterialDetail | { material: MaterialDetail }>(`/api/materials/${encodeURIComponent(id)}`)
        .then((result) => entityFrom<MaterialDetail>(result, "material"));
    },
    update(id: string, payload: Partial<MaterialSummary>) {
      return request<MaterialDetail | { material: MaterialDetail }>(`/api/materials/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: jsonBody(payload),
      }).then((result) => entityFrom<MaterialDetail>(result, "material"));
    },
    setProgress(id: string, studentId: string, status: NonNullable<MaterialDetail["progressStatus"]>, lessonId?: string | null) {
      return request<MaterialProgressUpdate>(`/api/materials/${encodeURIComponent(id)}/progress`, {
        method: "PATCH",
        body: jsonBody({ studentId, status, lessonId }),
      });
    },
  },
  assignments: {
    async list(filters?: { studentId?: string; status?: string; scope?: string }) {
      const payload = await request<AssignmentSummary[] | Record<string, unknown>>(
        `/api/assignments${queryString(filters)}`,
      );
      return listFrom(payload);
    },
    create(payload: {
      title: string;
      description: string;
      studentId: string;
      dueAt?: string | null;
      materialIds?: string[];
    }) {
      return request<AssignmentSummary | { assignment: AssignmentSummary }>("/api/assignments", {
        method: "POST",
        body: jsonBody(payload),
      }).then((result) => entityFrom<AssignmentSummary>(result, "assignment"));
    },
    update(id: string, payload: Partial<AssignmentSummary>) {
      return request<AssignmentSummary | { assignment: AssignmentSummary }>(`/api/assignments/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: jsonBody(payload),
      }).then((result) => entityFrom<AssignmentSummary>(result, "assignment"));
    },
    submit(id: string, answer: string) {
      return request<{ assignment: AssignmentSummary }>(`/api/assignments/${encodeURIComponent(id)}/submit`, {
        method: "POST",
        body: jsonBody({ answer }),
      }).then((result) => result.assignment);
    },
    review(id: string, status: "reviewed" | "returned", feedback: string) {
      return request<{ assignment: AssignmentSummary }>(`/api/assignments/${encodeURIComponent(id)}/review`, {
        method: "POST",
        body: jsonBody({ status, feedback }),
      }).then((result) => result.assignment);
    },
  },
  tutors: {
    async list() {
      const payload = await request<TutorSummary[] | Record<string, unknown>>("/api/tutors");
      return listFrom(payload);
    },
    create(payload: { displayName: string; loginName: string; password?: string }) {
      return request<CreateTutorResult | ({ tutor: TutorSummary } & Partial<BackendInvite<object>>)>("/api/tutors", {
        method: "POST",
        body: jsonBody(payload),
      }).then((result) => "invite" in result && result.invite ? {
        tutor: result.tutor,
        inviteUrl: result.invite.url,
      } : result);
    },
    update(id: string, payload: Partial<Pick<TutorSummary, "displayName" | "status">>) {
      return request<TutorSummary | { tutor: TutorSummary }>(`/api/tutors/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: jsonBody(payload),
      }).then((result) => entityFrom<TutorSummary>(result, "tutor"));
    },
    setStatus(id: string, status: TutorSummary["status"]) {
      return request<{ tutor: TutorSummary }>(`/api/tutors/${encodeURIComponent(id)}/status`, {
        method: "PATCH",
        body: jsonBody({ status }),
      }).then((result) => result.tutor);
    },
  },
};

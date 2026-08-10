export type Role = "admin" | "tutor" | "student";
export type AccountStatus = "pending" | "active" | "suspended";

export interface CurrentUser {
  id: string;
  role: Role;
  displayName: string;
  loginName?: string;
  status: AccountStatus;
  tutorId?: string | null;
}

export interface StudentSummary {
  id: string;
  displayName: string;
  loginName: string;
  status: AccountStatus;
  note?: string;
  nextLessonAt?: string | null;
  lastLessonAt?: string | null;
  pendingAssignments: number;
}

export interface LessonSummary {
  id: string;
  title: string;
  studentId: string;
  studentName: string;
  scheduledAt: string;
  durationMinutes: number;
  status: "scheduled" | "active" | "completed" | "cancelled";
  startedAt?: string | null;
  endedAt?: string | null;
}

export interface MaterialSummary {
  id: string;
  title: string;
  kind: "note" | "link" | "file" | "task";
  body?: string;
  url?: string;
  fileName?: string;
  mimeType?: string;
  tags: string[];
  createdAt: string;
}

export interface AssignmentSummary {
  id: string;
  title: string;
  description: string;
  studentId: string;
  studentName: string;
  dueAt?: string | null;
  status: "assigned" | "submitted" | "reviewed" | "returned";
  answer?: string;
  feedback?: string;
  materialIds?: string[];
  createdAt: string;
  submittedAt?: string | null;
}

export interface TutorSummary {
  id: string;
  displayName: string;
  loginName: string;
  status: AccountStatus;
  studentCount: number;
  createdAt: string;
  lastLoginAt?: string | null;
}

export interface ApiErrorBody {
  error: string;
  details?: Record<string, string[]>;
}

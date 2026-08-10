import path from "node:path";
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import multer from "multer";
import { z } from "zod";
import type { AppContext } from "../types.js";
import { currentAuth, HttpError, pagination, parseBody, requireAuth, requireCsrf } from "../http.js";
import { newId, nowIso } from "../security.js";
import { serializeMaterial } from "../serializers.js";
import { writeAudit } from "../audit.js";
import {
  MaterialFileError,
  type MaterialFileRow,
  type MaterialUploadReservation,
  type PreparedMaterialFile,
} from "../material-files/service.js";

const materialKind = z.enum(["note", "link", "file", "task"]);
const webUrl = z.string().trim().url().max(2000).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "Разрешены только ссылки http:// и https://");
const baseMaterialSchema = z.object({
  title: z.string().trim().min(1).max(200),
  kind: materialKind,
  body: z.string().max(100_000).optional(),
  url: webUrl.optional().or(z.literal("")),
});

function parseStringArray(value: unknown, field: string, max = 100): string[] | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  const result = z.array(z.string().trim().min(1).max(100)).max(max).safeParse(parsed);
  if (!result.success) throw new HttpError(400, `Некорректное поле ${field}`);
  return [...new Set(result.data)];
}

function materialRow(context: AppContext, id: string): Record<string, unknown> | undefined {
  return context.db.prepare(`
    SELECT m.*,
      (SELECT json_group_array(ma.student_id) FROM material_access ma WHERE ma.material_id = m.id) AS student_ids_json
    FROM materials m WHERE m.id = ?
  `).get(id) as Record<string, unknown> | undefined;
}

function canReadMaterial(context: AppContext, material: Record<string, unknown>, role: string, userId: string): boolean {
  if (role === "tutor") return material.tutor_id === userId;
  if (role !== "student") return false;
  return Boolean(context.db.prepare("SELECT 1 FROM material_access WHERE material_id = ? AND student_id = ?")
    .get(material.id, userId));
}

function assertOwnedStudents(context: AppContext, tutorId: string, studentIds: string[]): void {
  if (studentIds.length === 0) return;
  const placeholders = studentIds.map(() => "?").join(",");
  const count = (context.db.prepare(`
    SELECT COUNT(*) AS count FROM users
    WHERE tutor_id = ? AND role = 'student' AND status != 'suspended' AND id IN (${placeholders})
  `).get(tutorId, ...studentIds) as { count: number }).count;
  if (count !== studentIds.length) throw new HttpError(404, "Один или несколько учеников не найдены");
}

function replaceAccess(context: AppContext, materialId: string, studentIds: string[]): void {
  if (studentIds.length === 0) {
    context.db.prepare("DELETE FROM material_access WHERE material_id = ?").run(materialId);
    return;
  }
  const placeholders = studentIds.map(() => "?").join(",");
  context.db.prepare(`DELETE FROM material_access WHERE material_id = ? AND student_id NOT IN (${placeholders})`)
    .run(materialId, ...studentIds);
  const insert = context.db.prepare(`
    INSERT INTO material_access (material_id, student_id, granted_at, status, updated_at)
    VALUES (?, ?, ?, 'assigned', ?)
    ON CONFLICT(material_id, student_id) DO NOTHING
  `);
  const now = nowIso();
  for (const studentId of studentIds) insert.run(materialId, studentId, now, now);
}

interface MaterialUploadRequest extends Request {
  materialUploadReservation?: MaterialUploadReservation;
  materialUploadTutorId?: string;
}

function materialFileHttpError(error: unknown): unknown {
  if (!(error instanceof MaterialFileError)) return error;
  switch (error.code) {
    case "INVALID_UPLOAD": return new HttpError(400, "Некорректная загрузка файла");
    case "QUOTA_EXCEEDED": return new HttpError(413, "Квота файлов исчерпана");
    case "RATE_LIMITED": return new HttpError(429, "Слишком много загруженных данных");
    case "DISK_PRESSURE": return new HttpError(507, "Недостаточно свободного места для загрузки");
    case "MALWARE_DETECTED": return new HttpError(422, "Файл отклонён проверкой безопасности");
    case "MALWARE_SCAN_UNAVAILABLE": return new HttpError(503, "Проверка файла временно недоступна");
    case "STORAGE_CORRUPT": return new HttpError(500, "Файл в хранилище повреждён");
    case "STORAGE_ERROR": return new HttpError(503, "Хранилище файлов временно недоступно");
  }
}

async function cleanupUpload(context: AppContext, req: MaterialUploadRequest): Promise<void> {
  await context.materialFiles.abortUpload(
    req.materialUploadReservation?.uploadId,
    req.file?.size,
  );
}

function boundedOriginalName(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  return (normalized || "file").slice(0, 255);
}

function materialTextBytes(values: readonly (string | null | undefined)[]): number {
  return values.reduce((total, value) => (
    total + Buffer.byteLength(value ?? "", "utf8")
  ), 0);
}

export function createMaterialsRouter(context: AppContext): Router {
  const storage = multer.diskStorage({
    destination: (req, _file, callback) => {
      const uploadRequest = req as MaterialUploadRequest;
      if (!uploadRequest.materialUploadTutorId) {
        callback(new Error("Material upload tutor is missing"), "");
        return;
      }
      void context.materialFiles.beginUpload(uploadRequest.materialUploadTutorId)
        .then((reservation) => {
          uploadRequest.materialUploadReservation = reservation;
          callback(null, context.materialFiles.quarantineRoot);
        })
        .catch((error) => callback(
          materialFileHttpError(error) instanceof Error
            ? materialFileHttpError(error) as Error
            : new Error("Material upload reservation failed"),
          "",
        ));
    },
    filename: (req, _file, callback) => {
      const reservation = (req as MaterialUploadRequest).materialUploadReservation;
      if (!reservation) {
        callback(new Error("Material upload reservation is missing"), "");
        return;
      }
      callback(null, path.basename(reservation.quarantineKey));
    },
  });
  const upload = multer({
    storage,
    limits: {
      fileSize: context.materialFiles.limits.maxFileBytes,
      files: 1,
      fields: 30,
      fieldNameSize: 100,
      fieldSize: 128 * 1024,
    },
  });
  const markUploadTutor: RequestHandler = (req, res, next) => {
    (req as MaterialUploadRequest).materialUploadTutorId = currentAuth(res).user.id;
    next();
  };
  const receiveUpload: RequestHandler = (req, res, next) => {
    upload.single("file")(req, res, (error) => {
      if (!error) {
        next();
        return;
      }
      void cleanupUpload(context, req as MaterialUploadRequest)
        .then(
          () => next(materialFileHttpError(error)),
          () => next(materialFileHttpError(error)),
        );
    });
  };
  const router = Router();
  router.use(requireAuth("tutor", "student"), requireCsrf(context));

  router.get("/", (req, res) => {
    const auth = currentAuth(res).user;
    const { limit, offset } = pagination(req, 200);
    const search = typeof req.query.search === "string" ? `%${req.query.search.trim()}%` : "%";
    const kind = typeof req.query.kind === "string" && materialKind.safeParse(req.query.kind).success ? req.query.kind : null;
    const requestedStudentId = typeof req.query.studentId === "string" ? req.query.studentId : null;
    const progressStudentId = auth.role === "student" ? auth.id : requestedStudentId;
    if (auth.role === "tutor" && requestedStudentId) assertOwnedStudents(context, auth.id, [requestedStudentId]);
    if (auth.role === "student" && requestedStudentId && requestedStudentId !== auth.id) {
      throw new HttpError(403, "Нельзя просматривать материалы другого ученика");
    }
    const rows = context.db.prepare(`
      SELECT m.*,
        (SELECT json_group_array(ma2.student_id) FROM material_access ma2 WHERE ma2.material_id = m.id) AS student_ids_json,
        (SELECT ma3.status FROM material_access ma3 WHERE ma3.material_id = m.id AND ma3.student_id = ?) AS progress_status,
        (SELECT ma3.lesson_id FROM material_access ma3 WHERE ma3.material_id = m.id AND ma3.student_id = ?) AS progress_lesson_id,
        (SELECT ma3.updated_at FROM material_access ma3 WHERE ma3.material_id = m.id AND ma3.student_id = ?) AS progress_updated_at
      FROM materials m
      WHERE ((? = 'tutor' AND m.tutor_id = ?) OR
             (? = 'student' AND EXISTS (
               SELECT 1 FROM material_access ma WHERE ma.material_id = m.id AND ma.student_id = ?
             )))
        AND (? IS NULL OR m.kind = ?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM material_access maf WHERE maf.material_id = m.id AND maf.student_id = ?))
        AND (m.title LIKE ? OR COALESCE(m.body, '') LIKE ? OR m.tags_json LIKE ?)
      ORDER BY m.created_at DESC LIMIT ? OFFSET ?
    `).all(
      progressStudentId, progressStudentId, progressStudentId,
      auth.role, auth.id, auth.role, auth.id,
      kind, kind, requestedStudentId, requestedStudentId,
      search, search, search, limit, offset,
    ) as Array<Record<string, unknown>>;
    res.json({
      materials: rows.map((row) => {
        const material = serializeMaterial(row);
        if (auth.role === "student") delete material.studentIds;
        return material;
      }),
    });
  });

  router.post("/", requireAuth("tutor"), markUploadTutor, receiveUpload, async (req, res, next) => {
    const uploadRequest = req as MaterialUploadRequest;
    try {
      const body = parseBody(baseMaterialSchema, req.body);
      const tutor = currentAuth(res).user;
      const tags = (parseStringArray(req.body.tags, "tags", 30) ?? []).map((tag) => tag.slice(0, 40));
      const tagsJson = JSON.stringify(tags);
      const studentIds = parseStringArray(req.body.studentIds, "studentIds") ?? [];
      assertOwnedStudents(context, tutor.id, studentIds);
      if ((body.kind === "note" || body.kind === "task") && !body.body?.trim()) {
        throw new HttpError(400, "Для заметки или задачи требуется текст");
      }
      if (body.kind === "link" && !body.url) throw new HttpError(400, "Для ссылки требуется URL");
      if (body.kind === "file" && !req.file) throw new HttpError(400, "Прикрепите файл");
      if (body.kind !== "file" && req.file) throw new HttpError(400, "Файл допустим только для материала типа file");

      const id = newId();
      const now = nowIso();
      const prepared = req.file
        ? await context.materialFiles.prepareUpload(
          uploadRequest.materialUploadReservation!,
          req.file.size,
        )
        : undefined;
      const originalFileName = req.file ? boundedOriginalName(req.file.originalname) : null;
      const mimeType = req.file?.mimetype.slice(0, 255) ?? null;
      const writePlan = {
        tutorId: tutor.id,
        materialId: id,
        nextTextBytes: materialTextBytes([
          body.title,
          body.body?.trim(),
          body.url || null,
          tagsJson,
          originalFileName,
          mimeType,
        ]),
      };
      const persist = (file?: PreparedMaterialFile): void => {
        context.db.prepare(`
          INSERT INTO materials (
            id, tutor_id, title, kind, body, url, tags_json, storage_key,
            original_file_name, mime_type, file_size, created_at, updated_at,
            file_sha256, scan_provider, scanned_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, tutor.id, body.title, body.kind, body.body?.trim() || null, body.url || null,
          tagsJson, file?.storageKey ?? null,
          originalFileName,
          mimeType,
          file?.byteSize ?? null, now, now,
          file?.sha256 ?? null, file?.scanProvider ?? null, file?.scannedAt ?? null,
        );
        replaceAccess(context, id, studentIds);
      };
      if (prepared) context.materialFiles.commitPrepared(prepared, persist, writePlan);
      else context.materialFiles.commitMaterialWrite(writePlan, persist);
      if (!prepared) await cleanupUpload(context, uploadRequest);
      writeAudit(context, req, res, "material.created", "material", id, { kind: body.kind, studentCount: studentIds.length });
      res.status(201).json({ material: serializeMaterial(materialRow(context, id)!) });
    } catch (error) {
      await cleanupUpload(context, uploadRequest).catch(() => undefined);
      next(materialFileHttpError(error));
    }
  });

  router.get("/:id", (req, res, next) => {
    const auth = currentAuth(res).user;
    const material = materialRow(context, req.params.id);
    if (!material || !canReadMaterial(context, material, auth.role, auth.id)) return next(new HttpError(404, "Материал не найден"));
    if (auth.role === "student") {
      const progress = context.db.prepare(`
        SELECT status, lesson_id, updated_at FROM material_access WHERE material_id = ? AND student_id = ?
      `).get(material.id, auth.id) as { status: string; lesson_id: string | null; updated_at: string };
      material.progress_status = progress.status;
      material.progress_lesson_id = progress.lesson_id;
      material.progress_updated_at = progress.updated_at;
    }
    const serialized = serializeMaterial(material);
    if (auth.role === "student") delete serialized.studentIds;
    res.json({ material: serialized });
  });

  router.get("/:id/file", async (req, res, next) => {
    try {
      const auth = currentAuth(res).user;
      const material = materialRow(context, req.params.id);
      if (!material || material.kind !== "file" || !canReadMaterial(context, material, auth.role, auth.id)) {
        throw new HttpError(404, "Файл не найден");
      }
      const filePath = await context.materialFiles.ensureScanned(material as unknown as MaterialFileRow);
      const current = materialRow(context, req.params.id);
      if (
        !current
        || current.storage_key !== material.storage_key
        || !canReadMaterial(context, current, auth.role, auth.id)
      ) {
        throw new HttpError(404, "Файл не найден");
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.download(filePath, current.original_file_name as string, (error) => {
        if (error && !res.headersSent) next(error);
      });
    } catch (error) {
      next(materialFileHttpError(error));
    }
  });

  router.patch("/:id", requireAuth("tutor"), markUploadTutor, receiveUpload, async (req, res, next) => {
    const uploadRequest = req as MaterialUploadRequest;
    try {
      const tutor = currentAuth(res).user;
      const existing = materialRow(context, req.params.id);
      if (!existing || existing.tutor_id !== tutor.id) throw new HttpError(404, "Материал не найден");
      if (req.body.kind && req.body.kind !== existing.kind) throw new HttpError(409, "Тип материала нельзя изменить");
      if (req.file && existing.kind !== "file") throw new HttpError(400, "Этот материал не является файлом");
      const title = req.body.title === undefined
        ? existing.title as string
        : parseBody(z.string().trim().min(1).max(200), req.body.title);
      const body = req.body.body === undefined ? existing.body as string | null : parseBody(z.string().max(100_000), req.body.body);
      const url = req.body.url === undefined
        ? existing.url as string | null
        : (req.body.url ? parseBody(webUrl, req.body.url) : null);
      if ((existing.kind === "note" || existing.kind === "task") && !body?.trim()) throw new HttpError(400, "Текст не может быть пустым");
      if (existing.kind === "link" && !url) throw new HttpError(400, "URL не может быть пустым");
      const tags = parseStringArray(req.body.tags, "tags", 30);
      const tagsJson = tags
        ? JSON.stringify(tags.map((tag) => tag.slice(0, 40)))
        : existing.tags_json as string;
      const studentIds = parseStringArray(req.body.studentIds, "studentIds");
      if (studentIds) assertOwnedStudents(context, tutor.id, studentIds);
      const now = nowIso();
      const prepared = req.file
        ? await context.materialFiles.prepareUpload(
          uploadRequest.materialUploadReservation!,
          req.file.size,
        )
        : undefined;
      const originalFileName = req.file
        ? boundedOriginalName(req.file.originalname)
        : existing.original_file_name as string | null;
      const mimeType = req.file?.mimetype.slice(0, 255)
        ?? existing.mime_type as string | null;
      const writePlan = {
        tutorId: tutor.id,
        materialId: existing.id as string,
        replacingMaterialId: existing.id as string,
        nextTextBytes: materialTextBytes([
          title,
          body?.trim(),
          url,
          tagsJson,
          originalFileName,
          mimeType,
        ]),
      };
      const persist = (file?: PreparedMaterialFile): void => {
        if (file && existing.storage_key && existing.storage_key !== file.storageKey) {
          context.materialFiles.enqueueGarbage(existing.storage_key as string, now);
        }
        context.db.prepare(`
          UPDATE materials SET title = ?, body = ?, url = ?, tags_json = ?,
            storage_key = ?, original_file_name = ?, mime_type = ?, file_size = ?,
            file_sha256 = ?, scan_provider = ?, scanned_at = ?, updated_at = ?
          WHERE id = ? AND tutor_id = ?
        `).run(
          title, body?.trim() || null, url,
          tagsJson,
          file?.storageKey ?? existing.storage_key,
          originalFileName,
          mimeType,
          file?.byteSize ?? existing.file_size,
          file?.sha256 ?? existing.file_sha256,
          file?.scanProvider ?? existing.scan_provider,
          file?.scannedAt ?? existing.scanned_at,
          now, existing.id, tutor.id,
        );
        if (studentIds) replaceAccess(context, existing.id as string, studentIds);
      };
      if (prepared) context.materialFiles.commitPrepared(prepared, persist, writePlan);
      else context.materialFiles.commitMaterialWrite(writePlan, persist);
      if (!prepared) await cleanupUpload(context, uploadRequest);
      await context.materialFiles.cleanupGarbage();
      writeAudit(context, req, res, "material.updated", "material", existing.id as string);
      res.json({ material: serializeMaterial(materialRow(context, existing.id as string)!) });
    } catch (error) {
      await cleanupUpload(context, uploadRequest).catch(() => undefined);
      next(materialFileHttpError(error));
    }
  });

  router.patch("/:id/progress", requireAuth("tutor"), (req, res, next) => {
    try {
      const id = String(req.params.id);
      const body = parseBody(z.object({
        studentId: z.string().uuid(),
        status: z.enum(["assigned", "covered", "completed"]),
        lessonId: z.string().uuid().nullable().optional(),
      }), req.body);
      const tutor = currentAuth(res).user;
      const material = materialRow(context, id);
      if (!material || material.tutor_id !== tutor.id) throw new HttpError(404, "Материал не найден");
      assertOwnedStudents(context, tutor.id, [body.studentId]);
      if (body.lessonId) {
        const lesson = context.db.prepare(`
          SELECT 1 FROM lessons WHERE id = ? AND tutor_id = ? AND student_id = ?
        `).get(body.lessonId, tutor.id, body.studentId);
        if (!lesson) throw new HttpError(404, "Урок не найден");
      }
      const now = nowIso();
      context.db.prepare(`
        INSERT INTO material_access (material_id, student_id, granted_at, status, updated_at, lesson_id)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(material_id, student_id) DO UPDATE SET
          status = excluded.status, updated_at = excluded.updated_at, lesson_id = excluded.lesson_id
      `).run(id, body.studentId, now, body.status, now, body.lessonId ?? null);
      writeAudit(context, req, res, "material.progress_updated", "material", id, {
        studentId: body.studentId,
        status: body.status,
        lessonId: body.lessonId ?? null,
      });
      res.json({
        materialId: id,
        studentId: body.studentId,
        progressStatus: body.status,
        lessonId: body.lessonId ?? null,
        updatedAt: now,
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id", requireAuth("tutor"), async (req, res, next) => {
    try {
      const tutor = currentAuth(res).user;
      const material = materialRow(context, req.params.id);
      if (!material || material.tutor_id !== tutor.id) throw new HttpError(404, "Материал не найден");
      context.db.transaction(() => {
        if (material.storage_key) {
          context.materialFiles.enqueueGarbage(material.storage_key as string);
        }
        writeAudit(context, req, res, "material.deleted", "material", req.params.id, { kind: material.kind });
        const deleted = context.db.prepare(`
          DELETE FROM materials WHERE id = ? AND tutor_id = ?
        `).run(req.params.id, tutor.id);
        if (deleted.changes !== 1) throw new HttpError(409, "Материал изменился во время удаления");
      }).immediate();
      await context.materialFiles.cleanupGarbage();
      res.sendStatus(204);
    } catch (error) {
      next(materialFileHttpError(error));
    }
  });

  return router;
}

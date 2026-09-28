import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  addJobImage,
  createManualJob,
  deleteJob,
  deleteJobImage,
  getAllKeywords,
  getJob,
  listJobs,
  parseAndCreateJob,
  parseRawText,
  updateJob,
  type SortOption,
} from "../services/jobService.js";
import { uploadJobImage } from "../services/profileService.js";
import { recognizeBuffer } from "../services/ocrService.js";
import { isSupabaseConfigured } from "../db/supabase.js";

// 첨부 상한(5장)과 맞춘다. CLOVA는 유료 API라 호출당 비용 캡 역할도 겸한다.
const OCR_MAX_FILES = 5;

const structuredKeywordSchema = z.object({
  text: z.string().min(1).max(20),
  source_section: z.enum(["자격요건", "우대사항", "기타"]),
  order: z.number().int().min(0),
  source: z.enum(["llm", "user"]),
});

const parseSchema = z.object({
  url: z.string().min(1),
  folder_id: z.string().uuid().nullable().optional(),
});

const parseTextSchema = z.object({
  raw_text: z.string().min(1),
});

const updateJobSchema = z.object({
  folder_id: z.string().uuid().nullable().optional(),
  company_name: z.string().optional(),
  job_title: z.string().optional(),
  recruitment_field: z.string().optional(),
  job_description: z.string().optional(),
  qualifications: z.string().optional(),
  preferences: z.string().optional(),
  industry: z.string().optional(),
  deadline_raw: z.string().optional(),
  deadline_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "마감일은 YYYY-MM-DD 형식이어야 합니다.")
    .nullable()
    .optional(),
  deadline_status: z.enum(["always_open", "closed"]).nullable().optional(),
  required_documents: z.string().optional(),
  application_method: z.string().optional(),
  raw_text: z.string().optional(),
  memo: z.string().max(5000).optional(),
  competency_keywords: z
    .union([z.array(z.string()).max(30), z.array(structuredKeywordSchema).max(30)])
    .optional(),
});

// source_url은 생성 시에만 받는다. updateJobSchema에는 일부러 넣지 않아
// PATCH로는 변경할 수 없게 유지한다.
const createJobSchema = updateJobSchema.extend({
  raw_text: z.string().min(1),
  source_url: z.string().nullable().optional(),
});

export async function jobsRoutes(app: FastifyInstance) {
  app.post("/jobs/parse", async (request) => {
    const body = parseSchema.parse(request.body);
    return parseAndCreateJob(
      request.user!.id,
      body.url,
      body.folder_id ?? null
    );
  });

  // 수동 추가 1단계: 원문 텍스트 파싱만, DB에는 쓰지 않는다.
  app.post("/jobs/parse-text", async (request) => {
    const { raw_text } = parseTextSchema.parse(request.body);
    return parseRawText(raw_text);
  });

  // 수동 추가 2단계: 사용자가 '저장하기'를 눌렀을 때만 생성.
  app.post("/jobs", async (request) => {
    const body = createJobSchema.parse(request.body);
    return createManualJob(request.user!.id, body);
  });

  app.get("/jobs", async (request) => {
    const query = request.query as {
      folderId?: string;
      uncategorized?: string;
      keywords?: string | string[];
      excludeExpired?: string;
      sort?: SortOption;
    };

    const keywords = query.keywords
      ? Array.isArray(query.keywords)
        ? query.keywords
        : [query.keywords]
      : undefined;

    return listJobs(request.user!.id, {
      folderId: query.folderId,
      uncategorized: query.uncategorized === "true",
      keywords,
      excludeExpired: query.excludeExpired === "true",
      sort: query.sort,
    });
  });

  app.get("/jobs/keywords", async (request) => {
    return getAllKeywords(request.user!.id);
  });

  app.get("/jobs/:id", async (request) => {
    const { id } = request.params as { id: string };
    return getJob(request.user!.id, id);
  });

  app.patch("/jobs/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = updateJobSchema.parse(request.body);
    return updateJob(request.user!.id, id, body as Parameters<typeof updateJob>[2]);
  });

  app.delete("/jobs/:id", async (request) => {
    const { id } = request.params as { id: string };
    await deleteJob(request.user!.id, id);
    return { ok: true };
  });

  // 이미지 텍스트 변환. 상태를 만들지 않으므로 :id를 받지 않는다 — 아직 저장되지 않은
  // draft 공고(첨부만 해둔 상태)에서도 그대로 쓸 수 있어야 하기 때문.
  app.post("/jobs/ocr", async (request, reply) => {
    const texts: string[] = [];
    let received = 0;

    for await (const part of request.files()) {
      received += 1;
      if (received > OCR_MAX_FILES) {
        return reply.status(400).send({
          error: "too_many_files",
          message: `이미지는 한 번에 최대 ${OCR_MAX_FILES}장까지 변환할 수 있어요.`,
        });
      }

      if (!["image/jpeg", "image/png", "image/jpg"].includes(part.mimetype)) {
        return reply.status(400).send({
          error: "invalid_format",
          message: "JPG, PNG 파일만 변환할 수 있어요.",
        });
      }

      const buffer = await part.toBuffer();
      if (buffer.length > 4 * 1024 * 1024) {
        return reply.status(400).send({
          error: "file_too_large",
          message: "4MB 이하의 파일만 변환할 수 있어요.",
        });
      }

      // 개별 실패는 빈 문자열이라 조용히 건너뛴다(best-effort). 전부 실패하면 아래에서 400.
      const text = await recognizeBuffer(
        buffer,
        part.mimetype.includes("png") ? "png" : "jpg"
      );
      if (text.trim()) texts.push(text.trim());
    }

    if (received === 0) {
      return reply
        .status(400)
        .send({ error: "no_file", message: "변환할 이미지를 선택해 주세요." });
    }

    if (texts.length === 0) {
      return reply.status(422).send({
        error: "no_text_recognized",
        message: "이미지에서 텍스트를 찾지 못했어요.",
      });
    }

    return { text: texts.join("\n\n") };
  });

  app.post("/jobs/:id/images", async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = await request.file();

    if (!data) {
      return reply.status(400).send({
        error: "no_file",
        message: "파일을 선택해 주세요.",
      });
    }

    const mime = data.mimetype;
    if (!["image/jpeg", "image/png", "image/jpg"].includes(mime)) {
      return reply.status(400).send({
        error: "invalid_format",
        message: "JPG, PNG 파일만 첨부할 수 있어요.",
      });
    }

    const buffer = await data.toBuffer();
    if (buffer.length > 4 * 1024 * 1024) {
      return reply.status(400).send({
        error: "file_too_large",
        message: "4MB 이하의 파일만 첨부할 수 있어요.",
      });
    }

    const filename = `${Date.now()}`;
    const { path, publicUrl } = await uploadJobImage(
      request.user!.id,
      id,
      buffer,
      mime,
      filename
    );

    const job = await getJob(request.user!.id, id);
    const sortOrder = (job.job_posting_images?.length ?? 0) + 1;
    const storagePath = isSupabaseConfigured() ? path : publicUrl;
    const image = await addJobImage(request.user!.id, id, storagePath, sortOrder);
    return image;
  });

  app.delete("/jobs/:id/images/:imageId", async (request) => {
    const { id, imageId } = request.params as { id: string; imageId: string };
    await deleteJobImage(request.user!.id, id, imageId);
    return { ok: true };
  });
}

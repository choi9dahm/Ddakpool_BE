import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  addJobImage,
  deleteJob,
  deleteJobImage,
  getAllKeywords,
  getJob,
  listJobs,
  parseAndCreateJob,
  updateJob,
  type SortOption,
} from "../services/jobService.js";
import { uploadJobImage } from "../services/profileService.js";
import { isSupabaseConfigured } from "../db/supabase.js";

const parseSchema = z.object({ url: z.string().min(1) });

const updateJobSchema = z.object({
  purpose_tag: z.enum(["지원예정", "직무분석", "관심기업", "기타"]).nullable().optional(),
  company_name: z.string().optional(),
  job_title: z.string().optional(),
  recruitment_field: z.string().optional(),
  job_description: z.string().optional(),
  qualifications: z.string().optional(),
  preferences: z.string().optional(),
  industry: z.string().optional(),
  deadline_raw: z.string().optional(),
  deadline_date: z.string().nullable().optional(),
  required_documents: z.string().optional(),
  application_method: z.string().optional(),
  raw_text: z.string().optional(),
  memo: z.string().max(5000).optional(),
  competency_keywords: z.array(z.string()).max(30).optional(),
});

export async function jobsRoutes(app: FastifyInstance) {
  app.post("/jobs/parse", async (request) => {
    const body = parseSchema.parse(request.body);
    return parseAndCreateJob(request.user!.id, body.url);
  });

  app.get("/jobs", async (request) => {
    const query = request.query as {
      tag?: string;
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
      tag: query.tag,
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
    return updateJob(request.user!.id, id, body);
  });

  app.delete("/jobs/:id", async (request) => {
    const { id } = request.params as { id: string };
    await deleteJob(request.user!.id, id);
    return { ok: true };
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

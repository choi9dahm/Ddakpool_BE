import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  deleteAccount,
  getProfile,
  updateProfile,
  uploadAvatar,
} from "../services/profileService.js";
import { getKpiSummary } from "../services/analyticsService.js";

const nicknameSchema = z.object({
  nickname: z
    .string()
    .min(2)
    .max(8)
    .regex(/^[가-힣a-zA-Z0-9]+$/),
});

export async function profileRoutes(app: FastifyInstance) {
  app.get("/profile", async (request) => {
    return getProfile(request.user!.id);
  });

  app.patch("/profile", async (request) => {
    const body = nicknameSchema.parse(request.body);
    return updateProfile(request.user!.id, { nickname: body.nickname });
  });

  app.post("/profile/avatar", async (request, reply) => {
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
        message: "JPG, PNG 파일만 업로드할 수 있어요.",
      });
    }

    const buffer = await data.toBuffer();
    if (buffer.length > 5 * 1024 * 1024) {
      return reply.status(400).send({
        error: "file_too_large",
        message: "5MB 이하의 파일만 업로드할 수 있어요.",
      });
    }

    const url = await uploadAvatar(request.user!.id, buffer, mime);
    return { avatar_url: url };
  });

  app.delete("/account", async (request) => {
    await deleteAccount(request.user!.id);
    return { ok: true };
  });

  app.get("/analytics/kpi", async (request) => {
    return getKpiSummary(request.user!.id);
  });
}

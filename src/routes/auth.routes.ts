import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { devUpdateProfile, DEV_USER_ID } from "../db/devStore.js";
import { isSupabaseConfigured } from "../db/supabase.js";
import { createProfile } from "../services/profileService.js";

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).max(12),
  nickname: z
    .string()
    .min(2)
    .max(8)
    .regex(/^[가-힣a-zA-Z0-9]+$/),
});

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/signup", async (request, reply) => {
    const body = signupSchema.parse(request.body);

    if (!isSupabaseConfigured()) {
      const profile = devUpdateProfile(DEV_USER_ID, { nickname: body.nickname });
      return reply.status(201).send({
        user: { id: DEV_USER_ID, email: body.email },
        profile,
      });
    }

    const { data: authData, error: authError } =
      await app.supabase.auth.admin.createUser({
        email: body.email,
        password: body.password,
        email_confirm: true,
      });

    if (authError || !authData.user) {
      const message =
        authError?.message?.includes("already") ||
        authError?.message?.includes("exists")
          ? "이미 사용 중인 이메일입니다."
          : authError?.message ?? "회원가입에 실패했습니다.";
      return reply.status(409).send({ error: "signup_failed", message });
    }

    try {
      const profile = await createProfile(
        authData.user.id,
        body.email,
        body.nickname
      );
      return reply.status(201).send({ user: authData.user, profile });
    } catch (err) {
      await app.supabase.auth.admin.deleteUser(authData.user.id);
      throw err;
    }
  });
}

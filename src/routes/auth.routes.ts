import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { devEnsureDefaultFolders, devUpdateProfile } from "../db/devStore.js";
import { isSupabaseConfigured, supabaseAdmin } from "../db/supabase.js";
import { AppError } from "../middleware/errorHandler.js";
import { createProfile } from "../services/profileService.js";
import { ensureDefaultFolders } from "../services/folderService.js";
import { capturePostHog, identifyPostHog } from "../lib/posthog.js";

const completeSignupSchema = z.object({
  nickname: z
    .string()
    .min(2)
    .max(8)
    .regex(/^[가-힣a-zA-Z0-9]+$/),
});

// 이메일/비밀번호 검증과 OTP 발송·확인은 FE가 Supabase 클라이언트 SDK로 직접 처리한다
// (signUp → verifyOtp). 이 라우트는 verifyOtp 성공 후 받은 세션(JWT)으로만 호출되며,
// profiles row + 기본 폴더를 만든다. 이미 있으면(재시도 등) 그대로 반환한다(멱등).
export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/complete-signup", async (request) => {
    const user = request.user!;
    if (user.isAnonymous) {
      throw new AppError(
        403,
        "게스트 세션으로는 가입을 완료할 수 없습니다.",
        "anonymous_not_allowed"
      );
    }

    const body = completeSignupSchema.parse(request.body);

    if (!isSupabaseConfigured()) {
      const profile = devUpdateProfile(user.id, { nickname: body.nickname });
      await devEnsureDefaultFolders(user.id);
      return profile;
    }

    const { data: existing } = await supabaseAdmin
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle();

    if (existing) {
      await ensureDefaultFolders(user.id);
      return existing;
    }

    const profile = await createProfile(user.id, user.email, body.nickname);
    await ensureDefaultFolders(user.id);
    // 가입 완료된 유저를 PostHog에 식별 + 가입 이벤트 기록
    identifyPostHog(user.id, { email: user.email, nickname: body.nickname });
    capturePostHog(user.id, "signup_completed", { email: user.email });
    return profile;
  });
}

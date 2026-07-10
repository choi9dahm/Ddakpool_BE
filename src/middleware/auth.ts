import type { FastifyReply, FastifyRequest } from "fastify";
import { DEV_AUTH_TOKEN, DEV_USER_ID } from "../db/devStore.js";
import { isSupabaseConfigured, supabaseAdmin } from "../db/supabase.js";
import { AppError } from "./errorHandler.js";

export interface AuthenticatedUser {
  id: string;
  email: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

export async function authMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply
) {
  const header = request.headers.authorization;

  if (!isSupabaseConfigured()) {
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (token === DEV_AUTH_TOKEN) {
      request.user = { id: DEV_USER_ID, email: "dev@local.test" };
      return;
    }
    throw new AppError(401, "인증이 필요합니다.", "unauthorized");
  }

  if (!header?.startsWith("Bearer ")) {
    throw new AppError(401, "인증이 필요합니다.", "unauthorized");
  }

  const token = header.slice(7);
  const { data, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !data.user) {
    throw new AppError(401, "다시 로그인해 주세요.", "session_expired");
  }

  request.user = {
    id: data.user.id,
    email: data.user.email ?? "",
  };
}

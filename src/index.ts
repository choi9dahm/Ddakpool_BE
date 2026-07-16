import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import dotenv from "dotenv";
import { supabaseAdmin } from "./db/supabase.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { authMiddleware } from "./middleware/auth.js";
import { authRoutes } from "./routes/auth.routes.js";
import { profileRoutes } from "./routes/profile.routes.js";
import { jobsRoutes } from "./routes/jobs.routes.js";
import { foldersRoutes } from "./routes/folders.routes.js";
import { closePageReader } from "./services/parser/pageReader.js";
import { getCorsOptions } from "./lib/cors.js";
import { shutdownPostHog } from "./lib/posthog.js";

dotenv.config();

declare module "fastify" {
  interface FastifyInstance {
    supabase: typeof supabaseAdmin;
  }
}

const app = Fastify({ logger: true });
app.decorate("supabase", supabaseAdmin);

app.setErrorHandler(errorHandler);

async function start() {
  await app.register(cors, getCorsOptions());

  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024 },
  });

  app.get("/health", async () => ({ ok: true }));

  app.addHook("onClose", async () => {
    await closePageReader();
    await shutdownPostHog();
  });

  await app.register(authRoutes);

  app.register(async (protectedRoutes) => {
    protectedRoutes.addHook("preHandler", authMiddleware);
    await protectedRoutes.register(profileRoutes);
    await protectedRoutes.register(jobsRoutes);
    await protectedRoutes.register(foldersRoutes);
  });

  const port = Number(process.env.PORT ?? 4000);
  await app.listen({ port, host: "0.0.0.0" });
}

// 종료 시 app.close()를 호출해 onClose hook(PostHog flush 등)이 실행되도록 한다.
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await app.close();
    } catch (err) {
      console.error(err);
    } finally {
      process.exit(0);
    }
  });
}

start().catch(async (err) => {
  console.error(err);
  await closePageReader();
  await shutdownPostHog();
  process.exit(1);
});

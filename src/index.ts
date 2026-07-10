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
import { closePageReader } from "./services/parser/pageReader.js";

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
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024 },
  });

  app.get("/health", async () => ({ ok: true }));

  app.addHook("onClose", async () => {
    await closePageReader();
  });

  await app.register(authRoutes);

  app.register(async (protectedRoutes) => {
    protectedRoutes.addHook("preHandler", authMiddleware);
    await protectedRoutes.register(profileRoutes);
    await protectedRoutes.register(jobsRoutes);
  });

  const port = Number(process.env.PORT ?? 4000);
  await app.listen({ port, host: "0.0.0.0" });
}

start().catch(async (err) => {
  console.error(err);
  await closePageReader();
  process.exit(1);
});

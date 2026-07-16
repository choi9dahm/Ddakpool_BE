import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getFoldersOrSeed,
  saveFolders,
} from "../services/folderService.js";

const folderInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(6),
  slot: z.number().int().min(1).max(5),
});

const saveFoldersSchema = z.object({
  folders: z.array(folderInputSchema).max(5),
  deletedIds: z.array(z.string().uuid()).optional().default([]),
});

export async function foldersRoutes(app: FastifyInstance) {
  app.get("/folders", async (request) => {
    return getFoldersOrSeed(request.user!.id);
  });

  app.put("/folders", async (request) => {
    const body = saveFoldersSchema.parse(request.body);
    return saveFolders(request.user!.id, body.folders, body.deletedIds);
  });
}

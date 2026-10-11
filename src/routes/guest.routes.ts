import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { claimGuestData, ensureGuestProfile } from "../services/guestService.js";

const claimSchema = z.object({
  guest_token: z.string().min(1),
});

export async function guestRoutes(app: FastifyInstance) {
  app.post("/auth/guest", async (request) => {
    const user = request.user!;
    return ensureGuestProfile(user.id, user.isAnonymous);
  });

  app.post("/auth/claim-guest", async (request) => {
    const body = claimSchema.parse(request.body);
    const result = await claimGuestData(body.guest_token, request.user!.id);
    return { result };
  });
}

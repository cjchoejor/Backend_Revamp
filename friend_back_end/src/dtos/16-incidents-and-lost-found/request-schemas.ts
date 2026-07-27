import { z } from "zod";

export const createLostAndFoundRequestSchema = z.object({
  entryId: z.string().optional(),
  guestProfileId: z.string().optional(),
  description: z.string().min(1),
});
export type CreateLostAndFoundRequestDto = z.infer<typeof createLostAndFoundRequestSchema>;


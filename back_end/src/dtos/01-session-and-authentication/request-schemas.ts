import { z } from "zod";

export const authenticateRequestSchema = z.object({
  pin: z.string().min(1),
  terminalId: z.string().min(1),
});
export type AuthenticateRequestDto = z.infer<typeof authenticateRequestSchema>;

export const pinSwitchRequestSchema = z.object({
  outgoingActorId: z.string().min(1),
  incomingPin: z.string().min(1),
  terminalId: z.string().min(1),
});
export type PinSwitchRequestDto = z.infer<typeof pinSwitchRequestSchema>;

export const manualLockRequestSchema = z.object({
  sessionId: z.string().min(1),
  actorId: z.string().min(1),
});
export type ManualLockRequestDto = z.infer<typeof manualLockRequestSchema>;

export const hardLogoutRequestSchema = z.object({
  sessionId: z.string().min(1),
});
export type HardLogoutRequestDto = z.infer<typeof hardLogoutRequestSchema>;

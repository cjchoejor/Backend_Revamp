import type { AuthenticateResponse } from "@/types/api";
import { apiRequest } from "./client";

export async function authenticate(pin: string, terminalId: string) {
  return apiRequest<AuthenticateResponse>("/api/auth/authenticate", {
    method: "POST",
    body: { pin, terminalId },
  });
}

export async function lockSession(sessionId: string, actorId: string) {
  return apiRequest<{ sessionId: string; status: string }>("/api/auth/lock", {
    method: "POST",
    body: { sessionId, actorId },
  });
}

export async function logoutSession(sessionId: string) {
  return apiRequest<{ sessionId: string; status: string }>("/api/auth/logout", {
    method: "POST",
    body: { sessionId },
  });
}

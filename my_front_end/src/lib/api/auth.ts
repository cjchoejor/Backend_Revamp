import type { AuthenticateResponse } from "@/types/api";
import { apiRequest } from "./client";

export async function authenticate(username: string, pin: string, terminalId: string) {
  return apiRequest<AuthenticateResponse>("/api/auth/authenticate", {
    method: "POST",
    body: { username, pin, terminalId },
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

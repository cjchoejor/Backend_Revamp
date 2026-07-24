import type { ApiErrorBody } from "@/types/api";
import type { Session } from "@/types/session";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body?: ApiErrorBody,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiRequestOptions = {
  method?: string;
  body?: unknown;
  session?: Session | null;
  headers?: Record<string, string>;
};

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { method = "GET", body, session, headers = {} } = options;

  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...headers,
  };

  // JWT auth: send Authorization: Bearer <jwt>. The backend verifies the token, looks up the
  // SessionRecord, and populates the actor from the DB (never from headers). Falls back to
  // X-Actor-* only when the session predates the JWT switchover — safe to drop later.
  if (session) {
    if (session.jwtToken) {
      reqHeaders["Authorization"] = `Bearer ${session.jwtToken}`;
    } else {
      reqHeaders["X-Actor-Id"] = session.userId;
      reqHeaders["X-Actor-Level"] = session.actorLevel;
    }
  }

  const res = await fetch(path.startsWith("/") ? path : `/api/${path}`, {
    method,
    headers: reqHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!res.ok) {
    const err = data as ApiErrorBody | null;
    throw new ApiError(
      res.status,
      err?.error ?? "RequestError",
      err?.message ?? `Request failed (${res.status})`,
      err ?? undefined,
    );
  }

  return data as T;
}

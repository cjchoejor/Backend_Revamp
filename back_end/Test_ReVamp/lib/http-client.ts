export type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

export type Actor = { id: string; level: "L1" | "L2" | "L3" | "L4" | "SYSTEM" };

export function actorHeaders(actor: Actor) {
  return { "content-type": "application/json", "x-actor-id": actor.id, "x-actor-level": actor.level };
}

/** pathname should start with `/` (e.g. `/inquiries`). baseUrl is typically `http://host:port/api`. */
export async function httpRequest<T = Json>(
  baseUrl: string,
  method: string,
  pathname: string,
  actor: Actor,
  body?: Json,
): Promise<{ status: number; json: T }> {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: actorHeaders(actor),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json: json as T };
}

export async function apiReachable(baseUrl: string): Promise<boolean> {
  try {
    const u = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    await fetch(`${u}/health`);
    return true;
  } catch {
    return false;
  }
}

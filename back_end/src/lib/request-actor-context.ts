import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The verified actor of the request being served (2026-09-18).
 *
 * Set by the auth middleware for the rest of the request, so code far from the route can know who
 * is acting and at what level without every service threading it through. Its first use is the
 * trace level: about a hundred trace writers hard-coded `actorLevel: "L1"`, so the audit trail
 * recorded the FOM and the GM as the front desk (the route had enforced their real authority —
 * only the record was wrong). The trace write now takes the verified level for the request's own
 * actor (see db.ts).
 *
 * Outside a request (workers, scripts) there is no store and nothing changes.
 */
export type RequestActorContext = { actorId: string; level: "L1" | "L2" | "L3" | "L4" };

const store = new AsyncLocalStorage<RequestActorContext>();

export function runWithRequestActor<T>(actor: RequestActorContext, fn: () => T): T {
  return store.run(actor, fn);
}

export function currentRequestActor(): RequestActorContext | undefined {
  return store.getStore();
}

const PERSON_LEVEL = /^L[1-4]$/;

/**
 * Give a trace the verified level of the request's actor — only when the trace names that same
 * actor and records a person's level. A SYSTEM trace, or one naming someone else, is left as it is.
 */
export function stampRequestActorLevel(data: { actorId?: unknown; actorLevel?: unknown } | null | undefined): void {
  const ctx = currentRequestActor();
  if (!ctx || !data) return;
  if (data.actorId !== ctx.actorId) return;
  if (!PERSON_LEVEL.test(String(data.actorLevel ?? ""))) return;
  data.actorLevel = ctx.level;
}

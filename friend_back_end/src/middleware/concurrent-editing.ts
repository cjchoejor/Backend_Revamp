import type { RequestHandler } from "express";

/**
 * Atlas Cat 11 — Concurrent Editing stage (ETag / version headers).
 * Not yet enforced; pass-through preserves route behaviour while reserving the pipeline slot.
 */
export function concurrentEditingPassthrough(): RequestHandler {
  return (_req, _res, next) => {
    next();
  };
}

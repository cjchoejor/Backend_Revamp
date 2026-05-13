import type { RequestHandler } from "express";

/**
 * Atlas Cat 11 — Rate Limiting stage.
 * Placeholder: no limits applied. Replace with Redis/token-bucket when operational requirements are set.
 */
export function rateLimitingPassthrough(): RequestHandler {
  return (_req, _res, next) => {
    next();
  };
}

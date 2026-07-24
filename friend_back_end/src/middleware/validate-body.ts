import type { RequestHandler } from "express";
import type { ZodTypeAny } from "zod";
import type { z } from "zod";
import { ValidationError } from "../lib/errors.js";

/**
 * Parses `req.body` with the given Zod schema. On success, replaces `req.body` with the parsed value.
 * On failure, forwards `ValidationError` with Zod `flatten()` details.
 */
export function validateBody<S extends ZodTypeAny>(schema: S): RequestHandler {
  return (req, _res, next) => {
    const raw = req.body;
    const candidate = raw === undefined || raw === null ? {} : raw;
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      next(new ValidationError("Invalid request body", parsed.error.flatten()));
      return;
    }
    (req as { body: z.infer<S> }).body = parsed.data;
    next();
  };
}

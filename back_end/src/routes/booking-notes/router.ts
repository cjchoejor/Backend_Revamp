import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import {
  NOTE_ASSIGNEES,
  addBookingNote,
  editBookingNote,
  listBookingNotes,
  setBookingTodoDone,
} from "../../services/domain/booking-note-service.js";
import {
  addGuestRequest,
  arrangeGuestRequest,
  listGuestRequests,
  withdrawGuestRequest,
} from "../../services/domain/guest-request-service.js";

/**
 * The booking's Notes and Guest requests tabs (2026-10-12) — both on every step, Inquiry to
 * Closed. All L1: writing down what the guest said and what they asked for is the desk's job.
 */
export const bookingNotesRouter = Router();

const actorOf = (req: { actor?: { actorId: string; level: any } }) => ({ actorId: req.actor!.actorId, level: req.actor!.level });

/* ---- notes and to-dos ---- */

bookingNotesRouter.get("/entries/:id/notes", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await listBookingNotes(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

const addNoteSchema = z.object({
  kind: z.enum(["NOTE", "TODO"]),
  text: z.string().trim().min(1).max(2000),
  assignee: z.enum(NOTE_ASSIGNEES).nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  dueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
});

bookingNotesRouter.post("/entries/:id/notes", requireActorLevel("L1"), validateBody(addNoteSchema), async (req, res, next) => {
  try {
    res.status(201).json(await addBookingNote(prisma, actorOf(req), req.params.id, req.body));
  } catch (e) {
    next(e);
  }
});

bookingNotesRouter.post(
  "/booking-notes/:noteId/edit",
  requireActorLevel("L1"),
  validateBody(z.object({ text: z.string().trim().min(1).max(2000) })),
  async (req, res, next) => {
    try {
      res.json(await editBookingNote(prisma, actorOf(req), req.params.noteId, req.body.text));
    } catch (e) {
      next(e);
    }
  },
);

bookingNotesRouter.post(
  "/booking-notes/:noteId/done",
  requireActorLevel("L1"),
  validateBody(z.object({ done: z.boolean() })),
  async (req, res, next) => {
    try {
      res.json(await setBookingTodoDone(prisma, actorOf(req), req.params.noteId, req.body.done));
    } catch (e) {
      next(e);
    }
  },
);

/* ---- guest requests ---- */

bookingNotesRouter.get("/entries/:id/guest-requests", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await listGuestRequests(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

const addRequestSchema = z.object({
  kind: z.string().trim().min(1).max(120),
  what: z.string().trim().min(1).max(1000),
  forDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  forTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
});

bookingNotesRouter.post("/entries/:id/guest-requests", requireActorLevel("L1"), validateBody(addRequestSchema), async (req, res, next) => {
  try {
    res.status(201).json(await addGuestRequest(prisma, actorOf(req), req.params.id, req.body));
  } catch (e) {
    next(e);
  }
});

bookingNotesRouter.post(
  "/guest-requests/:requestId/arranged",
  requireActorLevel("L1"),
  validateBody(z.object({ note: z.string().trim().max(1000).nullable().optional() })),
  async (req, res, next) => {
    try {
      res.json(await arrangeGuestRequest(prisma, actorOf(req), req.params.requestId, req.body.note ?? null));
    } catch (e) {
      next(e);
    }
  },
);

bookingNotesRouter.post(
  "/guest-requests/:requestId/withdraw",
  requireActorLevel("L1"),
  validateBody(z.object({ reason: z.string().trim().min(1).max(500) })),
  async (req, res, next) => {
    try {
      res.json(await withdrawGuestRequest(prisma, actorOf(req), req.params.requestId, req.body.reason));
    } catch (e) {
      next(e);
    }
  },
);

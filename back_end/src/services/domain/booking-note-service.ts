import type { ActorLevel, Prisma, PrismaClient } from "@prisma/client";
import { AuthorizationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import * as auditService from "../infrastructure/audit-service.js";
import { hotelLocalTimeOn } from "../../lib/stay-dates.js";

/**
 * Notes on a booking, and to-dos (2026-10-12, operator, after the boss's journey mockup — the
 * Notes tab on every step, Inquiry to Closed).
 *
 * A NOTE is what the desk wants kept: what the guest said, what was promised. It is locked once
 * written — an edit keeps every earlier wording in `priorTexts`, so nothing said is ever lost.
 * A TODO names who must do it (Desk · FOM · Housekeeping · Kitchen · Maintenance) and, if it
 * matters, by when; it is ticked off with who and when, and can be opened again.
 *
 * A note never changes the booking, so it may be written on any booking — a closed one too: the
 * guest who rings a week after check-out about a lost scarf is exactly what a note is for.
 */

type Actor = { actorId: string; level: ActorLevel };

export const NOTE_ASSIGNEES = ["DESK", "FOM", "HOUSEKEEPING", "KITCHEN", "MAINTENANCE"] as const;
export type NoteAssignee = (typeof NOTE_ASSIGNEES)[number];

type PriorText = { text: string; at: string; by: string };

const LEVEL_RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };

async function entryOf(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: { id: true, inquiryId: true, currentStage: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}

async function namesFor(prisma: PrismaClient, ids: Array<string | null | undefined>) {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map<string, string>();
  const staff = await prisma.staffUser.findMany({ where: { id: { in: wanted } }, select: { id: true, fullName: true } });
  return new Map(staff.map((s) => [s.id, s.fullName]));
}

export const NOTE_PAPER_KINDS = ["QUOTATION", "INVOICE"] as const;
export type NotePaperKind = (typeof NOTE_PAPER_KINDS)[number];

const INVOICE_WORD: Record<string, string> = { PROFORMA: "Proforma", FINAL: "Tax invoice", INTERIM: "Interim bill", ADVANCE: "Advance invoice" };

/** The booking's papers, by id, in the words the desk shows them ("QUO-… · v2", "Proforma INV-…"). */
async function paperLabels(prisma: PrismaClient, entryId: string) {
  const [quotes, invoices] = await Promise.all([
    prisma.quotation.findMany({
      where: { entryId },
      select: { id: true, referenceNumber: true, versionNumber: true, commercialTerms: true, createdAt: true, createdBy: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.invoice.findMany({
      where: { folio: { entryId } },
      select: { id: true, invoiceNumber: true, invoiceType: true, versionNumber: true },
    }),
  ]);
  const labels = new Map<string, { kind: NotePaperKind; label: string }>();
  for (const q of quotes) labels.set(q.id, { kind: "QUOTATION", label: `${q.referenceNumber}${q.versionNumber > 1 ? ` · v${q.versionNumber}` : ""}` });
  for (const i of invoices) {
    labels.set(i.id, {
      kind: "INVOICE",
      label: `${INVOICE_WORD[i.invoiceType] ?? "Invoice"} ${i.invoiceNumber ?? i.id}${i.versionNumber > 1 ? ` · v${i.versionNumber}` : ""}`,
    });
  }
  return { labels, quotes };
}

/** Every note and to-do on the booking, newest first, with the people named. */
export async function listBookingNotes(prisma: PrismaClient, entryId: string) {
  await entryOf(prisma, entryId);
  const rows = await prisma.bookingNote.findMany({ where: { entryId }, orderBy: { createdAt: "desc" } });
  const { labels, quotes } = await paperLabels(prisma, entryId);
  /**
   * Notes written INTO a quotation before 2026-10-12 — the old "Internal note" field stored them
   * in the quotation's own terms, where nothing showed them. They are read back here, each once:
   * a later version that carried the same words forward is the same note, so it is listed against
   * the first quotation that had it. Read-only — the quotation is the record.
   */
  const seenTermNotes = new Set<string>();
  const termNotes: Array<{ quotationId: string; label: string; text: string; createdAt: string; createdBy: string }> = [];
  for (const q of quotes) {
    const t = (q.commercialTerms as Record<string, unknown> | null)?.notes;
    const text = typeof t === "string" ? t.trim() : "";
    if (!text || seenTermNotes.has(text)) continue;
    seenTermNotes.add(text);
    termNotes.push({ quotationId: q.id, label: labels.get(q.id)?.label ?? q.referenceNumber, text, createdAt: q.createdAt.toISOString(), createdBy: q.createdBy });
  }
  const priorBy = rows.flatMap((r) => ((r.priorTexts as PriorText[] | null) ?? []).map((p) => p.by));
  const names = await namesFor(prisma, [...rows.flatMap((r) => [r.createdBy, r.editedBy, r.doneBy]), ...priorBy, ...termNotes.map((t) => t.createdBy)]);
  const name = (id: string | null) => (id ? names.get(id) ?? id : null);
  const now = Date.now();
  const items = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    text: r.text,
    assignee: r.assignee,
    dueAt: r.dueAt?.toISOString() ?? null,
    doneAt: r.doneAt?.toISOString() ?? null,
    doneBy: r.doneBy,
    doneByName: name(r.doneBy),
    // A to-do still open past its time — the desk is told so, not left to work it out.
    overdue: r.kind === "TODO" && !r.doneAt && !!r.dueAt && r.dueAt.getTime() < now,
    stageContext: r.stageContext,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
    createdByName: name(r.createdBy),
    editedAt: r.editedAt?.toISOString() ?? null,
    editedByName: name(r.editedBy),
    priorTexts: ((r.priorTexts as PriorText[] | null) ?? []).map((p) => ({ ...p, byName: name(p.by) })),
    // The paper it was written with, named as the desk shows it.
    paper: r.paperKind && r.paperId ? { kind: r.paperKind, id: r.paperId, label: labels.get(r.paperId)?.label ?? r.paperId } : null,
  }));
  return {
    items,
    quotationNotes: termNotes.map((t) => ({ ...t, createdByName: name(t.createdBy) })),
    counts: {
      notes: items.filter((i) => i.kind === "NOTE").length,
      openTodos: items.filter((i) => i.kind === "TODO" && !i.doneAt).length,
      overdueTodos: items.filter((i) => i.overdue).length,
    },
  };
}

export type AddBookingNoteInput = {
  kind: "NOTE" | "TODO";
  text: string;
  assignee?: NoteAssignee | null;
  /** An instant ("within the hour") … */
  dueAt?: string | null;
  /** … or the hotel's wall clock ("today 18:00"), never the desk machine's zone. */
  dueDate?: string | null;
  dueTime?: string | null;
  /** The paper the note goes with — the internal note typed when a quotation is sent. */
  paperKind?: NotePaperKind | null;
  paperId?: string | null;
};

export async function addBookingNote(prisma: PrismaClient, actor: Actor, entryId: string, input: AddBookingNoteInput) {
  const entry = await entryOf(prisma, entryId);
  const text = input.text.trim();
  if (!text) throw new ValidationError("Write the note first");
  if (input.kind === "TODO" && !input.assignee) throw new ValidationError("Say who the to-do is for");
  if (input.kind === "NOTE" && (input.assignee || input.dueAt || input.dueDate)) {
    throw new ValidationError("A note has no owner or time — tick To do to give it one");
  }
  if (input.dueAt && input.dueDate) throw new ValidationError("Give the time one way — an instant, or a day and time");
  if (!!input.dueDate !== !!input.dueTime) throw new ValidationError("A day needs its time, and a time its day");
  const dueAt = input.dueAt
    ? new Date(input.dueAt)
    : input.dueDate && input.dueTime
      ? hotelLocalTimeOn(new Date(`${input.dueDate}T00:00:00.000Z`), input.dueTime)
      : null;
  if (dueAt && Number.isNaN(dueAt.getTime())) throw new ValidationError("That time could not be read");
  if (!!input.paperKind !== !!input.paperId) throw new ValidationError("Name the paper by its kind and its number together");
  if (input.paperKind && input.paperId) {
    // The paper must be this booking's — a note filed against another booking's quotation would
    // show beside a paper the guest never had.
    const ours =
      input.paperKind === "QUOTATION"
        ? await prisma.quotation.count({ where: { id: input.paperId, entryId } })
        : await prisma.invoice.count({ where: { id: input.paperId, folio: { entryId } } });
    if (!ours) throw new ValidationError("That paper is not this booking's");
  }
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const note = await tx.bookingNote.create({
      data: {
        entryId,
        kind: input.kind,
        text,
        assignee: input.kind === "TODO" ? input.assignee ?? null : null,
        dueAt,
        stageContext: entry.currentStage,
        createdBy: actor.actorId,
        createdAt: now,
        paperKind: input.paperKind ?? null,
        paperId: input.paperId ?? null,
      },
    });
    await auditService.emit(tx as any, { actorId: actor.actorId, actorLevel: actor.level }, {
      eventType: input.kind === "TODO" ? "BOOKING_NOTE.TODO_ADDED" : "BOOKING_NOTE.ADDED",
      entityType: "Entry",
      entityId: entryId,
      operation: "CREATE",
      timestamp: now,
      inquiryId: entry.inquiryId,
      entryId,
      stageContext: entry.currentStage,
      // The words are the record — the History tab reads them from here.
      payload: {
        noteId: note.id,
        kind: input.kind,
        text,
        assignee: note.assignee,
        dueAt: note.dueAt?.toISOString() ?? null,
        paperKind: note.paperKind,
        paperId: note.paperId,
      },
    });
    return note;
  });
}

/**
 * Change a note's wording. The earlier wording is kept — a note is never silently rewritten.
 * The author may edit their own; the FOM and above may edit any.
 */
export async function editBookingNote(prisma: PrismaClient, actor: Actor, noteId: string, textIn: string) {
  const note = await prisma.bookingNote.findUnique({ where: { id: noteId }, include: { entry: { select: { inquiryId: true, currentStage: true } } } });
  if (!note) throw new NotFoundError("Note");
  if (note.createdBy !== actor.actorId && (LEVEL_RANK[actor.level] ?? 0) < 2) {
    throw new AuthorizationError("Only whoever wrote this note, or the FOM, can change it");
  }
  const text = textIn.trim();
  if (!text) throw new ValidationError("A note cannot be emptied — write what it should say");
  if (text === note.text) throw new ValidationError("That is what the note already says");
  const now = new Date();
  const prior = [...((note.priorTexts as PriorText[] | null) ?? []), { text: note.text, at: (note.editedAt ?? note.createdAt).toISOString(), by: note.editedBy ?? note.createdBy }];
  return prisma.$transaction(async (tx) => {
    const updated = await tx.bookingNote.update({
      where: { id: noteId },
      data: { text, editedAt: now, editedBy: actor.actorId, priorTexts: prior as unknown as Prisma.InputJsonValue },
    });
    await auditService.emit(tx as any, { actorId: actor.actorId, actorLevel: actor.level }, {
      eventType: "BOOKING_NOTE.EDITED",
      entityType: "Entry",
      entityId: note.entryId,
      operation: "UPDATE",
      timestamp: now,
      inquiryId: note.entry.inquiryId,
      entryId: note.entryId,
      stageContext: note.entry.currentStage,
      payload: { noteId, kind: note.kind, text, was: note.text },
    });
    return updated;
  });
}

/** Tick a to-do off — or open it again — with who and when. */
export async function setBookingTodoDone(prisma: PrismaClient, actor: Actor, noteId: string, done: boolean) {
  const note = await prisma.bookingNote.findUnique({ where: { id: noteId }, include: { entry: { select: { inquiryId: true, currentStage: true } } } });
  if (!note) throw new NotFoundError("Note");
  if (note.kind !== "TODO") throw new ValidationError("Only a to-do is ticked off");
  if (done && note.doneAt) throw new ValidationError("This to-do is already done");
  if (!done && !note.doneAt) throw new ValidationError("This to-do is still open");
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.bookingNote.update({
      where: { id: noteId },
      data: done ? { doneAt: now, doneBy: actor.actorId } : { doneAt: null, doneBy: null },
    });
    await auditService.emit(tx as any, { actorId: actor.actorId, actorLevel: actor.level }, {
      eventType: done ? "BOOKING_NOTE.TODO_DONE" : "BOOKING_NOTE.TODO_REOPENED",
      entityType: "Entry",
      entityId: note.entryId,
      operation: "UPDATE",
      timestamp: now,
      inquiryId: note.entry.inquiryId,
      entryId: note.entryId,
      stageContext: note.entry.currentStage,
      payload: { noteId, text: note.text, assignee: note.assignee },
    });
    return updated;
  });
}

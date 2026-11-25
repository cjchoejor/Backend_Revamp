/**
 * Correct the guest's name, phone and email from a booking (2026-11-25, operator: "in the right panel,
 * we need an option to change the guest name, number, email — make sure it's well audited").
 *
 * The guest's record is ONE record shared by every booking the guest has, which is why a booking could
 * only fill an empty field until now (`addGuestProfileContact`, 2026-10-12). This is the deliberate
 * correction of that record — a typo in the name, a number that changed — said openly:
 *
 * - **The record before the change is kept whole** (`EntityVersionSnapshot`, entity "GuestProfile"),
 *   restorable from the admin console's versions.
 * - **Every booking that shares the record is told**: `GUEST_PROFILE.DETAILS_CORRECTED` on this
 *   booking, with each field's old and new value, who, and the bookings that share it; and the same
 *   on each of those bookings still live, naming the booking it was changed on — so each History says
 *   it. The desk lists those bookings before the save.
 * - **What mirrors the guest follows**: on the live bookings of this guest, "who is arriving"
 *   (`Entry.contactPerson*`, which follows the guest — 2026-11-03) when it holds the old name or
 *   number, and the enquiry's caller when the caller is the same person (the old name, and the old
 *   number or email, or none). Listed on the trace.
 * - **Not changed**: papers already made — a stored PDF keeps what it printed; the next paper reads
 *   the record.
 * - Refused: a booking with no guest named, a sealed booking, a name left empty, a word in the name
 *   that reads as a desk note (it belongs in the Tag), a number or an email that does not read as one,
 *   and nothing changed.
 * - The same number or email on another guest's record is said back (`alsoOnFile`), never refused:
 *   a family, or an agency's number, may be shared.
 */
import type { PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { cleanPhone } from "../../lib/phone-numbers.js";
import { personFromName } from "../../lib/person-name.js";
import { looksLikeDeskNote } from "../../lib/desk-tag.js";
import { guestDisplayName } from "../../lib/guest-display-name.js";
import { captureSnapshotTx } from "../../lib/admin/entity-version-snapshot.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { findGuestsOnFile } from "./guest-profile-service.js";

type Level = "L1" | "L2" | "L3" | "L4";
type Change = { from: string | null; to: string | null };

const LIVE = ["ACTIVE", "PARKED"] as const;
const digits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");
const fold = (v: string | null | undefined) => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type GuestDetailsInput = { title?: string | null; name?: string | null; phone?: string | null; email?: string | null };

export async function correctGuestDetails(
  prisma: PrismaClient,
  entryId: string,
  actor: { actorId: string; actorLevel: Level },
  input: GuestDetailsInput,
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      status: true,
      currentStage: true,
      inquiryId: true,
      guestProfileId: true,
      guestProfile: { select: { id: true, title: true, firstName: true, lastName: true, phone: true, email: true } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  const g = entry.guestProfile;
  if (!g) throw new ValidationError("No guest is named on this booking yet — name them at Wrap up");

  // What the desk sent; a field left out keeps what is on the record.
  let title = g.title?.trim() || null;
  let firstName = g.firstName;
  let lastName = g.lastName;
  if (input.name !== undefined || input.title !== undefined) {
    const person = personFromName({ title: input.title !== undefined ? input.title : g.title, name: input.name !== undefined ? input.name : `${g.firstName} ${g.lastName}` });
    const note = (input.name ?? "").split(/\s+/).find((w) => w && looksLikeDeskNote(w));
    if (note) throw new ValidationError(`"${note}" reads as a note, not a name — put it in the Tag, so it stays off the papers`);
    if (!person.firstName.trim()) throw new ValidationError("The guest's name cannot be empty");
    title = input.title !== undefined ? input.title?.trim() || person.title || null : person.title ?? title;
    firstName = person.firstName.trim();
    lastName = person.lastName.trim();
  }
  const phone = input.phone !== undefined ? cleanPhone(input.phone, "The guest's phone") : g.phone;
  let email = g.email;
  if (input.email !== undefined) {
    email = input.email?.trim() || null;
    if (email && !EMAIL.test(email)) throw new ValidationError(`"${email}" does not read as an email address`);
  }

  const oldName = guestDisplayName(g);
  const newName = guestDisplayName({ title, firstName, lastName });
  const changes: Record<string, Change> = {};
  if (oldName !== newName) changes.name = { from: oldName || null, to: newName || null };
  if (digits(g.phone) !== digits(phone)) changes.phone = { from: g.phone ?? null, to: phone ?? null };
  if ((g.email ?? null) !== (email ?? null)) changes.email = { from: g.email ?? null, to: email ?? null };
  if (!Object.keys(changes).length) throw new ValidationError("Nothing has changed");

  // The bookings that share the record.
  const sharing = await prisma.entry.findMany({
    where: { guestProfileId: g.id },
    select: {
      id: true,
      status: true,
      inquiryId: true,
      contactPersonName: true,
      contactPersonPhone: true,
      contactPersonEmail: true,
      inquiry: { select: { id: true, callerTitle: true, callerFirstName: true, callerLastName: true, callerPhone: true, callerEmail: true } },
    },
  });
  const others = sharing.filter((e) => e.id !== entry.id);
  const live = sharing.filter((e) => (LIVE as readonly string[]).includes(String(e.status)));

  const now = new Date();
  const arrivingUpdated: string[] = [];
  const callerUpdated: string[] = [];
  await prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, {
      entityType: "GuestProfile",
      entityId: g.id,
      actorId: actor.actorId,
      changeNote: `Corrected from ${entry.id}: ${Object.keys(changes).join(", ")}`,
    });
    await tx.guestProfile.update({ where: { id: g.id }, data: { title, firstName, lastName, phone: phone ?? null, email: email ?? null } });

    // Who is arriving follows the guest where it holds the old details.
    for (const e of live) {
      const data: Record<string, string | null> = {};
      if (changes.name && e.contactPersonName && fold(e.contactPersonName) === fold(oldName)) data.contactPersonName = newName;
      if (changes.phone && e.contactPersonPhone && g.phone && digits(e.contactPersonPhone) === digits(g.phone)) data.contactPersonPhone = phone ?? null;
      if (changes.email && e.contactPersonEmail && g.email && fold(e.contactPersonEmail) === fold(g.email)) data.contactPersonEmail = email ?? null;
      if (Object.keys(data).length) {
        await tx.entry.update({ where: { id: e.id }, data });
        arrivingUpdated.push(e.id);
      }
    }
    // The caller, when the caller is this same person: the old name, and the old number or email (or none).
    const enquiries = new Map(live.filter((e) => e.inquiry).map((e) => [e.inquiry!.id, e.inquiry!]));
    for (const q of enquiries.values()) {
      const sameName = fold(`${q.callerFirstName ?? ""} ${q.callerLastName ?? ""}`) === fold(`${g.firstName} ${g.lastName}`);
      const sameReach =
        (!!q.callerPhone && !!g.phone && digits(q.callerPhone) === digits(g.phone)) ||
        (!!q.callerEmail && !!g.email && fold(q.callerEmail) === fold(g.email)) ||
        (!q.callerPhone && !q.callerEmail);
      if (!sameName || !sameReach) continue;
      const data: Record<string, string | null> = {};
      if (changes.name) {
        data.callerTitle = title;
        data.callerFirstName = firstName;
        data.callerLastName = lastName;
      }
      if (changes.phone && q.callerPhone && g.phone && digits(q.callerPhone) === digits(g.phone)) data.callerPhone = phone ?? null;
      if (changes.email && q.callerEmail && g.email && fold(q.callerEmail) === fold(g.email)) data.callerEmail = email ?? null;
      if (Object.keys(data).length) {
        await tx.inquiry.update({ where: { id: q.id }, data });
        callerUpdated.push(q.id);
      }
    }

    // Every booking that shares the record says so in its History.
    const payload = {
      guestProfileId: g.id,
      changes,
      changedOn: entry.id,
      sharedWith: others.map((o) => o.id),
      arrivingUpdated,
      callerUpdated,
    };
    const trace = (forEntry: { id: string; inquiryId: string | null }, via: "THIS_BOOKING" | "ANOTHER_BOOKING") =>
      tx.traceEvent.create({
        data: {
          eventType: "GUEST_PROFILE.DETAILS_CORRECTED",
          actorId: actor.actorId,
          actorLevel: actor.actorLevel,
          entityType: "GuestProfile",
          entityId: g.id,
          operation: "UPDATE",
          timestamp: now,
          stageContext: forEntry.id === entry.id ? entry.currentStage : null,
          inquiryId: forEntry.inquiryId,
          entryId: forEntry.id,
          payload: { ...payload, via },
          createdBy: actor.actorId,
        },
      });
    await trace({ id: entry.id, inquiryId: entry.inquiryId }, "THIS_BOOKING");
    for (const o of live) if (o.id !== entry.id) await trace({ id: o.id, inquiryId: o.inquiryId }, "ANOTHER_BOOKING");
  });

  // The same number or email on another guest's record — said, not refused.
  const alsoOnFile =
    changes.phone?.to || changes.email?.to
      ? (await findGuestsOnFile(prisma, { phone: changes.phone?.to ?? null, email: changes.email?.to ?? null, partial: false }))
          .filter((x) => x.id !== g.id)
          .map((x) => ({ id: x.id, name: guestDisplayName(x), matchedBy: x.matchedBy }))
      : [];

  return {
    guestProfileId: g.id,
    name: newName,
    phone: phone ?? null,
    email: email ?? null,
    changes,
    sharedWith: others.map((o) => ({ entryId: o.id, live: (LIVE as readonly string[]).includes(String(o.status)) })),
    arrivingUpdated,
    callerUpdated,
    alsoOnFile,
  };
}

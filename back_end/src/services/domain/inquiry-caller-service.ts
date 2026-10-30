import type { ActorLevel, PrismaClient } from "@prisma/client";
import { NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { findGuestsOnFile, sameGuestName } from "./guest-profile-service.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { recordDuplicateDetectionFlagIfPresent } from "../../policies/04-duplicate-detection/p12-duplicate-flag-create-on-inquiry.js";
import * as auditService from "../infrastructure/audit-service.js";
import { assertCallerReachable, callerColumns, normaliseCaller, validateInquiryParty, type CallerInput } from "./s1-inquiry-service.js";
import { resolveInquiryChannel } from "../../lib/inquiry-came-in-as.js";

/**
 * The caller and the guest staying (2026-10-12, operator, after the boss's journey mockup).
 *
 * The first section of an inquiry is the CALLER — whoever rang: the guest, an agency's person, a
 * company's assistant, a VIP's secretary. Their phone or email starts the inquiry; their name can
 * wait. The GUEST who is STAYING is named at Wrap up, once rooms are chosen: the caller by
 * default, or someone else. A booking cannot leave Inquiry without one (Policy 16).
 *
 * The caller lives on the enquiry, never on a guest record — an agency's person is not a guest of
 * the hotel, and a guest record made for them would surface as a "returning guest" forever.
 */

type Actor = { actorId: string; level: ActorLevel };

async function loadEntry(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      status: true,
      currentStage: true,
      inquiryId: true,
      guestProfileId: true,
      checkInDate: true,
      checkOutDate: true,
      inquiry: {
        select: {
          id: true,
          guestProfileId: true,
          sourceChannel: true,
          callerTitle: true,
          callerFirstName: true,
          callerLastName: true,
          callerPhone: true,
          callerEmail: true,
          callerOnWhatsApp: true,
          travelAgentId: true,
          corporateAccountId: true,
          _count: { select: { entries: true } },
        },
      },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}

/**
 * Fill in or correct the caller's details. Fields not sent keep what is on record; an empty
 * string clears one. The result must still reach someone (a phone or an email, not on an OTA).
 */
export async function updateEntryCaller(prisma: PrismaClient, actor: Actor, entryId: string, input: CallerInput) {
  const entry = await loadEntry(prisma, entryId);
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  const inq = entry.inquiry;
  const pick = <K extends keyof CallerInput>(k: K, current: CallerInput[K]) => (input[k] === undefined ? current : input[k]);
  const next = normaliseCaller({
    title: pick("title", inq.callerTitle),
    firstName: pick("firstName", inq.callerFirstName),
    lastName: pick("lastName", inq.callerLastName),
    phone: pick("phone", inq.callerPhone),
    email: pick("email", inq.callerEmail),
    onWhatsApp: pick("onWhatsApp", inq.callerOnWhatsApp),
  });
  assertCallerReachable(next, inq.sourceChannel);

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.inquiry.update({ where: { id: inq.id }, data: callerColumns(next) });
    const changed = (Object.keys(input) as Array<keyof CallerInput>).filter((k) => input[k] !== undefined);
    await auditService.emit(tx as any, { actorId: actor.actorId, actorLevel: actor.level }, {
      eventType: "INQUIRY.CALLER_UPDATED",
      entityType: "Inquiry",
      entityId: inq.id,
      operation: "UPDATE",
      timestamp: now,
      inquiryId: inq.id,
      entryId: entry.id,
      // Field names only — the values are on the record.
      payload: { fields: changed },
    });
    return {
      caller: {
        title: updated.callerTitle,
        firstName: updated.callerFirstName,
        lastName: updated.callerLastName,
        phone: updated.callerPhone,
        email: updated.callerEmail,
        onWhatsApp: updated.callerOnWhatsApp,
      },
    };
  });
}

/**
 * `keepNewName` — the desk was told the phone or email is on file under another name and chose to
 * keep the name typed (a new guest record). `arrivingIsGuest` — the guest named is the one arriving,
 * so on a direct booking "who is arriving" is filled from them (an agency's or a company's contact
 * person is never overwritten).
 */
type GuestNamingOptions = { keepNewName?: boolean; arrivingIsGuest?: boolean };

export type SetGuestInput =
  | ({ mode: "CALLER"; nationality?: string | null } & GuestNamingOptions)
  | ({ mode: "EXISTING"; guestProfileId: string; phone?: string | null; email?: string | null } & GuestNamingOptions)
  | ({
      mode: "NEW";
      title?: string | null;
      firstName: string;
      lastName: string;
      nationality?: string | null;
      phone?: string | null;
      email?: string | null;
    } & GuestNamingOptions);

/**
 * Name the guest who is staying: the caller (a guest record made from the caller's name and
 * contact), a guest already on file, or someone new. Inquiry only — once the booking moves on,
 * the quote, the bill and every paper carry this name. A guest already named can be replaced.
 *
 * The duplicate check (Policy 12) runs here, since this is when the guest becomes known: an
 * overlapping stay for the same guest on another enquiry is FLAGGED on this one, and the exit
 * gate then treats it as it treats a flag raised at intake.
 *
 * A guest record is never made twice for one person (2026-10-28, operator: "if the name is
 * different than the last entered name of the same phone number (case insensitive) ask if the user
 * wishes to keep the new name or the one on file, same for email"). Before a record is made from a
 * phone or an email already on file: the same name (case and spacing aside) is that guest — their
 * record is used, and only what it lacks is filled in; another name is refused
 * GUEST_ON_FILE_DIFFERENT_NAME with the guests on file, until the desk names one of them
 * (EXISTING) or says to keep the typed name (`keepNewName`).
 */
export async function setEntryGuest(prisma: PrismaClient, actor: Actor, entryId: string, input: SetGuestInput) {
  const entry = await loadEntry(prisma, entryId);
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  if (entry.currentStage !== "S1") {
    throw new ValidationError("The guest staying is named at Inquiry — this booking has moved on");
  }
  const inq = entry.inquiry;
  const t = (v: string | null | undefined) => v?.trim() || null;

  let existingId: string | null = null;
  let create: { title: string | null; firstName: string; lastName: string; nationality: string | null; phone: string | null; email: string | null } | null = null;
  // What a guest on file should gain from this naming — only fields it has empty.
  let fill: { title: string | null; nationality: string | null; phone: string | null; email: string | null } | null = null;
  let reusedOnFile = false;
  if (input.mode === "EXISTING") {
    const g = await prisma.guestProfile.findUnique({ where: { id: input.guestProfileId }, select: { id: true, isActive: true } });
    if (!g || !g.isActive) throw new ValidationError("That guest is not on file");
    existingId = g.id;
    const email = t(input.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError("The guest's email does not read as an email address");
    fill = { title: null, nationality: null, phone: t(input.phone), email };
  } else if (input.mode === "CALLER") {
    if (!inq.callerFirstName || !inq.callerLastName) {
      throw new ValidationError("Take the caller's first and last name first — the guest record is made from them");
    }
    // The caller's title comes with their name (2026-10-28 — it was left behind, so the papers
    // printed "pema lhaden wangchuk" for a caller taken as "Ms pema lhaden wangchuk").
    create = {
      title: inq.callerTitle?.trim() || null,
      firstName: inq.callerFirstName,
      lastName: inq.callerLastName,
      nationality: t(input.nationality),
      phone: inq.callerPhone,
      email: inq.callerEmail,
    };
  } else {
    const firstName = t(input.firstName);
    const lastName = t(input.lastName);
    if (!firstName || !lastName) throw new ValidationError("The guest's first and last name are needed");
    const email = t(input.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError("The guest's email does not read as an email address");
    // The title typed at Wrap up is kept (2026-10-28 — the request carried it and it was dropped).
    create = { title: t(input.title), firstName, lastName, nationality: t(input.nationality), phone: t(input.phone), email };
  }

  if (create && (create.phone || create.email)) {
    const typed = create;
    const onFile = await findGuestsOnFile(prisma, { phone: typed.phone, email: typed.email, partial: false });
    const same = onFile.find((g) => sameGuestName(g, typed));
    if (same) {
      existingId = same.id;
      fill = { title: typed.title, nationality: typed.nationality, phone: typed.phone, email: typed.email };
      create = null;
      reusedOnFile = true;
    } else if (onFile.length && !input.keepNewName) {
      const what = (g: (typeof onFile)[number]) =>
        g.matchedBy.length === 2 ? "phone and email" : g.matchedBy[0] === "PHONE" ? "phone" : "email";
      const named = (g: (typeof onFile)[number]) => [g.title, g.firstName, g.lastName].filter(Boolean).join(" ");
      throw new PolicyGateBlockedError(
        "GUEST_ON_FILE_DIFFERENT_NAME",
        `${onFile[0].matchedBy.length === 2 ? "This phone and email are" : `This ${what(onFile[0])} is`} on file for ${named(onFile[0])} — name them as the guest, or keep ${typed.firstName} ${typed.lastName} as a new guest`,
        {
          typed: { title: typed.title, firstName: typed.firstName, lastName: typed.lastName },
          matches: onFile.map((g) => ({
            id: g.id,
            title: g.title,
            firstName: g.firstName,
            lastName: g.lastName,
            phone: g.phone,
            email: g.email,
            matchedBy: g.matchedBy,
          })),
        },
      );
    }
  }

  const now = new Date();
  const outcome = await prisma.$transaction(async (tx) => {
    let guestProfileId = existingId;
    if (create) {
      const g = await tx.guestProfile.create({
        data: { ...create, clientTier: "STANDARD", createdBy: actor.actorId },
        select: { id: true },
      });
      guestProfileId = g.id;
      await auditService.emit(tx as any, { actorId: actor.actorId, actorLevel: actor.level }, {
        eventType: "GUEST_PROFILE.CREATED",
        entityType: "GuestProfile",
        entityId: g.id,
        operation: "CREATE",
        timestamp: now,
        payload: { guestProfileId: g.id, from: input.mode === "CALLER" ? "CALLER" : "WRAP_UP" },
      });
    }
    // A guest on file keeps what it holds; only the fields it has empty take what was typed. A
    // different phone or email is not written (the record is shared by every booking the guest has)
    // and is reported instead.
    const filled: string[] = [];
    const contactKept: string[] = [];
    if (fill && guestProfileId) {
      const cur = await tx.guestProfile.findUniqueOrThrow({
        where: { id: guestProfileId },
        select: { title: true, nationality: true, phone: true, email: true },
      });
      const data: Record<string, string> = {};
      const digits = (v: string | null) => (v ?? "").replace(/\D/g, "");
      for (const k of ["title", "nationality", "phone", "email"] as const) {
        const v = fill[k];
        if (!v) continue;
        const now0 = cur[k];
        if (!now0) {
          data[k] = v;
          filled.push(k);
        } else if (k === "phone" && digits(now0).slice(-8) !== digits(v).slice(-8)) contactKept.push(k);
        else if (k === "email" && now0.trim().toLowerCase() !== v.toLowerCase()) contactKept.push(k);
      }
      if (filled.length) {
        await tx.guestProfile.update({ where: { id: guestProfileId }, data });
        await auditService.emit(tx as any, { actorId: actor.actorId, actorLevel: actor.level }, {
          eventType: "GUEST_PROFILE.CONTACT_FILLED",
          entityType: "GuestProfile",
          entityId: guestProfileId,
          operation: "UPDATE",
          timestamp: now,
          payload: { guestProfileId, fields: filled, from: "WRAP_UP", entryId: entry.id },
        });
      }
    }

    // The guest named is the one arriving: on a direct booking "who is arriving" is them. An
    // agency's or a company's contact person stays — that is the party's own person.
    let arrivingSet = false;
    const partyBooking = !!(inq.travelAgentId || inq.corporateAccountId);
    if (input.arrivingIsGuest && !partyBooking && guestProfileId) {
      const g = await tx.guestProfile.findUniqueOrThrow({
        where: { id: guestProfileId },
        select: { firstName: true, lastName: true, phone: true },
      });
      await tx.entry.update({
        where: { id: entry.id },
        data: {
          guestProfileId,
          contactPersonName: `${g.firstName} ${g.lastName}`.trim(),
          ...(g.phone ? { contactPersonPhone: g.phone } : {}),
        },
      });
      arrivingSet = true;
    } else {
      await tx.entry.update({ where: { id: entry.id }, data: { guestProfileId } });
    }
    // The enquiry carries the guest too. It follows this booking when it had none, or when it was
    // this booking's earlier guest — a return stay on the same enquiry keeps whatever it names.
    const followInquiry = !inq.guestProfileId || inq.guestProfileId === entry.guestProfileId || inq._count.entries === 1;
    if (followInquiry) await tx.inquiry.update({ where: { id: inq.id }, data: { guestProfileId } });

    let duplicate: { conflictingInquiryId: string; conflictingEntryId: string } | null = null;
    if (entry.checkInDate && entry.checkOutDate) {
      const clash = await tx.entry.findFirst({
        where: {
          guestProfileId,
          id: { not: entry.id },
          inquiryId: { not: inq.id },
          status: { in: ["ACTIVE", "PARKED"] },
          checkInDate: { lt: entry.checkOutDate },
          checkOutDate: { gt: entry.checkInDate },
        },
        select: { id: true, inquiryId: true },
      });
      if (clash) {
        duplicate = { conflictingInquiryId: clash.inquiryId, conflictingEntryId: clash.id };
        await recordDuplicateDetectionFlagIfPresent(tx as any, {
          inquiryId: inq.id,
          actorId: actor.actorId,
          conflictingInquiryId: clash.inquiryId,
        });
      }
    }

    await auditService.emit(tx as any, { actorId: actor.actorId, actorLevel: actor.level }, {
      eventType: "ENTRY.GUEST_NAMED",
      entityType: "Entry",
      entityId: entry.id,
      operation: "UPDATE",
      timestamp: now,
      entryId: entry.id,
      inquiryId: inq.id,
      payload: {
        mode: input.mode,
        guestProfileId,
        previousGuestProfileId: entry.guestProfileId,
        duplicate,
        reusedOnFile,
        keptNewName: !!input.keepNewName,
        filled,
        contactKept,
        arrivingSet,
      },
    });
    return { guestProfileId: guestProfileId!, duplicate, reusedOnFile, filled, contactKept, arrivingSet };
  });
  return outcome;
}

/* ------------------------------------------------------------------ who is asking */

export type SourceInput = {
  cameInAs?: string | null;
  sourceChannel?: string | null;
  travelAgentId?: string | null;
  corporateAccountId?: string | null;
  ratePackageId?: string | null;
  corporateClientRef?: string | null;
  corporateCoordinator?: string | null;
};

/**
 * Change who is asking — how the booking came in, the agency or company, its package and the
 * company's reference (2026-10-12, operator: "when I click edit it doesn't allow me to edit … the
 * came in as section"). Inquiry only: the party prices the stay, and from Negotiation on that price
 * is on a quotation. A trip's other stays share the enquiry, so every one of them must still be at
 * Inquiry (or ended) — a change here would re-price a stay that has already moved on.
 *
 * The custodian is left as assigned; the caller must still be reachable under the new channel.
 */
export async function updateEntrySource(prisma: PrismaClient, actor: Actor, entryId: string, input: SourceInput) {
  const entry = await loadEntry(prisma, entryId);
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  if (entry.currentStage !== "S1") {
    throw new ValidationError("Who is asking is changed at Inquiry — this booking has moved on (a re-entry to Inquiry opens it again)");
  }
  const others = await prisma.entry.findMany({
    where: { inquiryId: entry.inquiryId, id: { not: entry.id }, currentStage: { not: "S1" }, status: { in: ["ACTIVE", "PARKED"] } },
    select: { id: true },
  });
  if (others.length) {
    throw new ValidationError(`Another stay on this enquiry has moved past Inquiry (${others.map((o) => o.id).join(", ")}) — who is asking cannot change under it`);
  }
  const channel = resolveInquiryChannel({ cameInAs: input.cameInAs ?? undefined, sourceChannel: input.sourceChannel ?? undefined });
  const party = await validateInquiryParty(prisma, input);
  const inq = entry.inquiry;
  // The caller must still be reachable: leaving OTA with no phone or email is refused.
  assertCallerReachable(
    normaliseCaller({
      title: inq.callerTitle,
      firstName: inq.callerFirstName,
      lastName: inq.callerLastName,
      phone: inq.callerPhone,
      email: inq.callerEmail,
      onWhatsApp: inq.callerOnWhatsApp,
    }),
    channel.sourceChannel,
  );
  const corporate = !!party.corporateAccountId || channel.sourceChannel === "CORPORATE";
  const t = (v: string | null | undefined) => v?.trim() || null;
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.inquiry.update({
      where: { id: inq.id },
      data: {
        sourceChannel: channel.sourceChannel,
        cameInAs: channel.cameInAs,
        travelAgentId: party.travelAgentId,
        corporateAccountId: party.corporateAccountId,
        ratePackageId: party.ratePackageId,
        // A company's reference belongs to a company booking; it goes when the company does.
        corporateClientRef: corporate ? t(input.corporateClientRef) : null,
        corporateCoordinator: corporate ? t(input.corporateCoordinator) : null,
        ...(corporate && t(input.corporateClientRef) ? { corporateContextCapturedAt: now, corporateContextCapturedBy: actor.actorId } : {}),
      } as any,
    });
    await tx.entry.updateMany({
      where: { inquiryId: inq.id, currentStage: "S1" },
      data: { otaSource: channel.sourceChannel === "OTA" },
    });
    await auditService.emit(tx as any, { actorId: actor.actorId, actorLevel: actor.level }, {
      eventType: "INQUIRY.SOURCE_CHANGED",
      entityType: "Inquiry",
      entityId: inq.id,
      operation: "UPDATE",
      timestamp: now,
      inquiryId: inq.id,
      entryId: entry.id,
      payload: {
        from: { sourceChannel: inq.sourceChannel },
        to: { sourceChannel: updated.sourceChannel, cameInAs: updated.cameInAs, travelAgentId: updated.travelAgentId, corporateAccountId: updated.corporateAccountId, ratePackageId: updated.ratePackageId },
      },
    });
    return { sourceChannel: updated.sourceChannel, cameInAs: updated.cameInAs, travelAgentId: updated.travelAgentId, corporateAccountId: updated.corporateAccountId, ratePackageId: updated.ratePackageId };
  });
}

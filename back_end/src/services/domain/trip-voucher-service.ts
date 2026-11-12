import { cancellationWordsForStays } from "../../lib/cancellation-policy.js";
import { CommunicationChannel, Stage, type PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { resolveBillQuotation } from "../../lib/operative-quotation.js";
import { guestDisplayName } from "../../lib/guest-display-name.js";
import { resolveSendTo } from "../../lib/send-to.js";
import { cleanPhone } from "../../lib/phone-numbers.js";
import { formatDocDate, formatDocDateLocal } from "../infrastructure/pdf-templates/legphel-document-format.js";
import type { LegphelQuotationLine } from "../infrastructure/pdf-templates/legphel-quotation-template.js";
import { loadHotelProfileForRender } from "../../lib/pdf-render-context.js";
import type { NightsMode } from "../../lib/room-nights-for-entry.js";
import { renderHtmlToPdf } from "../infrastructure/pdf-render-service.js";
import { mastheadFromHotelProfile } from "../infrastructure/pdf-templates/legphel-document-shell.js";
import { renderLegphelTripVoucherHtml } from "../infrastructure/pdf-templates/legphel-trip-voucher-template.js";
import { renderReservationConfirmationEmail } from "../infrastructure/stage-email-templates.js";
import { dispatchStageEmailBestEffort } from "../infrastructure/stage-email-helpers.js";
import { quotationPaperPrices } from "./quotation-pdf-service.js";
import { recordCommunicationAcknowledgement } from "./communication-acknowledgement-service.js";
import { decideHeldDocument, sendHeldVoucherWithTrip } from "./held-document-service.js";
import { tripStayDates, type TripStayDates } from "./trip-paper-prices.js";
import { retireTripPaperIfStaysChanged, saveTripPaperVersion, sameMembers, SYSTEM_ACTOR, tripOfEntry, type Actor, type TripPaperMaker } from "./trip-paper-service.js";
import { paperNumber } from "../../lib/document-numbers.js";
import { loadEmailContact } from "../infrastructure/hotel-email-identity.js";

/**
 * A TRIP'S CONFIRMATION VOUCHER (2026-11-09, operator: "do the same for proforma and reserve and
 * confirmation voucher"). Each stay keeps its own voucher; once every stay is reserved the trip has
 * one made of them, with its own number. Sending it marks each stay's held voucher sent (one email,
 * the trip's), and the guest's answer to it is recorded on each stay's. It prints no prices.
 */

export type TripVoucherMember = {
  entryId: string;
  stayNo: number;
  paperId: string;
  number: string;
  versionNumber: number;
  state: string;
  total: string;
  checkIn: string | null;
  checkOut: string | null;
};

/** The voucher's time: reserved, and not yet in the house. */
const WORKING_STAGES: Stage[] = [Stage.S4, Stage.S5];

const ymd = (d: Date | null | undefined) => d?.toISOString().slice(0, 10) ?? null;

/** Each live stay of the trip with the reservation of its current pass. */
async function readStays(prisma: PrismaClient, inquiryId: string) {
  const entries = await prisma.entry.findMany({
    where: { inquiryId, status: { in: ["ACTIVE", "PARKED"] } },
    orderBy: [{ checkInDate: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      currentStage: true,
      checkInDate: true,
      checkOutDate: true,
      segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { id: true } },
      reservation: { select: { id: true, segmentId: true, confirmationVoucherNumber: true, frozenCheckInDate: true, frozenCheckOutDate: true } },
    },
  });
  const held = await prisma.heldDocument.findMany({
    where: { entryId: { in: entries.map((e) => e.id) }, kind: "CONFIRMATION_VOUCHER" },
    orderBy: { heldAt: "desc" },
    select: { entryId: true, documentId: true, decision: true },
  });
  return entries.map((e, i) => {
    const res = e.reservation && e.reservation.segmentId === e.segments[0]?.id ? e.reservation : null;
    const rows = res ? held.filter((h) => h.documentId === res.id) : [];
    return {
      stayNo: i + 1,
      entry: e,
      reservation: res,
      held: rows.some((h) => h.decision == null),
      decision: rows.find((h) => h.decision && h.decision !== "SUPERSEDED")?.decision ?? null,
      member:
        res && res.confirmationVoucherNumber
          ? ({
              entryId: e.id,
              stayNo: i + 1,
              paperId: res.id,
              number: res.confirmationVoucherNumber,
              versionNumber: 1,
              state: "RESERVED",
              total: "0.00",
              checkIn: ymd(res.frozenCheckInDate),
              checkOut: ymd(res.frozenCheckOutDate),
            } as TripVoucherMember)
          : null,
    };
  });
}
type TripStay = Awaited<ReturnType<typeof readStays>>[number];

function standing(stays: TripStay[]): string | null {
  if (stays.length < 2) return "This trip has one stay — its own voucher is the paper.";
  for (const s of stays) {
    if (!s.member) return `Stay ${s.stayNo} (${s.entry.id}) is not reserved yet — the trip's voucher is made once every stay is.`;
    if (!WORKING_STAGES.includes(s.entry.currentStage as Stage)) return `Stay ${s.stayNo} (${s.entry.id}) is past Arrival — each stay goes on with its own voucher.`;
  }
  return null;
}

export async function describeTripVoucher(prisma: PrismaClient, entryId: string) {
  const inquiryId = await tripOfEntry(prisma, entryId);
  const stays = await readStays(prisma, inquiryId);
  const members = stays.map((s) => s.member).filter((m): m is TripVoucherMember => !!m);
  const papers = await prisma.tripPaper.findMany({ where: { inquiryId, kind: "VOUCHER" }, orderBy: { versionNumber: "desc" } });
  const current = papers.find((p) => p.state === "LIVE") ?? null;
  const currentMembers = (current?.members ?? []) as unknown as TripVoucherMember[];
  const reason = standing(stays);
  return {
    inquiryId,
    stays: stays.map((s) => ({
      stayNo: s.stayNo,
      entryId: s.entry.id,
      stage: s.entry.currentStage,
      checkIn: ymd(s.entry.checkInDate),
      checkOut: ymd(s.entry.checkOutDate),
      voucher: s.member ? { reservationId: s.member.paperId, number: s.member.number, held: s.held, decision: s.decision } : null,
    })),
    canMake: reason == null,
    reason,
    current: current
      ? {
          id: current.id,
          number: paperNumber(current.documentNumber, current.versionNumber),
          versionNumber: current.versionNumber,
          sentAt: current.sentAt?.toISOString() ?? null,
          sentTo: current.sentTo,
          sentChannel: current.sentChannel,
          notSent: current.sentChannel === "NOT_SENT",
          answeredAt: current.answeredAt?.toISOString() ?? null,
          upToDate: sameMembers(currentMembers, members),
          members: currentMembers,
        }
      : null,
    versions: papers.map((p) => ({
      id: p.id,
      number: paperNumber(p.documentNumber, p.versionNumber),
      state: p.state,
      createdAt: p.createdAt.toISOString(),
      sentAt: p.sentAt?.toISOString() ?? null,
    })),
  };
}

export async function makeTripVoucher(prisma: PrismaClient, entryId: string, actor: TripPaperMaker) {
  const inquiryId = await tripOfEntry(prisma, entryId);
  const stays = await readStays(prisma, inquiryId);
  const reason = standing(stays);
  if (reason) throw new ValidationError(reason);
  const members = stays.map((s) => s.member!);
  return saveTripPaperVersion(prisma, {
    inquiryId,
    kind: "VOUCHER",
    counter: "VOUCHER",
    members,
    validUntil: null,
    actor,
    traceMembers: members.map((m) => ({ entryId: m.entryId, reservationId: m.paperId, number: m.number })),
  });
}

/** The trip's voucher, made by itself as soon as every stay is reserved. Never stops a read. */
export async function keepTripVoucherInStep(prisma: PrismaClient, entryId: string) {
  try {
    const inquiryId = await tripOfEntry(prisma, entryId);
    const stays = await readStays(prisma, inquiryId);
    if (standing(stays)) {
      await retireTripPaperIfStaysChanged(prisma, inquiryId, "VOUCHER", stays.map((s) => s.entry.id));
      return;
    }
    await makeTripVoucher(prisma, entryId, SYSTEM_ACTOR);
  } catch (e) {
    console.error("[trip-voucher] could not be kept in step", entryId, e);
  }
}

async function loadPaper(prisma: PrismaClient, tripPaperId: string) {
  const paper = await prisma.tripPaper.findUnique({ where: { id: tripPaperId } });
  if (!paper || paper.kind !== "VOUCHER") throw new NotFoundError("Trip voucher");
  return paper;
}

async function liveAndCurrent(prisma: PrismaClient, tripPaperId: string) {
  const paper = await loadPaper(prisma, tripPaperId);
  if (paper.state !== "LIVE") throw new ValidationError("A newer version of the trip's voucher replaced this one — use that one.");
  const stays = await readStays(prisma, paper.inquiryId);
  const members = stays.map((s) => s.member).filter((m): m is TripVoucherMember => !!m);
  if (!sameMembers(paper.members as unknown as TripVoucherMember[], members)) {
    throw new ValidationError("A stay's voucher changed since the trip's was made — open it again and it will be made afresh.");
  }
  return { paper, stays, members };
}

/** The trip's voucher as HTML — each stay's rooms, no prices, then the stays together. Pure read. */
export async function renderTripVoucherHtml(prisma: PrismaClient, tripPaperId: string, opts?: { nightsMode?: NightsMode }) {
  const paper = await loadPaper(prisma, tripPaperId);
  const members = paper.members as unknown as TripVoucherMember[];
  const inquiry = await prisma.inquiry.findUnique({
    where: { id: paper.inquiryId },
    select: {
      guestProfile: { select: { title: true, firstName: true, lastName: true } },
      travelAgent: { select: { displayName: true } },
      corporateAccount: { select: { displayName: true } },
    },
  });
  const hotel = await loadHotelProfileForRender(prisma);
  const stays: TripStayDates[] = [];
  const lines: LegphelQuotationLine[] = [];
  let datesShown = false;
  for (const m of members) {
    const res = await prisma.reservation.findUnique({ where: { id: m.paperId }, select: { segmentId: true } });
    const quotes = await prisma.quotation.findMany({
      where: { entryId: m.entryId },
      select: { id: true, segmentId: true, state: true, versionNumber: true, createdAt: true },
    });
    const q = res ? resolveBillQuotation(quotes, res.segmentId) : null;
    const prices = q ? await quotationPaperPrices(prisma, q.id, { nightsMode: opts?.nightsMode }).catch(() => null) : null;
    stays.push(tripStayDates(m.stayNo, m.checkIn ? new Date(`${m.checkIn}T00:00:00Z`) : null, m.checkOut ? new Date(`${m.checkOut}T00:00:00Z`) : null, formatDocDate));
    lines.push(...(prices?.priceBlock.lines ?? []));
    datesShown = datesShown || !!prices?.priceBlock.datesShown;
  }
  const number = paperNumber(paper.documentNumber, paper.versionNumber);
  const html = renderLegphelTripVoucherHtml({
    masthead: mastheadFromHotelProfile(hotel),
    voucherNo: number,
    bookingRef: paper.inquiryId,
    date: formatDocDateLocal(paper.createdAt),
    guest: guestDisplayName(inquiry?.guestProfile) || "Guest",
    bookedBy: inquiry?.travelAgent?.displayName ?? inquiry?.corporateAccount?.displayName ?? null,
    stays,
    lines,
    datesShown,
    closingNote: "Inclusions per plan · Wi-Fi · parking. Early check-in and late check-out subject to availability. Please carry photo ID for all adult guests.",
  });
  return { html, number, paper };
}

export async function renderTripVoucherPdf(prisma: PrismaClient, tripPaperId: string, opts?: { nightsMode?: NightsMode }) {
  const { html, number } = await renderTripVoucherHtml(prisma, tripPaperId, opts);
  return { bytes: await renderHtmlToPdf(html, { fitToPage: true }), filename: `${number.replace(" · ", "-")}-trip-confirmation-voucher.pdf` };
}

/**
 * Send the trip's voucher: one email with its paper (or recorded as sent on WhatsApp), and each
 * stay's voucher still waiting for the desk marked sent with it — not emailed on its own.
 */
export async function sendTripVoucher(
  prisma: PrismaClient,
  tripPaperId: string,
  actor: Actor,
  input: { channel: "EMAIL" | "WHATSAPP"; to?: string | null; nightsEach?: boolean },
) {
  const { paper, stays, members } = await liveAndCurrent(prisma, tripPaperId);
  const reason = standing(stays);
  if (reason) throw new ValidationError(reason);
  const number = paperNumber(paper.documentNumber, paper.versionNumber);
  const sendTo = await resolveSendTo(prisma, members[0].entryId);
  let to = input.to?.trim() || (input.channel === "EMAIL" ? sendTo.email : sendTo.phone) || null;
  if (input.channel === "EMAIL") {
    if (!to) throw new ValidationError("No email address — type the address it goes to");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new ValidationError("That is not an email address.");
  } else {
    to = cleanPhone(to, "The number it went to");
  }
  for (const m of members) {
    await sendHeldVoucherWithTrip(prisma, {
      entryId: m.entryId,
      reservationId: m.paperId,
      actor,
      channel: input.channel === "EMAIL" ? CommunicationChannel.EMAIL : CommunicationChannel.WHATSAPP,
      sentTo: to,
      tripNumber: number,
    });
  }
  const now = new Date();
  await prisma.tripPaper.update({ where: { id: paper.id }, data: { sentAt: now, sentTo: to, sentChannel: input.channel } });
  for (const m of members) {
    await prisma.traceEvent.create({
      data: {
        eventType: "TRIP_PAPER.SENT",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "TripPaper",
        entityId: paper.id,
        operation: "UPDATE",
        timestamp: now,
        inquiryId: paper.inquiryId,
        entryId: m.entryId,
        payload: { tripPaperId: paper.id, kind: "VOUCHER", number, channel: input.channel, to },
        createdBy: actor.actorId,
      },
    });
  }
  if (input.channel === "EMAIL" && to) await emailTripVoucher(prisma, paper.id, members, to, number, input.nightsEach === true);
  return { sentTo: to, channel: input.channel, number };
}

async function emailTripVoucher(prisma: PrismaClient, tripPaperId: string, members: TripVoucherMember[], to: string, number: string, nightsEach: boolean) {
  const entries = await prisma.entry.findMany({
    where: { id: { in: members.map((m) => m.entryId) } },
    select: { id: true, inquiryId: true, guestCount: true, guestProfile: { select: { title: true, firstName: true, lastName: true } }, reservation: { select: { frozenCancellationTerms: true } } },
  });
  const first = entries.find((e) => e.id === members[0].entryId);
  if (!first) return;
  const ins = members.map((m) => m.checkIn).filter(Boolean).sort();
  const outs = members.map((m) => m.checkOut).filter(Boolean).sort();
  const content = renderReservationConfirmationEmail({
    contact: await loadEmailContact(prisma),
    guestDisplayName: guestDisplayName(first.guestProfile) || "Guest",
    reservationReadableId: number,
    checkInDate: new Date(`${ins[0]}T00:00:00Z`),
    checkOutDate: new Date(`${outs[outs.length - 1]}T00:00:00Z`),
    guestCount: Math.max(1, ...entries.map((e) => e.guestCount ?? 1)),
    // Each stay's own cancellation policy; one list when they read the same (2026-11-10).
    cancellationPolicy: await cancellationWordsForStays(
      prisma,
      members.map((m) => ({ stayNo: m.stayNo, terms: entries.find((e) => e.id === m.entryId)?.reservation?.frozenCancellationTerms ?? null })),
    ),
  });
  try {
    const pdf = await renderTripVoucherPdf(prisma, tripPaperId, { nightsMode: nightsEach ? "EACH" : "SHORT" });
    content.attachments = [{ filename: pdf.filename, content: pdf.bytes, contentType: "application/pdf" }];
  } catch {
    // The email still goes with its words; the desk can send the paper again.
  }
  await dispatchStageEmailBestEffort(
    { prisma, entryId: first.id, actorId: "SYSTEM", inquiryId: first.inquiryId, guestEmail: to, stage: Stage.S4, eventTypePrefix: "TRIP_VOUCHER_EMAIL" },
    content,
  );
}

/** The desk chose not to send it: each stay's voucher still waiting is marked not sent. */
export async function markTripVoucherNotSent(prisma: PrismaClient, tripPaperId: string, actor: Actor, input: { note?: string | null }) {
  const { paper, members } = await liveAndCurrent(prisma, tripPaperId);
  const number = paperNumber(paper.documentNumber, paper.versionNumber);
  for (const m of members) {
    const held = await prisma.heldDocument.findFirst({
      where: { entryId: m.entryId, kind: "CONFIRMATION_VOUCHER", documentId: m.paperId, decision: null },
      select: { id: true },
    });
    if (held) await decideHeldDocument(prisma, held.id, actor, { action: "NONE", note: input.note?.trim() || `The trip's voucher ${number} was not sent` });
  }
  await prisma.tripPaper.update({ where: { id: paper.id }, data: { sentChannel: "NOT_SENT" } });
  return { number };
}

/** The guest's answer to the trip's voucher, recorded on each stay's voucher it was sent with. */
export async function answerTripVoucher(
  prisma: PrismaClient,
  tripPaperId: string,
  actor: Actor,
  input: { method: "WRITTEN" | "VERBAL"; verbatimNote?: string | null },
) {
  const paper = await loadPaper(prisma, tripPaperId);
  if (!paper.sentAt) throw new ValidationError("The trip's voucher has not been sent — there is no answer to record.");
  if (input.method === "VERBAL" && !input.verbatimNote?.trim()) throw new ValidationError("Write down what the guest said.");
  const members = paper.members as unknown as TripVoucherMember[];
  let recorded = 0;
  for (const m of members) {
    const comms = await prisma.communicationRecord.findMany({
      where: { entryId: m.entryId, commType: "CONFIRMATION_VOUCHER", payload: { path: ["reservationId"], equals: m.paperId } },
      orderBy: { createdAt: "desc" },
      select: { id: true, acknowledgementStatus: true, sendStatus: true },
    });
    const waiting = comms.find((c) => c.sendStatus === "DISPATCHED" && (c.acknowledgementStatus === "PENDING" || c.acknowledgementStatus === "TIMED_OUT"));
    if (!waiting) continue;
    await recordCommunicationAcknowledgement(prisma, waiting.id, actor, { method: input.method, verbatimNote: input.verbatimNote ?? null });
    recorded++;
  }
  await prisma.tripPaper.update({ where: { id: paper.id }, data: { answeredAt: new Date(), answeredBy: actor.actorId } });
  return { recorded };
}

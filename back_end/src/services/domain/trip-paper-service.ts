import { Prisma, Stage, type ActorLevel, type PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { allocateReadableId } from "../../lib/readable-id.js";
import { paperNumber } from "../../lib/document-numbers.js";
import { resolveOperativeQuotation } from "../../lib/operative-quotation.js";
import { guestDisplayName } from "../../lib/guest-display-name.js";
import { resolveSendTo } from "../../lib/send-to.js";
import { sumMoney, toDecimal } from "../../lib/money.js";
import { loadHotelProfileForRender } from "../../lib/pdf-render-context.js";
import type { NightsMode } from "../../lib/room-nights-for-entry.js";
import { renderHtmlToPdf } from "../infrastructure/pdf-render-service.js";
import { mastheadFromHotelProfile } from "../infrastructure/pdf-templates/legphel-document-shell.js";
import { formatDocDate, formatDocDateLocal } from "../infrastructure/pdf-templates/legphel-document-format.js";
import { priceRowsNote } from "../infrastructure/pdf-templates/legphel-quotation-template.js";
import { renderLegphelTripQuotationHtml } from "../infrastructure/pdf-templates/legphel-trip-quotation-template.js";
import { stayBreakdownFromTerms, type StayChargeBreakdown } from "../infrastructure/compute-stay-charges.js";
import { renderQuotationEmail } from "../infrastructure/stage-email-templates.js";
import { dispatchStageEmailBestEffort } from "../infrastructure/stage-email-helpers.js";
import { quotationPaperPrices } from "./quotation-pdf-service.js";
import { combineTripPriceBlocks, tripStayDates, type TripPricePart, type TripStayDates } from "./trip-paper-prices.js";
import { sendQuotation } from "./s2-quotation-service.js";
import { recordCommunicationAcknowledgement } from "./communication-acknowledgement-service.js";

/**
 * A TRIP'S QUOTATION (2026-11-07, operator: "lets keep their numbers and add version numbers").
 *
 * A trip — an enquiry with more than one stay — keeps each stay's own quotation, and has one of
 * its own that is made of them: QUO-0003 holds QUO-0001 v1 and QUO-0002 v1; when stay 1 changes
 * (QUO-0001 v2) the trip's is made again as QUO-0003 v2. Its total is only the stays' totals added
 * up — it has no price of its own. It is the paper the guest receives by default: sending it marks
 * each stay's quotation sent (one email, the trip's), and the guest's answer to it is recorded on
 * each stay's. Made and sent while the stays are at Negotiation or Set up; read at any time.
 */

export type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };

/** Who makes a trip's paper when nobody pressed anything (2026-11-09): it is kept in step by itself. */
export const SYSTEM_ACTOR: TripPaperMaker = { actorId: "SYSTEM", actorLevel: "SYSTEM" as ActorLevel };

export type TripPaperMaker = { actorId: string; actorLevel: ActorLevel };

export type TripMember = {
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

const WORKING_STAGES: Stage[] = [Stage.S2, Stage.S3];

export async function tripOfEntry(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { inquiryId: true } });
  if (!entry) throw new NotFoundError("Entry");
  return entry.inquiryId;
}

/** Each live stay of the trip with its quotation in force, in the order the stays come. */
async function readMembers(prisma: PrismaClient, inquiryId: string) {
  const entries = await prisma.entry.findMany({
    where: { inquiryId, status: { in: ["ACTIVE", "PARKED"] } },
    orderBy: [{ checkInDate: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      currentStage: true,
      checkInDate: true,
      checkOutDate: true,
      segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { id: true } },
      quotations: {
        select: { id: true, segmentId: true, state: true, versionNumber: true, createdAt: true, referenceNumber: true, totalAmount: true, validUntil: true, commercialTerms: true },
      },
    },
  });
  const stays = await Promise.all(
    entries.map(async (e, i) => {
      const q = e.segments[0] ? resolveOperativeQuotation(e.quotations, e.segments[0].id) : null;
      return {
        entry: e,
        quote: q,
        member: q
          ? ({
              entryId: e.id,
              stayNo: i + 1,
              paperId: q.id,
              number: q.referenceNumber,
              versionNumber: q.versionNumber,
              state: q.state,
              total: toDecimal(q.totalAmount).toFixed(2),
              checkIn: e.checkInDate?.toISOString().slice(0, 10) ?? null,
              checkOut: e.checkOutDate?.toISOString().slice(0, 10) ?? null,
            } as TripMember)
          : null,
      };
    }),
  );
  return stays;
}

/** Whether the trip's quotation can be made now, and why not in words. */
function standing(stays: Awaited<ReturnType<typeof readMembers>>) {
  if (stays.length < 2) return { canMake: false, reason: "This trip has one stay — its own quotation is the paper." };
  const missing = stays.find((s) => !s.member);
  if (missing) return { canMake: false, reason: `Stay ${stays.indexOf(missing) + 1} (${missing.entry.id}) has no quotation yet — price it at Negotiation first.` };
  const past = stays.find((s) => !WORKING_STAGES.includes(s.entry.currentStage as Stage));
  if (past) return { canMake: false, reason: `Stay ${stays.indexOf(past) + 1} (${past.entry.id}) is past Set up — each stay goes on with its own papers from Reserve.` };
  return { canMake: true, reason: null as string | null };
}

export const sameMembers = (a: Array<{ entryId: string; paperId: string }>, b: Array<{ entryId: string; paperId: string }>) =>
  a.length === b.length && a.every((m, i) => m.entryId === b[i].entryId && m.paperId === b[i].paperId);

/** The trip's quotation as it stands: the stays, the latest made, whether it still matches them. */
export async function describeTripQuotation(prisma: PrismaClient, entryId: string) {
  const inquiryId = await tripOfEntry(prisma, entryId);
  const stays = await readMembers(prisma, inquiryId);
  const members = stays.map((s) => s.member).filter((m): m is TripMember => !!m);
  const papers = await prisma.tripPaper.findMany({ where: { inquiryId, kind: "QUOTATION" }, orderBy: { versionNumber: "desc" } });
  const current = papers.find((p) => p.state === "LIVE") ?? null;
  const currentMembers = (current?.members ?? []) as unknown as TripMember[];
  const s = standing(stays);
  return {
    inquiryId,
    stays: stays.map((x, i) => ({
      stayNo: i + 1,
      entryId: x.entry.id,
      stage: x.entry.currentStage,
      checkIn: x.entry.checkInDate?.toISOString().slice(0, 10) ?? null,
      checkOut: x.entry.checkOutDate?.toISOString().slice(0, 10) ?? null,
      quotation: x.member
        ? { id: x.member.paperId, number: paperNumber(x.member.number, x.member.versionNumber), state: x.member.state, total: x.member.total }
        : null,
    })),
    total: members.length ? sumMoney(members.map((m) => m.total)).toFixed(2) : null,
    canMake: s.canMake,
    reason: s.reason,
    current: current
      ? {
          id: current.id,
          number: paperNumber(current.documentNumber, current.versionNumber),
          versionNumber: current.versionNumber,
          total: toDecimal(current.totalAmount).toFixed(2),
          validUntil: current.validUntil?.toISOString() ?? null,
          sentAt: current.sentAt?.toISOString() ?? null,
          sentTo: current.sentTo,
          sentChannel: current.sentChannel,
          answeredAt: current.answeredAt?.toISOString() ?? null,
          upToDate: sameMembers(currentMembers, members),
          members: currentMembers.map((m) => ({ ...m, number: paperNumber(m.number, m.versionNumber) })),
        }
      : null,
    versions: papers.map((p) => ({
      id: p.id,
      number: paperNumber(p.documentNumber, p.versionNumber),
      state: p.state,
      total: toDecimal(p.totalAmount).toFixed(2),
      createdAt: p.createdAt.toISOString(),
      sentAt: p.sentAt?.toISOString() ?? null,
    })),
  };
}

/**
 * Make the trip's quotation from the stays' quotations in force — the first time with a number of
 * its own from the quotation counter, after that the next version of the same number. Nothing is
 * made when the latest already holds exactly these stays' papers.
 */
export async function makeTripQuotation(prisma: PrismaClient, entryId: string, actor: TripPaperMaker) {
  const inquiryId = await tripOfEntry(prisma, entryId);
  const stays = await readMembers(prisma, inquiryId);
  const s = standing(stays);
  if (!s.canMake) throw new ValidationError(s.reason ?? "The trip's quotation cannot be made now.");
  const members = stays.map((x) => x.member!) as TripMember[];
  const validUntils = stays.map((x) => x.quote?.validUntil).filter((d): d is Date => !!d);
  const validUntil = validUntils.length ? new Date(Math.min(...validUntils.map((d) => d.getTime()))) : null;
  return saveTripPaperVersion(prisma, {
    inquiryId,
    kind: "QUOTATION",
    counter: "QUOTATION",
    members,
    validUntil,
    actor,
    traceMembers: members.map((x) => ({ entryId: x.entryId, quotationId: x.paperId, number: paperNumber(x.number, x.versionNumber), total: x.total })),
  });
}

/**
 * The trip's quotation made by itself (2026-11-09, operator: "it should generated the trips quotation
 * automatically, even if the configurations are done separetly"). Run on every read of it, so it
 * follows whatever made a stay's quotation change: a save at Negotiation, a room change, a date move.
 * It has no figures of its own and makes nothing while it already holds these stays' papers. It
 * never stops the read; a trip that cannot have one yet says why on the card.
 */
export async function keepTripQuotationInStep(prisma: PrismaClient, entryId: string) {
  try {
    const inquiryId = await tripOfEntry(prisma, entryId);
    if (!standing(await readMembers(prisma, inquiryId)).canMake) return;
    await makeTripQuotation(prisma, entryId, SYSTEM_ACTOR);
  } catch (e) {
    console.error("[trip-quotation] could not be kept in step", entryId, e);
  }
}

/**
 * One version of a trip's paper (2026-11-07): nothing new while the latest in force holds exactly
 * these stays' papers; otherwise the next version of the trip's number (a new number from the
 * counter the first time), the earlier one marked replaced. Its total is only the stays' totals.
 */
export async function saveTripPaperVersion(
  prisma: PrismaClient,
  input: {
    inquiryId: string;
    kind: "QUOTATION" | "PROFORMA" | "VOUCHER";
    counter: "QUOTATION" | "INVOICE" | "VOUCHER";
    members: Array<{ entryId: string; paperId: string; total: string }>;
    validUntil: Date | null;
    actor: TripPaperMaker;
    traceMembers: unknown[];
  },
) {
  const { inquiryId, kind, members, actor } = input;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", `trip-paper:${inquiryId}:${kind}`);
    const latest = await tx.tripPaper.findFirst({ where: { inquiryId, kind }, orderBy: { versionNumber: "desc" } });
    if (latest?.state === "LIVE" && sameMembers(latest.members as unknown as TripMember[], members)) return { made: false, paper: latest };
    const now = new Date();
    const number = latest?.documentNumber ?? (await allocateReadableId(tx, input.counter, now));
    const versionNumber = (latest?.versionNumber ?? 0) + 1;
    await tx.tripPaper.updateMany({ where: { inquiryId, kind, state: "LIVE" }, data: { state: "SUPERSEDED", supersededAt: now } });
    const paper = await tx.tripPaper.create({
      data: {
        id: versionNumber > 1 ? `${number}-v${versionNumber}` : number,
        inquiryId,
        kind,
        documentNumber: number,
        versionNumber,
        members: members as unknown as Prisma.InputJsonValue,
        totalAmount: sumMoney(members.map((m) => m.total)),
        validUntil: input.validUntil,
        createdBy: actor.actorId,
      },
    });
    for (const m of members) {
      await tx.traceEvent.create({
        data: {
          eventType: "TRIP_PAPER.MADE",
          actorId: actor.actorId,
          actorLevel: actor.actorLevel,
          entityType: "TripPaper",
          entityId: paper.id,
          operation: "CREATE",
          timestamp: now,
          inquiryId,
          entryId: m.entryId,
          payload: { tripPaperId: paper.id, kind, number: paperNumber(number, versionNumber), members: input.traceMembers as Prisma.InputJsonValue, total: paper.totalAmount.toFixed(2) },
          createdBy: actor.actorId,
        },
      });
    }
    return { made: true, paper };
  });
}

/** The trip's quotation as HTML — each stay's own rows and totals, then the trip's. Pure read. */
export async function renderTripQuotationHtml(
  prisma: PrismaClient,
  tripPaperId: string,
  opts?: { hidePrices?: boolean; nightsMode?: NightsMode },
) {
  const paper = await prisma.tripPaper.findUnique({ where: { id: tripPaperId } });
  if (!paper || paper.kind !== "QUOTATION") throw new NotFoundError("Trip quotation");
  const members = paper.members as unknown as TripMember[];
  const inquiry = await prisma.inquiry.findUnique({
    where: { id: paper.inquiryId },
    select: {
      id: true,
      guestProfile: { select: { title: true, firstName: true, lastName: true } },
      travelAgent: { select: { displayName: true } },
      corporateAccount: { select: { displayName: true } },
    },
  });
  const hotel = await loadHotelProfileForRender(prisma);
  const parts: TripPricePart[] = [];
  const stays: TripStayDates[] = [];
  let rowsAreNet = true;
  for (const m of members) {
    const prices = await quotationPaperPrices(prisma, m.paperId, { nightsMode: opts?.nightsMode });
    parts.push({ stayNo: m.stayNo, block: prices.priceBlock, figures: prices.figures });
    rowsAreNet = rowsAreNet && prices.rowsAreNet;
    stays.push(tripStayDates(m.stayNo, m.checkIn ? new Date(`${m.checkIn}T00:00:00Z`) : null, m.checkOut ? new Date(`${m.checkOut}T00:00:00Z`) : null, formatDocDate));
  }
  const to =
    inquiry?.travelAgent?.displayName ?? inquiry?.corporateAccount?.displayName ?? (guestDisplayName(inquiry?.guestProfile) || "Guest");
  const html = renderLegphelTripQuotationHtml({
    masthead: mastheadFromHotelProfile(hotel),
    quotationNo: paperNumber(paper.documentNumber, paper.versionNumber),
    bookingRef: paper.inquiryId,
    date: formatDocDateLocal(paper.createdAt),
    validityStrip: paper.validUntil
      ? `Valid until ${formatDocDateLocal(paper.validUntil)} · Not a booking confirmation`
      : "Not a booking confirmation",
    to,
    stays,
    prices: combineTripPriceBlocks(parts, { hidePrices: opts?.hidePrices }),
    closingNote: opts?.hidePrices
      ? "Prices are not shown on this copy — the rates, taxes and total for these stays are on the priced quotation under the same number. Subject to availability at confirmation."
      : `${priceRowsNote(rowsAreNet)}Subject to availability at confirmation. A proforma invoice with advance terms follows on acceptance.`,
  });
  return { html, number: paperNumber(paper.documentNumber, paper.versionNumber), paper };
}

export async function renderTripQuotationPdf(prisma: PrismaClient, tripPaperId: string, opts?: { hidePrices?: boolean; nightsMode?: NightsMode }) {
  const { html, number } = await renderTripQuotationHtml(prisma, tripPaperId, opts);
  return { bytes: await renderHtmlToPdf(html, { fitToPage: true }), filename: `${number.replace(" · ", "-")}-trip-quotation.pdf` };
}

async function liveAndCurrent(prisma: PrismaClient, tripPaperId: string) {
  const paper = await prisma.tripPaper.findUnique({ where: { id: tripPaperId } });
  if (!paper || paper.kind !== "QUOTATION") throw new NotFoundError("Trip quotation");
  if (paper.state !== "LIVE") throw new ValidationError("A newer version of the trip's quotation replaced this one — use that one.");
  const stays = await readMembers(prisma, paper.inquiryId);
  const members = stays.map((s) => s.member).filter((m): m is TripMember => !!m);
  if (!sameMembers(paper.members as unknown as TripMember[], members)) {
    throw new ValidationError("A stay's quotation changed since the trip's was made — make the trip's quotation again first.");
  }
  return { paper, members };
}

/**
 * Send the trip's quotation: one email with its paper (or recorded as sent on WhatsApp), and each
 * stay's quotation still a draft marked sent with it — not emailed on its own.
 */
export async function sendTripQuotation(
  prisma: PrismaClient,
  tripPaperId: string,
  actor: Actor,
  input: { channel: "EMAIL" | "WHATSAPP"; to?: string | null; nightsEach?: boolean },
) {
  const { paper, members } = await liveAndCurrent(prisma, tripPaperId);
  const number = paperNumber(paper.documentNumber, paper.versionNumber);
  const typed = input.to?.trim() || null;
  const sendTo = await resolveSendTo(prisma, members[0].entryId);
  const to = typed ?? (input.channel === "EMAIL" ? sendTo.email : sendTo.phone);
  if (input.channel === "EMAIL" && to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new ValidationError("That is not an email address.");
  for (const m of members) {
    const q = await prisma.quotation.findUnique({ where: { id: m.paperId }, select: { state: true } });
    if (q?.state === "DRAFT") {
      await sendQuotation(prisma, m.paperId, actor.actorId, {
        channel: input.channel,
        sentTo: to ?? undefined,
        recipientAddress: to ?? undefined,
        viaTripPaper: { id: paper.id, number },
      });
    }
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
        payload: { tripPaperId: paper.id, number, channel: input.channel, to },
        createdBy: actor.actorId,
      },
    });
  }
  if (input.channel === "EMAIL" && to) await emailTripQuotation(prisma, paper.id, members, to, number, input.nightsEach === true);
  return { sentTo: to, channel: input.channel, number };
}

async function emailTripQuotation(prisma: PrismaClient, tripPaperId: string, members: TripMember[], to: string, number: string, nightsEach: boolean) {
  const first = await prisma.entry.findUnique({ where: { id: members[0].entryId }, select: { id: true, inquiryId: true, guestCount: true } });
  if (!first) return;
  const quotes = await prisma.quotation.findMany({ where: { id: { in: members.map((m) => m.paperId) } }, select: { commercialTerms: true, validUntil: true, currency: true } });
  const parts = quotes.map((q) => stayBreakdownFromTerms(q.commercialTerms)).filter((b): b is StayChargeBreakdown => !!b);
  const sum = (k: keyof StayChargeBreakdown) => Number(sumMoney(parts.map((p) => p[k])).toFixed(2));
  const breakdown: StayChargeBreakdown = {
    subTotal: sum("subTotal"),
    serviceChargeRate: parts[0]?.serviceChargeRate ?? 0,
    serviceCharge: sum("serviceCharge"),
    gstRate: parts[0]?.gstRate ?? 0,
    gst: sum("gst"),
    total: Number(sumMoney(members.map((m) => m.total)).toFixed(2)),
  };
  const ins = members.map((m) => m.checkIn).filter(Boolean).sort();
  const outs = members.map((m) => m.checkOut).filter(Boolean).sort();
  const validUntils = quotes.map((q) => q.validUntil).filter((d): d is Date => !!d);
  const recipient = await resolveSendTo(prisma, first.id);
  const content = renderQuotationEmail({
    guestDisplayName: recipient.party ?? "Guest",
    inquiryReadableId: first.inquiryId,
    quotationRef: number,
    checkInDate: new Date(`${ins[0]}T00:00:00Z`),
    checkOutDate: new Date(`${outs[outs.length - 1]}T00:00:00Z`),
    guestCount: first.guestCount ?? 1,
    nightlyRate: null,
    currency: quotes[0]?.currency ?? "BTN",
    breakdown,
    validUntil: validUntils.length ? new Date(Math.min(...validUntils.map((d) => d.getTime()))) : new Date(),
    ratePlanName: null,
  });
  try {
    const pdf = await renderTripQuotationPdf(prisma, tripPaperId, { nightsMode: nightsEach ? "EACH" : "SHORT" });
    content.attachments = [{ filename: pdf.filename, content: pdf.bytes, contentType: "application/pdf" }];
  } catch {
    // The email still goes with its words; the desk can send the paper again.
  }
  await dispatchStageEmailBestEffort(
    { prisma, entryId: first.id, actorId: "SYSTEM", inquiryId: first.inquiryId, guestEmail: to, stage: Stage.S2, eventTypePrefix: "TRIP_QUOTATION_EMAIL" },
    content,
  );
}

/** The guest's answer to the trip's quotation, recorded on each stay's quotation it was sent with. */
export async function answerTripQuotation(
  prisma: PrismaClient,
  tripPaperId: string,
  actor: Actor,
  input: { method: "WRITTEN" | "VERBAL"; verbatimNote?: string | null },
) {
  const paper = await prisma.tripPaper.findUnique({ where: { id: tripPaperId } });
  if (!paper || paper.kind !== "QUOTATION") throw new NotFoundError("Trip quotation");
  if (!paper.sentAt) throw new ValidationError("The trip's quotation has not been sent — there is no answer to record.");
  if (input.method === "VERBAL" && !input.verbatimNote?.trim()) throw new ValidationError("Write down what the guest said.");
  const members = paper.members as unknown as TripMember[];
  let recorded = 0;
  for (const m of members) {
    const q = await prisma.quotation.findUnique({ where: { id: m.paperId }, select: { communicationRecordId: true } });
    if (!q?.communicationRecordId) continue;
    const comm = await prisma.communicationRecord.findUnique({ where: { id: q.communicationRecordId }, select: { acknowledgementStatus: true } });
    if (comm?.acknowledgementStatus !== "PENDING" && comm?.acknowledgementStatus !== "TIMED_OUT") continue;
    await recordCommunicationAcknowledgement(prisma, q.communicationRecordId, actor, { method: input.method, verbatimNote: input.verbatimNote ?? null });
    recorded++;
  }
  await prisma.tripPaper.update({ where: { id: paper.id }, data: { answeredAt: new Date(), answeredBy: actor.actorId } });
  return { recorded };
}

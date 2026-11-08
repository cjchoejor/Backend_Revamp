import { Prisma, Stage, type PrismaClient } from "@prisma/client";
import { AppError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { paperNumber, printedProformaNumber } from "../../lib/document-numbers.js";
import { guestDisplayName } from "../../lib/guest-display-name.js";
import { resolveSendTo } from "../../lib/send-to.js";
import { maxZeroSub, sumMoney, toDecimal } from "../../lib/money.js";
import { enforceEarlierAdvanceAnswered } from "../../lib/refund-money.js";
import { formatMoney, loadHotelProfileForRender } from "../../lib/pdf-render-context.js";
import type { NightsMode } from "../../lib/room-nights-for-entry.js";
import { renderHtmlToPdf } from "../infrastructure/pdf-render-service.js";
import { mastheadFromHotelProfile, primaryContactNumber } from "../infrastructure/pdf-templates/legphel-document-shell.js";
import { formatDocDate, formatDocDateLocal, formatDocDateTimeLocal, formatStayLines } from "../infrastructure/pdf-templates/legphel-document-format.js";
import { renderLegphelTripProformaHtml } from "../infrastructure/pdf-templates/legphel-trip-proforma-template.js";
import type { StayChargeBreakdown } from "../infrastructure/compute-stay-charges.js";
import { renderProformaInvoiceEmail } from "../infrastructure/stage-email-templates.js";
import { dispatchStageEmailBestEffort } from "../infrastructure/stage-email-helpers.js";
import { proformaEmailFigures, proformaPaperFigures } from "./invoice-pdf-service.js";
import { dispatchInvoice } from "./s9-service.js";
import { afterPaymentRecorded, recordPaymentTx } from "./s3-folio-service.js";
import { evaluateAdvancePaymentCondition } from "./s3-payment-service.js";
import { buildEntryBillingSummary } from "./entry-billing-summary-service.js";
import { recordCommunicationAcknowledgement } from "./communication-acknowledgement-service.js";
import { saveTripPaperVersion, sameMembers, SYSTEM_ACTOR, tripOfEntry, type Actor, type TripPaperMaker } from "./trip-paper-service.js";

/**
 * A TRIP'S PROFORMA (2026-11-07, operator: each stay keeps its own proforma, the trip has one of its
 * own; "i think we need B, but also the option of c as well").
 *
 * Made of the stays' own proformas, as the trip's quotation is made of their quotations: each
 * stay's rows, total and advance as its own proforma prints them, then the trip's — only their
 * sums. Sending it sends each stay's proforma with it (one email, the trip's); the guest's answer
 * is recorded on each stay's. ⚠️ Money: a payment for the trip is shared between the stays' own
 * bills — by default the FIRST STAY'S ADVANCE FIRST, then the next stay's, and anything beyond the
 * advances to the stays in the same order up to what each still costs (way B); or as the desk
 * types it (way C). Every share is written through the stay's own payment checks, all of them in
 * one transaction: all land, or none.
 */

export type TripProformaMember = {
  entryId: string;
  stayNo: number;
  paperId: string;
  number: string;
  versionNumber: number;
  state: string;
  total: string;
  advanceAsked: string | null;
  checkIn: string | null;
  checkOut: string | null;
};

const ymd = (d: Date | null | undefined) => d?.toISOString().slice(0, 10) ?? null;
const d2 = (n: number | Prisma.Decimal) => toDecimal(n).toFixed(2);

/** Each live stay of the trip with its proforma of this pass and that proforma's own figures. */
async function readStays(prisma: PrismaClient, inquiryId: string) {
  const entries = await prisma.entry.findMany({
    where: { inquiryId, status: { in: ["ACTIVE", "PARKED"] } },
    orderBy: [{ checkInDate: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      currentStage: true,
      checkInDate: true,
      checkOutDate: true,
      segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { startedAt: true } },
      folio: {
        select: {
          id: true,
          invoices: {
            where: { invoiceType: "PROFORMA", state: { not: "SUPERSEDED" } },
            orderBy: [{ versionNumber: "desc" }, { createdAt: "desc" }],
            select: { id: true, documentNumber: true, versionNumber: true, state: true, createdAt: true, lapsedAt: true, validUntil: true, dispatchedAt: true },
          },
        },
      },
    },
  });
  return Promise.all(
    entries.map(async (e, i) => {
      const since = e.segments[0]?.startedAt ?? null;
      const inv = (e.folio?.invoices ?? []).find((x) => !since || x.createdAt.getTime() >= since.getTime()) ?? null;
      const fig = inv ? await proformaPaperFigures(prisma, inv.id) : null;
      const total = fig ? toDecimal(fig.total) : null;
      const received = fig ? toDecimal(fig.advanceReceived) : null;
      return {
        stayNo: i + 1,
        entry: e,
        folioId: e.folio?.id ?? null,
        invoice: inv,
        figures: fig,
        /** What this stay's advance still asks. */
        dueNow: fig ? toDecimal(fig.advanceDueNow) : null,
        /** What this stay can still take: its total less what it holds. */
        canTake: total && received ? maxZeroSub(total, received) : null,
        member: inv && fig
          ? ({
              entryId: e.id,
              stayNo: i + 1,
              paperId: inv.id,
              number: inv.documentNumber ?? inv.id,
              versionNumber: inv.versionNumber,
              state: inv.state,
              total: d2(fig.total),
              advanceAsked: fig.requiredAdvance != null ? d2(fig.requiredAdvance) : null,
              checkIn: ymd(e.checkInDate),
              checkOut: ymd(e.checkOutDate),
            } as TripProformaMember)
          : null,
      };
    }),
  );
}
type TripStay = Awaited<ReturnType<typeof readStays>>[number];

/** Whether the trip's proforma can be made or sent now, and why not in words. */
function standing(stays: TripStay[]) {
  if (stays.length < 2) return "This trip has one stay — its own proforma is the paper.";
  for (const s of stays) {
    const stage = s.entry.currentStage;
    if (stage === Stage.S1 || stage === Stage.S2) return `Stay ${s.stayNo} (${s.entry.id}) is not set up yet — bring it to Set up first.`;
    if (stage !== Stage.S3) return `Stay ${s.stayNo} (${s.entry.id}) is past Set up — each stay goes on with its own papers from Reserve.`;
    if (!s.invoice) return `Stay ${s.stayNo} (${s.entry.id}) has no proforma yet — set who pays and the advance on its Set up first.`;
    if (s.invoice.lapsedAt) return `Stay ${s.stayNo}'s proforma ran out — make it again on its Set up first.`;
  }
  return null;
}

const sum = (xs: Array<Prisma.Decimal | null>) => sumMoney(xs.filter((x): x is Prisma.Decimal => !!x));

/** The trip's proforma as it stands: the stays, their figures, the latest made, whether it still matches. */
export async function describeTripProforma(prisma: PrismaClient, entryId: string) {
  const inquiryId = await tripOfEntry(prisma, entryId);
  const stays = await readStays(prisma, inquiryId);
  const members = stays.map((s) => s.member).filter((m): m is TripProformaMember => !!m);
  const papers = await prisma.tripPaper.findMany({ where: { inquiryId, kind: "PROFORMA" }, orderBy: { versionNumber: "desc" } });
  const current = papers.find((p) => p.state === "LIVE") ?? null;
  const currentMembers = (current?.members ?? []) as unknown as TripProformaMember[];
  const reason = standing(stays);
  const asked = stays.filter((s) => s.figures?.requiredAdvance != null);
  return {
    inquiryId,
    stays: stays.map((s) => ({
      stayNo: s.stayNo,
      entryId: s.entry.id,
      stage: s.entry.currentStage,
      checkIn: ymd(s.entry.checkInDate),
      checkOut: ymd(s.entry.checkOutDate),
      proforma:
        s.invoice && s.figures
          ? {
              id: s.invoice.id,
              number: s.figures.invoiceRef,
              sent: !!s.invoice.dispatchedAt,
              lapsed: !!s.invoice.lapsedAt,
              total: d2(s.figures.total),
              advanceAsked: s.figures.requiredAdvance != null ? d2(s.figures.requiredAdvance) : null,
              received: d2(s.figures.advanceReceived),
              dueNow: d2(s.figures.advanceDueNow),
            }
          : null,
    })),
    total: members.length ? sumMoney(members.map((m) => m.total)).toFixed(2) : null,
    advanceAsked: asked.length ? sum(asked.map((s) => toDecimal(s.figures!.requiredAdvance!))).toFixed(2) : null,
    received: sum(stays.map((s) => (s.figures ? toDecimal(s.figures.advanceReceived) : null))).toFixed(2),
    dueNow: asked.length ? sum(stays.map((s) => s.dueNow)).toFixed(2) : null,
    canMake: reason == null,
    reason,
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

/** Make the trip's proforma from the stays' own proformas of this pass. */
export async function makeTripProforma(prisma: PrismaClient, entryId: string, actor: TripPaperMaker) {
  const inquiryId = await tripOfEntry(prisma, entryId);
  const stays = await readStays(prisma, inquiryId);
  const reason = standing(stays);
  if (reason) throw new ValidationError(reason);
  const members = stays.map((s) => s.member!);
  const validUntils = stays.map((s) => s.invoice?.validUntil).filter((d): d is Date => !!d);
  return saveTripPaperVersion(prisma, {
    inquiryId,
    kind: "PROFORMA",
    counter: "INVOICE",
    members,
    validUntil: validUntils.length ? new Date(Math.min(...validUntils.map((d) => d.getTime()))) : null,
    actor,
    traceMembers: members.map((m) => ({ entryId: m.entryId, invoiceId: m.paperId, number: paperNumber(m.number, m.versionNumber), total: m.total, advanceAsked: m.advanceAsked })),
  });
}

/** The trip's proforma, made by itself on every read, as the trip's quotation is (2026-11-09). */
export async function keepTripProformaInStep(prisma: PrismaClient, entryId: string) {
  try {
    const inquiryId = await tripOfEntry(prisma, entryId);
    if (standing(await readStays(prisma, inquiryId))) return;
    await makeTripProforma(prisma, entryId, SYSTEM_ACTOR);
  } catch (e) {
    console.error("[trip-proforma] could not be kept in step", entryId, e);
  }
}

async function loadPaper(prisma: PrismaClient, tripPaperId: string) {
  const paper = await prisma.tripPaper.findUnique({ where: { id: tripPaperId } });
  if (!paper || paper.kind !== "PROFORMA") throw new NotFoundError("Trip proforma");
  return paper;
}

/** In force, and still made of the stays' proformas as they stand. */
async function liveAndCurrent(prisma: PrismaClient, tripPaperId: string) {
  const paper = await loadPaper(prisma, tripPaperId);
  if (paper.state !== "LIVE") throw new ValidationError("A newer version of the trip's proforma replaced this one — use that one.");
  const stays = await readStays(prisma, paper.inquiryId);
  const members = stays.map((s) => s.member).filter((m): m is TripProformaMember => !!m);
  if (!sameMembers(paper.members as unknown as TripProformaMember[], members)) {
    throw new ValidationError("A stay's proforma changed since the trip's was made — make the trip's proforma again first.");
  }
  return { paper, stays, members };
}

/** The trip's proforma as HTML — each stay as its own proforma prints it, then the trip's sums. Pure read. */
export async function renderTripProformaHtml(prisma: PrismaClient, tripPaperId: string, opts?: { nightsMode?: NightsMode }) {
  const paper = await loadPaper(prisma, tripPaperId);
  const members = paper.members as unknown as TripProformaMember[];
  const inquiry = await prisma.inquiry.findUnique({
    where: { id: paper.inquiryId },
    select: {
      guestProfile: { select: { title: true, firstName: true, lastName: true } },
      travelAgent: { select: { displayName: true } },
      corporateAccount: { select: { displayName: true } },
    },
  });
  const hotel = await loadHotelProfileForRender(prisma);
  const stays = [];
  const received: Prisma.Decimal[] = [];
  const due: Prisma.Decimal[] = [];
  const balance: Prisma.Decimal[] = [];
  const deadlines: Date[] = [];
  let anyAsked = false;
  for (const m of members) {
    const f = await proformaPaperFigures(prisma, m.paperId, { nightsMode: opts?.nightsMode });
    const ci = m.checkIn ? new Date(`${m.checkIn}T00:00:00Z`) : null;
    const co = m.checkOut ? new Date(`${m.checkOut}T00:00:00Z`) : null;
    const nights = ci && co ? Math.round((co.getTime() - ci.getTime()) / 86_400_000) : null;
    const advanceRows: Array<{ label: string; value: string }> = [];
    if (f.advancePlanLabel) advanceRows.push({ label: "Payment plan", value: f.advancePlanLabel });
    if (f.requiredAdvance != null) advanceRows.push({ label: `Advance asked${f.advanceDueQualifier ? ` ${f.advanceDueQualifier}` : ""}`, value: formatMoney(f.requiredAdvance) });
    if (f.advanceReceived > 0) advanceRows.push({ label: `Advance received${f.paymentCount > 1 ? ` (${f.paymentCount} payments)` : ""}`, value: formatMoney(f.advanceReceived) });
    if (f.requiredAdvance != null) advanceRows.push({ label: "Advance due now", value: formatMoney(f.advanceDueNow) });
    if (f.requiredAdvance != null) anyAsked = true;
    if (f.advanceDueNow > 0 && f.advanceDeadline) deadlines.push(f.advanceDeadline);
    received.push(toDecimal(f.advanceReceived));
    due.push(toDecimal(f.advanceDueNow));
    balance.push(toDecimal(f.balanceAtCheckout));
    stays.push({
      heading: `Stay ${m.stayNo} · ${f.invoiceRef}`,
      stay: formatStayLines(ci, co, nights),
      block: f.prices,
      advanceRows,
      row: {
        stay: `Stay ${m.stayNo}`,
        ownNumber: f.invoiceRef,
        checkIn: ci ? formatDocDate(ci) : "—",
        checkOut: co ? formatDocDate(co) : "—",
        total: formatMoney(f.total),
        advanceDueNow: f.requiredAdvance != null ? formatMoney(f.advanceDueNow) : "—",
      },
    });
  }
  const receivedTotal = sumMoney(received);
  const firstDeadline = deadlines.length ? new Date(Math.min(...deadlines.map((d) => d.getTime()))) : null;
  const to = inquiry?.travelAgent?.displayName ?? inquiry?.corporateAccount?.displayName ?? (guestDisplayName(inquiry?.guestProfile) || "Guest");
  const number = paperNumber(paper.documentNumber, paper.versionNumber);
  const html = renderLegphelTripProformaHtml({
    masthead: mastheadFromHotelProfile(hotel),
    proformaNo: number,
    bookingRef: paper.inquiryId,
    date: formatDocDateLocal(paper.sentAt ?? paper.createdAt),
    advanceDueBy: firstDeadline ? formatDocDate(firstDeadline) : null,
    validUntil: paper.validUntil ? formatDocDateTimeLocal(paper.validUntil) : null,
    to,
    stays,
    summary: stays.map((s) => s.row),
    tripTotal: formatMoney(paper.totalAmount),
    advanceReceived: receivedTotal.gt(0) ? formatMoney(receivedTotal) : null,
    advanceDueNow: anyAsked ? formatMoney(sumMoney(due)) : null,
    balanceAtCheckout: formatMoney(sumMoney(balance)),
    bank: {
      accountName: hotel.accountNumber ? `${hotel.hotelName} · ${hotel.accountNumber}` : null,
      accountsPhone: primaryContactNumber(hotel.contactNumbers) || null,
    },
    sharingNote:
      "A payment for this trip goes to the first stay's advance first, then to the next stay's. Anything paid beyond the advances goes to the stays in the same order.",
    closingNote:
      "Each stay keeps its own proforma, named above. The trip total is the stays' totals added up. No surcharge applies on any payment mode. Cancellation terms as disclosed for each stay.",
  });
  return { html, number, paper };
}

export async function renderTripProformaPdf(prisma: PrismaClient, tripPaperId: string, opts?: { nightsMode?: NightsMode }) {
  const { html, number } = await renderTripProformaHtml(prisma, tripPaperId, opts);
  return { bytes: await renderHtmlToPdf(html, { fitToPage: true }), filename: `${number.replace(" · ", "-")}-trip-proforma.pdf` };
}

/**
 * Send the trip's proforma: one email with its paper (or recorded as sent on WhatsApp), and each
 * stay's proforma not yet sent sent with it — not emailed on its own.
 */
export async function sendTripProforma(
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
  const to = input.to?.trim() || (input.channel === "EMAIL" ? sendTo.email : sendTo.phone);
  if (input.channel === "EMAIL" && to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new ValidationError("That is not an email address.");
  // What would stop a stay's proforma going out is asked of every stay before any goes.
  for (const s of stays) if (s.folioId) await enforceEarlierAdvanceAnswered(prisma, s.entry.id, s.folioId);
  for (const s of stays) {
    if (s.invoice?.state === "DRAFT") {
      await dispatchInvoice(prisma, s.invoice.id, actor.actorId, {
        dispatchedTo: to ?? undefined,
        viaTripPaper: { id: paper.id, number, channel: input.channel },
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
        payload: { tripPaperId: paper.id, kind: "PROFORMA", number, channel: input.channel, to },
        createdBy: actor.actorId,
      },
    });
  }
  if (input.channel === "EMAIL" && to) await emailTripProforma(prisma, paper.id, members, to, number, input.nightsEach === true);
  return { sentTo: to, channel: input.channel, number };
}

async function emailTripProforma(prisma: PrismaClient, tripPaperId: string, members: TripProformaMember[], to: string, number: string, nightsEach: boolean) {
  const first = await prisma.entry.findUnique({ where: { id: members[0].entryId }, select: { id: true, inquiryId: true, guestCount: true } });
  if (!first) return;
  const figs = await Promise.all(members.map((m) => proformaEmailFigures(prisma, m.paperId)));
  const parts = figs.map((f) => f.breakdown);
  const add = (k: keyof StayChargeBreakdown) => Number(sumMoney(parts.map((p) => p[k])).toFixed(2));
  const breakdown: StayChargeBreakdown = {
    subTotal: add("subTotal"),
    serviceChargeRate: parts[0]?.serviceChargeRate ?? 0,
    serviceCharge: add("serviceCharge"),
    gstRate: parts[0]?.gstRate ?? 0,
    gst: add("gst"),
    total: Number(sumMoney(members.map((m) => m.total)).toFixed(2)),
  };
  const asked = figs.filter((f) => f.requiredAdvance != null);
  const deadlines = await prisma.entry.findMany({ where: { id: { in: members.map((m) => m.entryId) } }, select: { checkInDate: true } });
  const ins = members.map((m) => m.checkIn).filter(Boolean).sort();
  const outs = members.map((m) => m.checkOut).filter(Boolean).sort();
  const paper = await prisma.tripPaper.findUnique({ where: { id: tripPaperId }, select: { validUntil: true } });
  const recipient = await resolveSendTo(prisma, first.id);
  const content = renderProformaInvoiceEmail({
    guestDisplayName: recipient.party ?? "Guest",
    invoiceRef: number,
    checkInDate: new Date(`${ins[0]}T00:00:00Z`),
    checkOutDate: new Date(`${outs[outs.length - 1]}T00:00:00Z`),
    guestCount: first.guestCount ?? 1,
    currency: "BTN",
    breakdown,
    advanceReceived: Number(sumMoney(figs.map((f) => f.advanceReceived)).toFixed(2)),
    paymentCount: figs.reduce((n, f) => n + f.paymentCount, 0),
    advanceAsked: asked.length > 0,
    advanceDueNow: Number(sumMoney(figs.map((f) => f.advanceDueNow)).toFixed(2)),
    advanceDueQualifier: null,
    balanceAtCheckout: Number(sumMoney(figs.map((f) => f.balanceAtCheckout)).toFixed(2)),
    advanceDueBy: deadlines.map((d) => d.checkInDate).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null,
    validUntil: paper?.validUntil ?? null,
    paymentPlan: null,
  });
  try {
    const pdf = await renderTripProformaPdf(prisma, tripPaperId, { nightsMode: nightsEach ? "EACH" : "SHORT" });
    content.attachments = [{ filename: pdf.filename, content: pdf.bytes, contentType: "application/pdf" }];
  } catch {
    // The email still goes with its words; the desk can send the paper again.
  }
  await dispatchStageEmailBestEffort(
    { prisma, entryId: first.id, actorId: "SYSTEM", inquiryId: first.inquiryId, guestEmail: to, stage: Stage.S3, eventTypePrefix: "TRIP_PROFORMA_EMAIL" },
    content,
  );
}

/** The guest's answer to the trip's proforma, recorded on each stay's proforma it was sent with. */
export async function answerTripProforma(
  prisma: PrismaClient,
  tripPaperId: string,
  actor: Actor,
  input: { method: "WRITTEN" | "VERBAL"; verbatimNote?: string | null },
) {
  const paper = await loadPaper(prisma, tripPaperId);
  if (!paper.sentAt) throw new ValidationError("The trip's proforma has not been sent — there is no answer to record.");
  if (input.method === "VERBAL" && !input.verbatimNote?.trim()) throw new ValidationError("Write down what the guest said.");
  const members = paper.members as unknown as TripProformaMember[];
  let recorded = 0;
  for (const m of members) {
    const comms = await prisma.communicationRecord.findMany({
      where: { entryId: m.entryId, commType: "PROFORMA_INVOICE", payload: { path: ["invoiceId"], equals: m.paperId } },
      orderBy: { createdAt: "desc" },
      select: { id: true, acknowledgementStatus: true },
    });
    const waiting = comms.find((c) => c.acknowledgementStatus === "PENDING" || c.acknowledgementStatus === "TIMED_OUT");
    if (!waiting) continue;
    await recordCommunicationAcknowledgement(prisma, waiting.id, actor, { method: input.method, verbatimNote: input.verbatimNote ?? null });
    recorded++;
  }
  await prisma.tripPaper.update({ where: { id: paper.id }, data: { answeredAt: new Date(), answeredBy: actor.actorId } });
  return { recorded };
}

/* ------------------------------------------------------------------ a payment for the trip */

export type TripPaymentShareInput = { entryId: string; amount: number };

/** The steps a stay's own payment is taken at — Set up to Check-in (`recordPaymentTx`'s window). */
const PAYABLE_STAGES: Stage[] = [Stage.S3, Stage.S4, Stage.S5, Stage.S6];

/**
 * Each live stay of the trip with what a payment can do for it (2026-11-07): its advance still asked
 * and what it still costs, from the readers the payment gates and the header read — the advance
 * evaluation and the billing summary — so a trip payment is shared the same way at Set up, Reserve,
 * Arrival or Check-in, with a trip proforma or without one.
 */
async function readPaymentStays(prisma: PrismaClient, inquiryId: string) {
  const entries = await prisma.entry.findMany({
    where: { inquiryId, status: { in: ["ACTIVE", "PARKED"] } },
    orderBy: [{ checkInDate: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      currentStage: true,
      checkInDate: true,
      checkOutDate: true,
      folio: {
        select: {
          id: true,
          state: true,
          invoices: {
            where: { invoiceType: "PROFORMA", state: { not: "SUPERSEDED" } },
            orderBy: [{ versionNumber: "desc" }, { createdAt: "desc" }],
            take: 1,
            select: { id: true, documentNumber: true, versionNumber: true },
          },
        },
      },
    },
  });
  const zero = toDecimal(0);
  return Promise.all(
    entries.map(async (e, i) => {
      const base = {
        stayNo: i + 1,
        entryId: e.id,
        stage: e.currentStage,
        checkIn: ymd(e.checkInDate),
        checkOut: ymd(e.checkOutDate),
        folioId: e.folio?.id ?? null,
        number: e.folio?.invoices[0] ? printedProformaNumber(e.folio.invoices[0]) : null,
      };
      if (!e.folio) {
        return { ...base, payable: false, why: "not set up yet — no bill to take money on", advanceAsked: null, received: zero, dueNow: zero, canTake: zero };
      }
      const ev = await evaluateAdvancePaymentCondition(prisma, { entryId: e.id, folioId: e.folio.id });
      const summary = await buildEntryBillingSummary(prisma, e.id);
      const received = toDecimal(ev.totalReceived);
      const total = summary.stayTotal.amount != null ? toDecimal(summary.stayTotal.amount) : null;
      const dueNow = toDecimal(ev.shortfall);
      const canTake = total ? maxZeroSub(total, received) : dueNow;
      const payable = PAYABLE_STAGES.includes(e.currentStage as Stage) && e.folio.state === "PROVISIONAL";
      return {
        ...base,
        payable,
        why: payable ? null : PAYABLE_STAGES.includes(e.currentStage as Stage) ? "its bill is no longer open for an advance" : "in house or after — its bill takes money at the desk",
        advanceAsked: ev.requiredAmount > 0 ? toDecimal(ev.requiredAmount) : null,
        received,
        dueNow: payable ? dueNow : zero,
        canTake: payable ? canTake : zero,
      };
    }),
  );
}
type PaymentStay = Awaited<ReturnType<typeof readPaymentStays>>[number];

/**
 * How a payment for the trip is shared (2026-11-07, operator: way B, with way C as an option).
 * B: each stay's advance still asked, the first stay first; then anything beyond, each stay up to
 * what it still costs, in the same order. C: as the desk typed it, each stay at most what it still
 * costs, a stay that cannot take money given none. Decimal throughout; the answer says in words what
 * is wrong with it, nothing is written.
 */
function shareTripPayment(stays: PaymentStay[], input: { amount?: number | null; shares?: TripPaymentShareInput[] | null }) {
  const rows = stays.map((s) => ({ ...s, share: toDecimal(0) }));
  let problem: string | null = null;
  const typed = !!input.shares && input.shares.length > 0;
  const mode = typed ? ("AS_TYPED" as const) : ("FIRST_STAY_FIRST" as const);
  if (typed) {
    for (const t of input.shares!) {
      const r = rows.find((x) => x.entryId === t.entryId);
      if (!r) return { rows, mode, problem: `${t.entryId} is not a stay of this trip.`, sharesTotal: toDecimal(0) };
      if (!Number.isFinite(t.amount) || t.amount < 0) return { rows, mode, problem: `Stay ${r.stayNo}'s share must be zero or more.`, sharesTotal: toDecimal(0) };
      r.share = toDecimal(t.amount).toDecimalPlaces(2);
    }
    for (const r of rows) {
      if (r.share.gt(0) && !r.payable) {
        problem = `Stay ${r.stayNo} cannot take a payment here — ${r.why}.`;
        break;
      }
      if (r.share.gt(r.canTake)) {
        problem = `Stay ${r.stayNo} would get more than it still costs — at most Nu ${formatMoney(r.canTake.toFixed(2))}.`;
        break;
      }
    }
  } else {
    let left = toDecimal(input.amount ?? 0).toDecimalPlaces(2);
    for (const r of rows) {
      const take = Prisma.Decimal.min(left, r.dueNow);
      r.share = r.share.add(take);
      left = left.sub(take);
    }
    for (const r of rows) {
      const take = Prisma.Decimal.min(left, maxZeroSub(r.canTake, r.share));
      r.share = r.share.add(take);
      left = left.sub(take);
    }
    if (left.gt(0)) problem = `That is more than the trip still costs — at most Nu ${formatMoney(sumMoney(rows.map((r) => r.canTake)).toFixed(2))}.`;
  }
  const sharesTotal = sumMoney(rows.map((r) => r.share));
  if (!problem && input.amount != null && typed && !sharesTotal.equals(toDecimal(input.amount).toDecimalPlaces(2))) {
    problem = `The shares come to Nu ${formatMoney(sharesTotal.toFixed(2))}, not the Nu ${formatMoney(toDecimal(input.amount).toFixed(2))} received.`;
  }
  if (!problem && sharesTotal.lte(0)) problem = rows.some((r) => r.payable) ? "Put in the amount received." : "No stay of this trip can take a payment here.";
  return { rows, mode, problem, sharesTotal };
}

const stayOut = (x: PaymentStay & { share?: Prisma.Decimal }) => ({
  stayNo: x.stayNo,
  entryId: x.entryId,
  stage: x.stage,
  checkIn: x.checkIn,
  checkOut: x.checkOut,
  number: x.number,
  payable: x.payable,
  why: x.why,
  advanceAsked: x.advanceAsked ? x.advanceAsked.toFixed(2) : null,
  received: x.received.toFixed(2),
  dueNow: x.dueNow.toFixed(2),
  canTake: x.canTake.toFixed(2),
  ...(x.share ? { share: x.share.toFixed(2) } : {}),
});

/** The live trip proforma, if one is in force — named on each payment's note. */
async function liveTripProformaNumber(prisma: PrismaClient, inquiryId: string) {
  const p = await prisma.tripPaper.findFirst({ where: { inquiryId, kind: "PROFORMA", state: "LIVE" }, select: { id: true, documentNumber: true, versionNumber: true } });
  return p ? { id: p.id, number: paperNumber(p.documentNumber, p.versionNumber) } : null;
}

/** A trip's stays as a payment sees them: each one's advance, what it holds and what it can take. */
export async function describeTripPayment(prisma: PrismaClient, entryId: string) {
  const inquiryId = await tripOfEntry(prisma, entryId);
  const stays = await readPaymentStays(prisma, inquiryId);
  return {
    inquiryId,
    tripPaper: await liveTripProformaNumber(prisma, inquiryId),
    stays: stays.map(stayOut),
    received: sumMoney(stays.map((s) => s.received)).toFixed(2),
    dueNow: sumMoney(stays.map((s) => s.dueNow)).toFixed(2),
    canTake: sumMoney(stays.map((s) => s.canTake)).toFixed(2),
  };
}

/** How a payment would be shared between the stays, and what is wrong with it — nothing written. */
async function previewForInquiry(prisma: PrismaClient, inquiryId: string, input: { amount?: number | null; shares?: TripPaymentShareInput[] | null }) {
  const stays = await readPaymentStays(prisma, inquiryId);
  const r = shareTripPayment(stays, input);
  return {
    mode: r.mode,
    problem: r.problem,
    sharesTotal: r.sharesTotal.toFixed(2),
    stays: r.rows.map(stayOut),
    tripDueNow: sumMoney(stays.map((s) => s.dueNow)).toFixed(2),
    tripCanTake: sumMoney(stays.map((s) => s.canTake)).toFixed(2),
  };
}

export async function previewTripPaymentForEntry(prisma: PrismaClient, entryId: string, input: { amount?: number | null; shares?: TripPaymentShareInput[] | null }) {
  return previewForInquiry(prisma, await tripOfEntry(prisma, entryId), input);
}

export async function previewTripPayment(prisma: PrismaClient, tripPaperId: string, input: { amount?: number | null; shares?: TripPaymentShareInput[] | null }) {
  return previewForInquiry(prisma, (await loadPaper(prisma, tripPaperId)).inquiryId, input);
}

/**
 * Record a payment for the trip: each stay's share on its own bill, through the stay's own payment
 * checks, every share in ONE transaction — all land or none does. Then each stay's after-steps (its
 * rooms blocked at Set up). One payment from the guest becomes one payment record per stay, each
 * naming the trip (its proforma when one is in force) and the whole amount.
 */
async function recordForInquiry(
  prisma: PrismaClient,
  inquiryId: string,
  actor: Actor,
  input: { amount: number; paymentMethod?: string | null; notes?: string | null; shares?: TripPaymentShareInput[] | null },
) {
  const paper = await liveTripProformaNumber(prisma, inquiryId);
  const named = paper?.number ?? inquiryId;
  const written = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", `trip-payment:${inquiryId}`);
      const stays = await readPaymentStays(prisma, inquiryId);
      const r = shareTripPayment(stays, input);
      if (r.problem) throw new ValidationError(r.problem);
      const whole = r.sharesTotal.toFixed(2);
      const out: Array<{ stayNo: number; entryId: string; amount: string; paymentId: string; stage: Stage }> = [];
      for (const row of r.rows) {
        if (row.share.lte(0)) continue;
        if (!row.folioId) throw new ValidationError(`Stay ${row.stayNo} (${row.entryId}) has no bill yet.`);
        const note = [`Part of Nu ${formatMoney(whole)} paid for the trip (${named}) · Nu ${formatMoney(row.share.toFixed(2))} to this stay`, input.notes?.trim() || null]
          .filter(Boolean)
          .join(" · ");
        try {
          const { created, stageAtPayment } = await recordPaymentTx(prisma, tx, row.folioId, actor.actorId, {
            entryId: row.entryId,
            amount: Number(row.share.toFixed(2)),
            notes: note,
            paymentMethod: input.paymentMethod ?? null,
          });
          out.push({ stayNo: row.stayNo, entryId: row.entryId, amount: row.share.toFixed(2), paymentId: created.id, stage: stageAtPayment });
        } catch (e) {
          // Say which stay refused; nothing of this payment is written.
          if (e instanceof AppError) {
            const msg = `Stay ${row.stayNo} (${row.entryId}): ${e.body.message}`;
            e.body = { ...e.body, message: msg };
            e.message = msg;
          }
          throw e;
        }
      }
      const now = new Date();
      for (const o of out) {
        await tx.traceEvent.create({
          data: {
            eventType: "TRIP_PAPER.PAYMENT_SHARED",
            actorId: actor.actorId,
            actorLevel: actor.actorLevel,
            entityType: paper ? "TripPaper" : "Inquiry",
            entityId: paper?.id ?? inquiryId,
            operation: "CREATE",
            timestamp: now,
            inquiryId,
            entryId: o.entryId,
            payload: {
              tripPaperId: paper?.id ?? null,
              number: paper?.number ?? null,
              amount: whole,
              mode: r.mode,
              paymentMethod: input.paymentMethod ?? null,
              shares: out.map((x) => ({ stayNo: x.stayNo, entryId: x.entryId, amount: x.amount, paymentId: x.paymentId })),
            },
            createdBy: actor.actorId,
          },
        });
      }
      return { out, whole, mode: r.mode };
    },
    { timeout: 60_000, maxWait: 30_000 },
  );
  const autoHolds = [];
  for (const o of written.out) {
    const autoHold = await afterPaymentRecorded(prisma, { paymentId: o.paymentId, entryId: o.entryId, stageAtPayment: o.stage }, actor.actorId, actor.actorLevel);
    autoHolds.push({ entryId: o.entryId, autoHold });
  }
  return { amount: written.whole, mode: written.mode, shares: written.out.map(({ stage: _s, ...x }) => x), autoHolds };
}

type RecordInput = { amount: number; paymentMethod?: string | null; notes?: string | null; shares?: TripPaymentShareInput[] | null };

export async function recordTripPaymentForEntry(prisma: PrismaClient, entryId: string, actor: Actor, input: RecordInput) {
  return recordForInquiry(prisma, await tripOfEntry(prisma, entryId), actor, input);
}

export async function recordTripPayment(prisma: PrismaClient, tripPaperId: string, actor: Actor, input: RecordInput) {
  return recordForInquiry(prisma, (await loadPaper(prisma, tripPaperId)).inquiryId, actor, input);
}

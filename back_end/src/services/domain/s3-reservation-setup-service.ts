import { enforceEarlierAdvanceAnswered } from "../../lib/refund-money.js";
import { resolveStandsUntil } from "../../lib/quote-validity.js";
import { armProformaValidityTx } from "./proforma-validity-service.js";
import type { PrismaClient } from "@prisma/client";
import { FolioState, InvoiceState, InvoiceType, Stage } from "@prisma/client";
import { AuthorizationError, NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import type { ActorLevel } from "../../types/actor.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { enforceBillingModelAllowlistFromConfig } from "../../policies/13-billing-model/p30-billing-model-allowlist-from-config.js";
import { enforceEntryAtS3ForS3DomainOperations } from "../../policies/01-availability/p01-entry-at-s3-for-s3-domain-operations.js";
import { enforceGroupBillingSplitConfigured } from "../../policies/26-group-foc-billing/p66-group-foc-and-billing-split.js";
import { allocateReadableId, READABLE_ID_PREFIXES } from "../../lib/readable-id.js";
import { applyPartyAdvanceRuleTx, ensureProformaOfThisPassTx, proformaAwaitsAdvanceAnswerTx, reissueProformaTx } from "./s3-payment-service.js";
import { retireSupersededReplyWaitsBestEffort } from "../../lib/reply-waits.js";
import { buildInitialBillingModelDefaults } from "../../lib/billing-model-defaults.js";
import { payerChoicesFor, type PayerChoices } from "../../lib/payer-choices.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";

export { progressS2ToS3 } from "../../state-machines/s2-s3-state-machine.js";

/** What Set up offers this booking for who pays, and what it starts on. */
export async function readPayerChoices(prisma: PrismaClient, entryId: string): Promise<PayerChoices> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      groupBillingMode: true,
      useType: true,
      inquiry: { select: { travelAgentId: true, corporateAccountId: true, sourceChannel: true } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  return payerChoicesFor({ ...entry.inquiry, groupBillingMode: entry.groupBillingMode, useType: entry.useType });
}

const PAYER_NOT_OFFERED: Record<"TRAVEL_AGENT" | "CORPORATE" | "NONE", string> = {
  TRAVEL_AGENT: "A booking through a travel agent goes either as the package to them with extras to the guest, or everything to them",
  CORPORATE: "A company's booking goes either as the package to them with extras to the guest, or everything to them",
  NONE: "This booking has no travel agent or company to bill, so everything goes to the guest",
};

/**
 * "No advance": the proforma the desk was holding back is made now (2026-11-05). Pressing it again
 * makes no second one. A "yes" makes its proforma when the advance is saved.
 */
export async function generateProformaOfThisPass(prisma: PrismaClient, entryId: string, actorId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { folio: true, segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { startedAt: true } } },
  });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  enforceEntryAtS3ForS3DomainOperations({ currentStage: entry.currentStage });
  if (!entry.folio?.billingModel) throw new ValidationError("Choose who pays first — the proforma is made out to them");
  const folioId = entry.folio.id;
  // One whose time ended is made again: a new version with a new time, the old one kept (2026-11-05).
  const lapsed = await prisma.invoice.findFirst({
    where: { folioId, invoiceType: InvoiceType.PROFORMA, state: { not: InvoiceState.SUPERSEDED }, lapsedAt: { not: null } },
    select: { id: true },
  });
  if (lapsed) {
    await enforceEarlierAdvanceAnswered(prisma, entryId, folioId);
    const { freezeUnrenderedProformasForEntry } = await import("./invoice-pdf-service.js");
    await freezeUnrenderedProformasForEntry(prisma, entryId, actorId).catch(() => {});
    const remade = await prisma.$transaction((tx) =>
      reissueProformaTx(tx, { entryId, folioId, changed: true, basisWhenChanged: "PROFORMA_LAPSED", now: new Date() }, { actorId, actorLevel: "L1" }),
    );
    await retireSupersededReplyWaitsBestEffort(prisma, entryId, actorId);
    return { generated: !!remade, proforma: remade };
  }
  const made = await prisma.$transaction((tx) =>
    ensureProformaOfThisPassTx(tx, { entryId, folioId, passStartedAt: entry.segments[0]?.startedAt ?? null, basis: "NO_ADVANCE_ASKED" }, { actorId, actorLevel: "L1" }),
  );
  await retireSupersededReplyWaitsBestEffort(prisma, entryId, actorId);
  return { generated: !!made, proforma: made };
}

/**
 * How long this proforma stands, on the quote's rule: shorter than the longest, or back up to it
 * (2026-11-05). The paper prints it, so one already opened or sent is made again as a new version.
 */
export async function setProformaValidity(
  prisma: PrismaClient,
  invoiceId: string,
  ask: { validDays?: number; validHours?: number },
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
) {
  const inv = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, entryId: true, folioId: true, invoiceType: true, state: true, pdfRenderedAt: true, dispatchedAt: true, lapsedAt: true, entry: { select: { status: true, currentStage: true, inquiryId: true } } },
  });
  if (!inv || inv.invoiceType !== InvoiceType.PROFORMA) throw new NotFoundError("Proforma");
  enforceEntryNotSealedForWorkingAction({ status: inv.entry.status });
  enforceEntryAtS3ForS3DomainOperations({ currentStage: inv.entry.currentStage });
  if (inv.state === InvoiceState.SUPERSEDED) throw new ValidationError("That proforma has been replaced.");
  if (inv.lapsedAt) throw new ValidationError("This proforma has run out. Make it again first.");
  const now = new Date();
  const { validUntil } = await resolveStandsUntil(prisma, inv.entryId, ask, now, "proforma");
  const printed = !!inv.pdfRenderedAt || !!inv.dispatchedAt;
  if (printed) {
    const { freezeUnrenderedProformasForEntry } = await import("./invoice-pdf-service.js");
    await freezeUnrenderedProformasForEntry(prisma, inv.entryId, actor.actorId).catch(() => {});
  }
  const out = await prisma.$transaction(async (tx) => {
    const remade = printed
      ? await reissueProformaTx(tx, { entryId: inv.entryId, folioId: inv.folioId, changed: true, basisWhenChanged: "VALIDITY_CHANGED", now, validity: ask }, actor)
      : null;
    if (!printed) await armProformaValidityTx(tx, { invoiceId: inv.id, entryId: inv.entryId, validUntil, actorId: actor.actorId, now });
    await tx.traceEvent.create({
      data: {
        eventType: "PROFORMA.VALIDITY_SET",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "Invoice",
        entityId: remade?.newInvoiceId ?? inv.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: inv.entry.currentStage,
        inquiryId: inv.entry.inquiryId,
        entryId: inv.entryId,
        payload: { entryId: inv.entryId, invoiceId: remade?.newInvoiceId ?? inv.id, validUntil: validUntil.toISOString(), madeAgain: !!remade },
        createdBy: actor.actorId,
      },
    });
    return remade;
  });
  await retireSupersededReplyWaitsBestEffort(prisma, inv.entryId, actor.actorId);
  return { validUntil: validUntil.toISOString(), invoiceId: out?.newInvoiceId ?? inv.id, madeAgain: !!out };
}

export async function ensureProvisionalFolioAndBillingModel(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  actorLevel: ActorLevel,
  input: { billingModel: string; askAdvanceFirst?: boolean },
  // A booking split off another carries that booking's payer, whatever it was (2026-11-05).
  opts?: { carried?: boolean },
) {
  if (!input.billingModel?.trim()) throw new ValidationError("billingModel is required");
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { folio: true, segments: { orderBy: { segmentNumber: "desc" }, take: 1 } } });
  if (!entry) throw new NotFoundError("Entry");
  // A lapse leaves the stage where it was, so the gate below passes on a dead booking (2026-10-01).
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  enforceEntryAtS3ForS3DomainOperations({ currentStage: entry.currentStage });
  const segmentId = entry.segments[0]?.id;
  if (!segmentId) throw new ValidationError("Entry has no segment");

  // Policy 66 safety-net: a group entry (Policy 64 already set groupBillingMode at S1) may
  // never progress through S3 folio setup without groupBillingMode still on the entry.
  // Someone could have unset it via a direct DB write or a future admin tool; the guard here
  // means the operational flow catches that state before writing the folio.
  const isGroupUseType = entry.useType === "GROUP" || entry.useType === "CONFERENCE";
  enforceGroupBillingSplitConfigured({
    isGroup: isGroupUseType || entry.groupBillingMode != null,
    hasGroupBillingMode: entry.groupBillingMode != null,
  });

  // Authority gate: for GROUP_MASTER entries, moving off the group-friendly billing models
  // (DIRECT_BILL / TOUR_OPERATOR_VOUCHER) requires L3+. Reasoning: converting a group to
  // per-guest billing effectively splits the folio's payment stream and dissolves the
  // group's operational identity — the tour operator / corporate account may have contract
  // language relying on centralized billing. An L1 receptionist should not be able to do
  // this quietly during check-in. L3 (FOM) or higher approves.
  const requestedModel = input.billingModel.trim().toUpperCase();
  // What Set up offers is the rule, not only the desk's list. Pressing again on the payer already on
  // the bill is not a new choice: a booking from before this rule keeps what it has.
  if (!opts?.carried && entry.folio?.billingModel?.trim().toUpperCase() !== requestedModel) {
    const offered = await readPayerChoices(prisma, entryId);
    if (!offered.choices.includes(requestedModel)) {
      throw new PolicyGateBlockedError("PAYER_NOT_OFFERED", PAYER_NOT_OFFERED[offered.party ?? "NONE"]);
    }
  }
  const isGroupFriendly = requestedModel === "DIRECT_BILL" || requestedModel === "TOUR_OPERATOR_VOUCHER";
  if (entry.groupBillingMode === "GROUP_MASTER" && !isGroupFriendly) {
    if (actorLevel !== "L3" && actorLevel !== "L4") {
      throw new AuthorizationError(
        `Changing a group booking's billing model to ${requestedModel} requires L3+ authority (this booking was auto-classified as GROUP_MASTER at S1).`,
      );
    }
  }

  const folioOut = await prisma.$transaction(async (tx) => {
    const allowed = await requireActiveConfigValue<Record<string, string[]>>(tx as any, "billingModel.availablePerSource").catch(
      () => ({} as Record<string, string[]>),
    );
    const flattened = Object.values(allowed).flat();
    enforceBillingModelAllowlistFromConfig({ billingModel: input.billingModel, allowedFlattened: flattened });

    let folio = entry.folio;
    if (!folio) {
      const folioId = await allocateReadableId(tx, "FOLIO" as const);
      folio = await tx.folio.create({
        data: {
          id: folioId,
          entryId,
          state: FolioState.PROVISIONAL,
          billingModel: input.billingModel.trim(),
          createdBy: actorId,
          outstandingBalance: 0,
          advancePaymentReconciliationComplete: false,
        },
      });
    } else {
      await tx.folio.update({ where: { id: folio.id }, data: { billingModel: input.billingModel.trim() } });
    }

    // Populate the per-type split-billing defaults map. When the entry has a linked travel
    // agent or corporate account, ROOM_CHARGE → primaryModel while F_AND_B / SERVICE / OTHER
    // → GUEST_PAY. This drives what `resolveBillingModelForNewLine` returns for future posts.
    const initialDefaults = await buildInitialBillingModelDefaults(tx, folio.id, input.billingModel);
    await tx.folio.update({
      where: { id: folio.id },
      data: { billingModelDefaults: initialDefaults },
    });

    await tx.billingModelTransitionRecord.create({
      data: {
        folioId: folio.id,
        segmentId,
        fromModel: null,
        toModel: input.billingModel.trim(),
        createdBy: actorId,
        changeSource: "INITIAL_FIXATION",
      },
    });

    // The proforma is Set up's exit evidence — one per pass, not one per press (2026-09-25).
    // This ran unconditionally, so a second thought about the billing model minted a second live
    // bill; and on a re-entered booking it was the only thing that ever minted one at all, which
    // is why a pass arriving with its old bill superseded had none. The shared helper mints only
    // when no live proforma stands, and never replaces one that does.
    // …and a pass that reached Set up straight from Reserve (a change of who pays) gets its own
    // here, the earlier pass's bill replaced (2026-10-29).
    // A booking through a travel agent or a company takes its own advance here too, before the
    // bill that prints it — for one already at Set up when the percentage was set (2026-11-05).
    await applyPartyAdvanceRuleTx(tx, { entryId, folioId: folio.id, segmentId, actorId, now: new Date() });
    // The desk asks about an advance first when nothing is asked yet: the proforma, which prints
    // it, waits for the answer (2026-11-05). Everyone else gets it now, as before.
    const passStartedAt = entry.segments[0]?.startedAt ?? null;
    const advanceQuestion =
      input.askAdvanceFirst === true && (await proformaAwaitsAdvanceAnswerTx(tx, { entryId, folioId: folio.id, passStartedAt }));
    if (!advanceQuestion) {
      await ensureProformaOfThisPassTx(tx, { entryId, folioId: folio.id, passStartedAt, basis: "S3 setup" }, { actorId, actorLevel: "L1" });
    }

    return { ...(await tx.folio.findUniqueOrThrow({ where: { id: folio.id }, include: { invoices: true } })), advanceQuestion };
  });
  // An earlier pass's proforma replaced here is no longer waiting for an answer.
  await retireSupersededReplyWaitsBestEffort(prisma, entryId, actorId);
  return folioOut;
}


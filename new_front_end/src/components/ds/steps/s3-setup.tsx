"use client";

/**
 * Step 3 · Set up — "hold & deposit" (SS03 §6, prototype `stepCanvas[3]`, Storyboard 03).
 *
 * The three parties, the billing model, the committed hold, the payment plan (the advance as a
 * chain — see s3-money.tsx), the terms disclosed, the proforma with the guest's answer, and —
 * when the booking is a group or a company's — the coordinator, free-of-charge rooms and payment
 * milestones. Nothing is frozen here; that happens at Reserve, from the gate bar.
 *
 * Figures come from the backend only: the advance from payment-status, the proforma as the
 * backend composes it. Nothing is added up here.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { BindingBox, Button, Chip, Icon } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import { openInvoicePdf } from "@/lib/api/documents";
import { getInquiry } from "@/lib/api/inquiries";
import {
  approveFocGm,
  cancelEntryAtS3,
  confirmCoordinator,
  dispatchInvoice,
  ensureProvisionalFolio,
  getHoldWindow,
  initiateS3ReEntryToS1,
  initiateS3ReEntryToS2,
  placeCommittedHold,
  recordCancellationDisclosure,
  releaseCommittedHold,
  setCommittedHoldExpiry,
  listPaymentMilestoneTemplates,
  schedulePaymentMilestones,
} from "@/lib/api/reservation-setup";
import { guestNameOf } from "@/lib/ds/status";
import { fmtDateTime, fmtRange, fmtStamp, hotelFormParts, money, plural } from "@/lib/ds/format";
import { optionSelectedRoomIds, preferredHoldRoomId, type EntryDetail, type InvoiceSummary, type PaymentStatusSummary } from "@/types/api";
import {
  AnswerLine,
  Choice,
  DsDialog,
  Fact,
  FactBox,
  Facts,
  Live,
  OnRecord,
  PaperDrawer,
  ReasonDialog,
  SeeRow,
  StepCanvas,
  StepCard,
  atLeast,
  currentPassStart,
  toastRefusal,
  useCommunications,
  useRefreshEntry,
  useStepMode,
  words,
  type PaperRef,
  type ChangeBookingItem,
  ChangeBookingMenu,
  StageActs,
  useFlowUnsaved,
  useFinishWhenDone,
  useStepFlow,
  goToStepCard,
  revealCard,
  useOpenAlsoWay,
  OtherWaysTabs,
  InlineWay,
  ShutWay,
  parkTab,
} from "./kit";
import { RoomsTableCard } from "./rooms-table";
import { SendToField, useSendTo } from "./s8-parts";
import { CancellationFiguresLine, WaiverTick, useRefundHow } from "./cancel-figures";
import { CompetingClaimsCard, passesOf, roomsWord, useRoomNumbers } from "./s2-shared";
import { PaymentPlanCard } from "./s3-money";
import { Help, HelpHere } from "@/components/ds/help";
import { DateInput } from "@/components/ds/date-input";
import { StepMoved, type StepMovedNote } from "@/components/ds/workspace/step-moved";

/* ------------------------------------------------------------------ vocabulary */

const BILLING_WORD: Record<string, string> = {
  TOUR_OPERATOR_VOUCHER: "The package to the account · anything beyond it to the guest",
  DIRECT_BILL: "Everything to the account",
  GUEST_PAY: "Everything to the guest",
};
const BILLING_ORDER = ["TOUR_OPERATOR_VOUCHER", "DIRECT_BILL", "GUEST_PAY"] as const;
/** The two models a group can take without the GM (the backend refuses the rest below L3). */
const GROUP_FRIENDLY = new Set(["DIRECT_BILL", "TOUR_OPERATOR_VOUCHER"]);

const FOLIO_WORD: Record<string, string> = {
  PROVISIONAL: "The bill is provisional — nothing is charged before check-in.",
  LIVE: "The bill is open.",
  OUTSTANDING: "The bill is settled with money still owed.",
  SETTLED: "The bill is settled.",
  CLOSED: "The bill is closed.",
};

const DEFAULT_NO_SHOW = "No-show: one night room charge plus applicable taxes.";

type InquiryScalars = {
  sourceChannel?: string | null;
  travelAgentId?: string | null;
  corporateAccountId?: string | null;
  corporateCoordinator?: string | null;
};
type InquiryRecord = {
  travelAgent?: { displayName?: string | null } | null;
  corporateAccount?: { displayName?: string | null } | null;
};
type EntryContact = { contactPersonName?: string | null; contactPersonPhone?: string | null };

/* ------------------------------------------------------------------ the step */

const ROOMS_LEAD =
  "Who sleeps where, on what plan, with what beds. Click a room to change it — every night is checked again, the booking walks back through Negotiation and the price follows.";

export function S3SetUp({
  entry,
  past,
  parkNow,
  parking,
  goToStep,
}: {
  entry: EntryDetail;
  past: boolean;
  /** Park with the reason typed in Other ways' own tab (2026-10-17). */
  parkNow?: (reason: string) => void;
  parking?: boolean;
  goToStep: (n: number) => void;
}) {
  const { session } = useSession();
  const router = useRouter();
  const refresh = useRefreshEntry(entry.id);
  const clock = useHotelClock(30_000);
  const tz = clock.tz;
  const roomNos = useRoomNumbers();
  const passes = useMemo(() => passesOf(entry), [entry.segments]); // eslint-disable-line react-hooks/exhaustive-deps
  const editable = !past && entry.currentStage === "S3" && entry.status === "ACTIVE";
  const elevated = atLeast(session?.actorLevel, "L2");
  const gm = atLeast(session?.actorLevel, "L3");
  const folio = entry.folio ?? null;
  const inq = (entry.inquiry ?? {}) as InquiryScalars;
  const extraKeys: ReadonlyArray<ReadonlyArray<unknown>> = [["invoice-preview"], ["competing-claims", entry.id]];
  const changed = () => refresh(extraKeys);

  const inquiryQuery = useQuery({
    queryKey: ["inquiry", entry.inquiryId],
    queryFn: () => getInquiry(session!, entry.inquiryId),
    enabled: !!session && !!entry.inquiryId,
  });
  const inquiryRec = (inquiryQuery.data ?? null) as InquiryRecord | null;
  const partyName = inquiryRec?.travelAgent?.displayName ?? inquiryRec?.corporateAccount?.displayName ?? null;

  const payment = usePaymentStatus(entry.id, { enabled: !!folio });
  const status = payment.data;
  // "Yes, ask for an advance" after the terms (2026-10-28) opens the payment plan's advance box.
  const [askAdvance, setAskAdvance] = useState(0);
  // A payment that blocked the rooms — the hold card asks whether to set a block time (2026-10-28).
  const [blockAsk, setBlockAsk] = useState<{ until: string | null; n: number } | null>(null);

  /* ---- the billing model the desk is choosing ---- */
  const isAgentBooking = !!inq.travelAgentId || inq.sourceChannel === "TRAVEL_AGENT" || inq.sourceChannel === "AGENT";
  // A company's booking, or a group on one master bill, starts on "everything to the account"
  // (2026-09-18): it started on the guest paying, which the group rules then refuse — the
  // operator had to work out which model a group may use.
  const isCompanyBooking = !isAgentBooking && (!!inq.corporateAccountId || inq.sourceChannel === "CORPORATE");
  const isGroupMaster = entry.groupBillingMode === "GROUP_MASTER";
  const defaultModel = isAgentBooking ? "TOUR_OPERATOR_VOUCHER" : isCompanyBooking || isGroupMaster ? "DIRECT_BILL" : "GUEST_PAY";
  const preselectedWhy = isAgentBooking
    ? "this booking came through a travel agent"
    : isCompanyBooking
      ? "a company made this booking"
      : isGroupMaster
        ? "a group bills to one master bill"
        : null;
  const savedModel = folio?.billingModel ?? null;
  // Split off another booking (2026-10-14): its payer carries until the desk chooses otherwise.
  const carriedModel = entry.carryOver?.billingModel ?? null;
  const [model, setModel] = useState<string>(savedModel ?? carriedModel ?? defaultModel);
  useEffect(() => {
    if (savedModel) setModel(savedModel);
  }, [savedModel]);

  /* ---- the rooms chosen at Inquiry ---- */
  const sealedPreferred = (entry.availabilityConfigs ?? []).find((c) => c.sealedAt && c.optionSelected);
  const sealedRoomIds = useMemo(() => optionSelectedRoomIds(sealedPreferred?.optionSelected), [sealedPreferred?.optionSelected]);
  const anchorRoomId = preferredHoldRoomId(sealedPreferred?.optionSelected ?? null);

  /* ---- the proforma and the guest's answer to it (this pass) ---- */
  const proformas = (folio?.invoices ?? []).filter((i) => i.invoiceType === "PROFORMA");
  const currentProforma = proformas.find((i) => i.state !== "SUPERSEDED") ?? null;
  const dispatched = proformas.some((i) => i.state !== "SUPERSEDED" && i.dispatchedAt != null);
  const comms = useCommunications(entry.id);
  const passStart = currentPassStart(entry);
  const latestProformaComm = (comms.data?.items ?? [])
    .filter(
      (c) =>
        c.commType === "PROFORMA_INVOICE" &&
        c.direction === "OUTBOUND" &&
        c.sendStatus === "DISPATCHED" &&
        c.inForce !== false &&
        (!passStart || (c.createdAt ?? "") >= passStart),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const answered = latestProformaComm?.acknowledgementStatus === "RECEIVED";

  const acceptedQuote = (entry.quotations ?? []).find((q) => q.state === "ACCEPTED" && (!passes.current || q.segmentId === passes.current.id));
  const isGroupLike = entry.useType === "GROUP" || entry.useType === "CONFERENCE";
  const needsMilestones = entry.useType === "CORPORATE" || entry.useType === "CONFERENCE";
  const isParty = entry.groupBillingMode === "GROUP_MASTER" || entry.useType === "GROUP";

  /* ---- the ways out ---- */
  const [leaving, setLeaving] = useState(false);
  // The GM may waive the disclosed charge here too, and the desk says how a refund goes back
  // (2026-09-19) — this dialog offered neither: a GM could not waive a Set-up cancellation from
  // the desk, and every refund was written down as cash.
  const [cancelWaive, setCancelWaive] = useState(false);
  const refundHow = useRefundHow();
  const cancelM = useMutation({
    mutationFn: (reason: string) =>
      cancelEntryAtS3(session!, entry.id, { reason, ...(gm && cancelWaive ? { penaltyWaiverRequested: true } : {}), ...refundHow.body }),
    onSuccess: () => {
      toast.success("Cancelled — the hold is released and the proforma withdrawn");
      refresh(extraKeys);
      setLeaving(true);
      router.push("/bookings");
    },
    onError: (e) => toastRefusal(e, "The booking could not be cancelled"),
  });
  const reentryM = useMutation({
    mutationFn: (v: { to: "S2" | "S1"; reason: string }) =>
      v.to === "S2"
        ? initiateS3ReEntryToS2(session!, entry.id, { reason: v.reason })
        : initiateS3ReEntryToS1(session!, entry.id, { reason: v.reason }),
    onSuccess: (_res, v) => {
      toast.success(v.to === "S2" ? "A new pass is open at Negotiation" : "A new pass is open at Inquiry");
      refresh(extraKeys);
      goToStep(v.to === "S2" ? 2 : 1);
    },
    onError: (e) => toastRefusal(e, "A new pass could not be opened"),
  });

  /**
   * Change booking (2026-10-28, Set up in the stage layout — as at Negotiation): the ways the booking
   * itself is changed, from the end of the step's line. Moving a room is the Rooms tab's table, which
   * the stage layout has no tab for; it opens in the middle of the screen.
   */
  const openAlsoWay = useOpenAlsoWay();
  const notNow = entry.status === "PARKED" ? "Resume the booking first" : "Not possible on this booking now";
  const changeItems: ChangeBookingItem[] = past
    ? []
    : [
        {
          key: "rooms",
          label: "Move a room",
          note: "Into another free room on the same dates. Every night is checked again and the price follows.",
          onSelect: editable ? () => openAlsoWay("rooms") : undefined,
          reason: editable ? undefined : notNow,
        },
        {
          key: "renegotiate",
          label: "Renegotiate the price",
          note: "Back to Negotiation for a fresh quotation. The hold is released and the proforma replaced.",
          onSelect: editable && elevated ? () => openAlsoWay("renegotiate") : undefined,
          reason: !editable ? notNow : elevated ? undefined : "The FOM's call",
        },
        {
          key: "reconfigure",
          label: "Change the dates, rooms or guests",
          note: "Back to Inquiry to ask the house again. The hold is released and the rooms are chosen again.",
          onSelect: editable && elevated ? () => openAlsoWay("reconfigure") : undefined,
          reason: !editable ? notNow : elevated ? undefined : "The FOM's call",
        },
        {
          key: "cancel",
          label: "Cancel booking",
          note: "The booking ends. The hold is released, the proforma withdrawn, the disclosed charge kept and the rest of the advance refunded.",
          onSelect: entry.status === "ACTIVE" && editable ? () => openAlsoWay("cancel") : undefined,
          reason: entry.status === "ACTIVE" && editable ? undefined : notNow,
          danger: true,
        },
      ];

  return (
    <StepCanvas past={past}>
      <StageActs>
        <ChangeBookingMenu items={changeItems} />
      </StageActs>
      <PartiesCard entry={entry} inq={inq} partyName={partyName} model={savedModel ?? model} modelSaved={!!savedModel} status={status} />

      <BillingModelCard
        entry={entry}
        editable={editable}
        gm={gm}
        model={model}
        setModel={setModel}
        savedModel={savedModel}
        preselectedWhy={
          !savedModel && carriedModel && model === carriedModel
            ? `it carries from ${entry.carryOver!.fromEntryId}, the booking these rooms came from`
            : !savedModel && preselectedWhy && model === defaultModel
              ? preselectedWhy
              : null
        }
        onChanged={changed}
      />

      {/* The order the desk works in (2026-09-25): the payer, then the terms, the bill and
          the money — and the rooms last, the only order the backend accepts them in. */}
      <TermsCard
        entry={entry}
        editable={editable}
        tz={tz}
        status={status}
        onAskAdvance={() => setAskAdvance((n) => n + 1)}
        onChanged={changed}
      />

      <ProformaCard
        entry={entry}
        editable={editable}
        tz={tz}
        proformas={proformas}
        current={currentProforma}
        status={status}
        passStart={passStart}
        answered={answered}
        onChanged={changed}
      />

      <PaymentPlanCard
        entry={entry}
        editable={editable}
        elevated={elevated}
        status={status}
        statusLoading={payment.isLoading}
        refetching={payment.isFetching}
        onRefetch={() => void payment.refetch()}
        tz={tz}
        bill={{ proforma: currentProforma, dispatched, answered }}
        askAdvance={askAdvance}
        onRoomsBlocked={(until) => setBlockAsk((prev) => ({ until, n: (prev?.n ?? 0) + 1 }))}
        onChanged={changed}
      />

      <HoldCard
        entry={entry}
        editable={editable}
        gm={gm}
        tz={tz}
        nowMs={clock.now}
        roomIds={sealedRoomIds}
        roomNos={roomNos}
        anchorRoomId={anchorRoomId}
        defaultWhy={acceptedQuote ? `Quotation ${acceptedQuote.referenceNumber} accepted` : "Reservation set-up — the rooms held for this booking"}
        blockAsk={blockAsk}
        onChanged={changed}
      />

      {isGroupLike || entry.useType === "CORPORATE" ? <CoordinatorCard entry={entry} editable={editable} inq={inq} onChanged={changed} /> : null}
      {isGroupLike ? <FocCard entry={entry} editable={editable} gm={gm} onChanged={changed} /> : null}
      {needsMilestones ? <MilestonesCard entry={entry} editable={editable} onChanged={changed} /> : null}
      {isParty ? <PartyBlock entry={entry} /> : null}

      <CompetingClaimsCard entryId={entry.id} />

      {/* Other ways as sub-tabs (2026-10-17, operator: the Negotiation tabs "for other tabs as well,
          all stages"). Each panel is the form its button used to open, set out in place. */}
      <OtherWaysTabs
        tabs={[
          entry.status === "ACTIVE" && editable
            ? {
                key: "cancel",
                label: "Cancel booking",
                inBar: false,
                content: (
                  <InlineWay
                    render={() => (
                      <ReasonDialog
                        open
                        danger
                        onClose={() => undefined}
                        busy={cancelM.isPending || leaving}
                        title="Cancel this booking"
                        caseLines={[fmtRange(entry.checkInDate, entry.checkOutDate)]}
                        lead={
                          <>
                            Cancelling at Set up is final. The committed hold is released and the rooms return to sale; the proforma is withdrawn and its
                            clocks stop; the <b>disclosed cancellation charge</b>, if any, is posted and the rest of the advance is refunded. It cannot be
                            undone.
                          </>
                        }
                        confirmLabel="Cancel the booking"
                        placeholder="guest changed their plans"
                        onConfirm={(r) => cancelM.mutate(r)}
                      >
                        <CancellationFiguresLine entryId={entry.id} waive={gm && cancelWaive} />
                        <WaiverTick checked={cancelWaive} onChange={setCancelWaive} gm={gm} />
                        {refundHow.fields}
                      </ReasonDialog>
                    )}
                  />
                ),
              }
            : null,
          parkTab(parkNow, parking),
          editable
            ? {
                key: "renegotiate",
                label: "Renegotiate the price",
                inBar: false,
                content: elevated ? (
                  <InlineWay
                    render={() => (
                      <ReasonDialog
                        open
                        onClose={() => undefined}
                        busy={reentryM.isPending}
                        title="Renegotiate the price"
                        caseLines={["A new pass opens at Negotiation"]}
                        lead="This pass is sealed as it stands. The committed hold is released, the proforma replaced, and a fresh quotation is made in the new pass."
                        confirmLabel="Open a new pass"
                        placeholder="agent asked for a better rate"
                        onConfirm={(r) => reentryM.mutate({ to: "S2", reason: r })}
                      />
                    )}
                  />
                ) : (
                  <ShutWay act="Open a new pass" why="A new pass is the FOM's call." help={<p>A new pass at Negotiation: a fresh quotation and a fresh proforma.</p>} />
                ),
              }
            : null,
          editable
            ? {
                key: "reconfigure",
                label: "Change the dates, rooms or guests",
                inBar: false,
                content: elevated ? (
                  <InlineWay
                    render={() => (
                      <ReasonDialog
                        open
                        onClose={() => undefined}
                        busy={reentryM.isPending}
                        title="Change the dates, rooms or guests"
                        caseLines={["A new pass opens at Inquiry"]}
                        lead="This pass is sealed as it stands. The committed hold is released and the house is asked again for the new dates or rooms."
                        confirmLabel="Open a new pass"
                        placeholder="guest moved the dates by a day"
                        onConfirm={(r) => reentryM.mutate({ to: "S1", reason: r })}
                      />
                    )}
                  />
                ) : (
                  <ShutWay act="Open a new pass" why="A new pass is the FOM's call." help={<p>A new pass at Inquiry: the house is asked again and the hold is released.</p>} />
                ),
              }
            : null,
          // The Rooms tab's table (2026-10-13), opened from Change booking's "Move a room" — wide,
          // since the change opens a rooms-by-night table and the room's price table inside it.
          editable ? { key: "rooms", label: "Move a room", inBar: false, wide: true, content: <RoomsTableCard entry={entry} title="The rooms" lead={ROOMS_LEAD} /> } : null,
        ]}
      />
    </StepCanvas>
  );
}

/* ------------------------------------------------------------------ the three parties */

function PartiesCard({
  entry,
  inq,
  partyName,
  model,
  modelSaved,
  status,
}: {
  entry: EntryDetail;
  inq: InquiryScalars;
  partyName: string | null;
  model: string;
  modelSaved: boolean;
  status: PaymentStatusSummary | undefined;
}) {
  const g = entry.guestProfile ?? entry.inquiry?.guestProfile ?? null;
  const contact = entry as EntryDetail & EntryContact;
  const guest = guestNameOf(g);
  const bookerKind = inq.travelAgentId
    ? "Travel agent"
    : inq.corporateAccountId
      ? "Company"
      : inq.sourceChannel === "OTA"
        ? "OTA"
        : inq.sourceChannel === "WALK_IN"
          ? "Walk-in"
          : "Direct";
  const advanceRule = !status
    ? null
    : status.requiredAmount === 0
      ? "no advance asked"
      : status.requirementBasis?.mode === "PERCENT"
        ? `advance ${status.requirementBasis.percent}%`
        : `advance ${money(status.requiredAmount)}`;
  const account = partyName ?? (bookerKind === "Direct" || bookerKind === "Walk-in" ? null : "the account");
  const billedTo =
    model === "GUEST_PAY" ? guest : model === "DIRECT_BILL" || model === "TOUR_OPERATOR_VOUCHER" ? (account ?? "the account") : words(model);
  return (
    <StepCard
      flow="parties"
      title="The three parties"
      summary={`${guest} · booked by ${partyName ?? (bookerKind === "Walk-in" ? "walk-in" : "the guest, direct")} · billed to ${billedTo}`}
    >
      <div className="grid3">
        <FactBox
          k="Guest"
          v={g?.id && g ? <Link href={`/guests/${g.id}`}>{guest}</Link> : <i>{inq.travelAgentId ? "to come from the agent" : inq.corporateAccountId ? "to come from the company" : "to be named"}</i>}
          meta={
            contact.contactPersonName
              ? `contact · ${contact.contactPersonName}${contact.contactPersonPhone ? ` · ${contact.contactPersonPhone}` : ""}`
              : (g?.email ?? g?.phone ?? "no contact of their own on file")
          }
        />
        <FactBox
          k="Booked by"
          v={partyName ?? (bookerKind === "Walk-in" ? "Walk-in" : "the guest, direct")}
          meta={[bookerKind, advanceRule].filter(Boolean).join(" · ")}
        />
        <FactBox k="Billed to" v={billedTo} meta={`${modelSaved ? "" : "not set yet · "}${(BILLING_WORD[model] ?? words(model)).toLowerCase()}`} />
      </div>
      {partyName && model === "GUEST_PAY" ? (
        <div className="meta" style={{ marginTop: 8 }}>
          Booked by {partyName}, billed to the guest — the account pays nothing on this booking.
        </div>
      ) : null}
    </StepCard>
  );
}

/* ------------------------------------------------------------------ the billing model */

function BillingModelCard({
  entry,
  editable,
  gm,
  model,
  setModel,
  savedModel,
  preselectedWhy,
  onChanged,
}: {
  entry: EntryDetail;
  editable: boolean;
  gm: boolean;
  model: string;
  setModel: (m: string) => void;
  savedModel: string | null;
  /** Why the model shown was chosen for the desk — null when the desk chose it. */
  preselectedWhy: string | null;
  onChanged: () => void;
}) {
  const { session } = useSession();
  const folio = entry.folio ?? null;
  const group = entry.groupBillingMode === "GROUP_MASTER";
  const options = useMemo(() => {
    const base: Array<readonly [string, string]> = BILLING_ORDER.map((k) => [k, BILLING_WORD[k]] as const);
    if (savedModel && !BILLING_WORD[savedModel]) base.push([savedModel, words(savedModel)] as const);
    return base;
  }, [savedModel]);
  // Setting the payer finishes the section — no Done to press after it (2026-10-28).
  const finish = useFinishWhenDone("billing-model");
  const save = useMutation({
    mutationFn: () => ensureProvisionalFolio(session!, entry.id, { billingModel: model }),
    onSuccess: () => {
      // Keyed on a model being SET, not on the folio existing — the folio opens at Set up with no
      // model, so the first choice read as a change (2026-09-18).
      toast.success(
        !folio ? "The provisional bill is open — the proforma is generated with it" : savedModel ? "The billing model is changed" : "The billing model is set",
      );
      onChanged();
      finish();
    },
    onError: (e) => toastRefusal(e, "The billing model could not be set"),
  });
  const dirty = !savedModel || model !== savedModel;
  // A payer changed and not saved keeps the section open, and holds the move (2026-10-28).
  useFlowUnsaved("billing-model", editable && !!savedModel && model !== savedModel, "Changes to who pays saved");
  const groupLock =
    group && !GROUP_FRIENDLY.has(model) && !gm ? "for a group, only the account or the voucher — anything else is the GM's call" : null;
  return (
    <StepCard
      flow="billing-model"
      title="Who pays"
      summary={savedModel ? (BILLING_WORD[savedModel] ?? words(savedModel)) : undefined}
      right={savedModel && !dirty ? <OnRecord /> : null}
      meta={
        <>
          Who the bill is made out to. It is chosen here, and can still be changed on the Stay step while the guest is staying.
          {preselectedWhy ? ` Pre-selected — ${preselectedWhy}; change it if they settle differently.` : ""}
          {group ? " A group has one bill for everyone." : ""}
          {folio ? "" : " The provisional bill opens with this choice, and the proforma with it."}
        </>
      }
    >
      <Choice options={options} value={model} onChange={editable ? setModel : undefined} disabled={!editable} />
      {folio ? (
        <div className="sm" style={{ marginTop: 6 }}>
          {FOLIO_WORD[folio.state] ?? `The bill is ${words(folio.state).toLowerCase()}.`}
        </div>
      ) : null}
      <Live>
        {editable && dirty ? (
          <div className="row-acts" style={{ marginTop: 10 }}>
            <Button
              compact
              // Green once it can be pressed — the act that finishes the section (2026-10-28, as at Inquiry).
              className={groupLock ? undefined : "go"}
              state={save.isPending ? "working" : groupLock ? "inert" : "default"}
              title={groupLock ?? undefined}
              workingLabel="Saving…"
              onClick={() => save.mutate()}
            >
              {!folio ? "Open the provisional bill" : savedModel ? "Change to this model" : "Set this model"}
            </Button>
            {savedModel ? (
              <Button kind="quiet" compact onClick={() => setModel(savedModel)}>
                Undo
              </Button>
            ) : null}
          </div>
        ) : null}
      </Live>
    </StepCard>
  );
}

/* ------------------------------------------------------------------ the committed hold */

function HoldCard({
  entry,
  editable,
  gm,
  tz,
  nowMs,
  roomIds,
  roomNos,
  anchorRoomId,
  defaultWhy,
  blockAsk,
  onChanged,
}: {
  entry: EntryDetail;
  editable: boolean;
  gm: boolean;
  tz: string;
  nowMs: number;
  roomIds: string[];
  roomNos: Map<string, string>;
  anchorRoomId: string | null;
  defaultWhy: string;
  /** A payment just came in: `until` is when it blocked the rooms to, `null` when it could not. */
  blockAsk: { until: string | null; n: number } | null;
  onChanged: () => void;
}) {
  const { session } = useSession();
  const { past } = useStepMode();
  const raw = entry.committedHold ?? null;
  // Holds are confirmed at Reserve, so at Set up a CONFIRMED hold is an earlier pass's, carried
  // through a re-entry that kept it (2026-10-13 — Complaint resolution from Check-in). Its rooms
  // stand on that pass's reservation, but Reserve wants a hold placed in THIS pass, and the card
  // had shown it as the current hold with Release (refused) — no way to place one. Looking back at
  // Set up from a later step, a confirmed hold is this pass's and reads as held.
  const carried = !past && raw?.state === "CONFIRMED" ? raw : null;
  const hold = raw && !carried && raw.state !== "RELEASED" && raw.state !== "EXPIRED" ? raw : null;
  const [placeOpen, setPlaceOpen] = useState(false);
  const [why, setWhy] = useState(defaultWhy);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);
  useEffect(() => {
    if (placeOpen) setWhy(defaultWhy);
  }, [placeOpen, defaultWhy]);

  /**
   * After a payment (2026-10-28, operator: "as soon as the payment is recorded it should take the
   * user to the committed hold section and ask if they wish to set a block time, otherwise it
   * blocks according to the system time — after paying an advance the guest by default commits
   * to a hold"). The payment blocked the rooms on the hotel's time (or this booking's own); the
   * card comes into view and asks whether to keep it. One that could not be placed just shows the
   * card, to block the rooms by hand.
   */
  const flow = useStepFlow();
  const [blockedUntil, setBlockedUntil] = useState<string | null>(null);
  /**
   * Once the block time is settled, the middle of the screen says so (2026-10-28, operator: "after
   * the user clicks Keep this time, or sets a block time, show a message saying these rooms are
   * blocked for the dates for this many hours").
   */
  const [blockedNote, setBlockedNote] = useState<StepMovedNote | null>(null);
  const sayBlocked = (untilIso: string | null, whose: "HOUSE" | "BOOKING" | null) => {
    if (!untilIso) return;
    const nights = entry.checkInDate && entry.checkOutDate ? nightsBetween(entry.checkInDate, entry.checkOutDate) : null;
    setBlockedNote({
      title: `${count > 1 ? "The rooms are" : "The room is"} blocked`,
      who: `${rooms} · ${fmtRange(entry.checkInDate, entry.checkOutDate)}${nights ? ` · ${plural(nights, "night")}` : ""}`,
      next: `Blocked for ${forHowLong(untilIso, Date.now())} — until ${fmtDateTime(untilIso, tz)}${whose === "BOOKING" ? ", the time set for this booking" : whose === "HOUSE" ? ", the hotel's time" : ""}. If the booking is not reserved by then, ${count > 1 ? "they go" : "it goes"} back on sale.`,
    });
  };
  useEffect(() => {
    if (!blockAsk) return;
    if (flow.on) flow.open("hold");
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => goToStepCard("hold")));
    if (blockAsk.until) setBlockedUntil(blockAsk.until);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockAsk?.n]);

  // The house's own window, so the card can say what it gives beside a time set for one booking.
  const house = useQuery({
    queryKey: ["hold-window"],
    queryFn: () => getHoldWindow(session!),
    enabled: !!session,
    staleTime: 600_000,
  }).data ?? null;
  const ownTime = entry.holdExpiresAtOverride ?? null;

  const finish = useFinishWhenDone("hold");
  const place = useMutation({
    mutationFn: () => {
      if (!anchorRoomId) throw new Error("Choose the rooms at Inquiry first");
      return placeCommittedHold(session!, entry.id, { roomId: anchorRoomId, commercialJustification: why.trim() });
    },
    onSuccess: (h) => {
      setPlaceOpen(false);
      sayBlocked(h.expiresAt, ownTime ? "BOOKING" : "HOUSE");
      onChanged();
      finish();
    },
    onError: (e) => toastRefusal(e, "The rooms could not be held"),
  });
  const release = useMutation({
    mutationFn: (reason: string) => releaseCommittedHold(session!, entry.id, { releaseReason: reason }),
    onSuccess: () => {
      toast.success("The hold is released — the rooms are back on sale");
      setReleaseOpen(false);
      onChanged();
    },
    onError: (e) => toastRefusal(e, "The hold could not be released"),
  });

  // Mirrors the backend's manual-hold gate (2026-09-18): the advance satisfied, OR any of it
  // received, OR the FOM's credit extension. With none of the three the click is refused.
  const payment = usePaymentStatus(entry.id, { enabled: !!entry.folio }).data ?? null;
  const moneyLock = payment && !payment.satisfied && payment.totalReceived <= 0 && !payment.creditExtensionActive;
  const placeLock = !anchorRoomId
    ? "choose the rooms at Inquiry first"
    : !entry.folio?.billingModel
      ? "set the billing model first"
      : !entry.cancellationDisclosure
        ? "record that the terms were disclosed first"
        : moneyLock
          ? "the advance, or part of it, has to come in first — or the FOM extends credit"
          : null;
  const rooms = roomsWord(roomIds.length ? roomIds : hold?.roomId ? [hold.roomId] : [], roomNos);
  const houseWords = house ? (house.minutes % 60 === 0 && house.minutes >= 60 ? plural(house.minutes / 60, "hour") : plural(house.minutes, "minute")) : null;
  const count = roomIds.length || 1;
  const lapsing = hold ? new Date(hold.expiresAt).getTime() < nowMs : false;
  const why_ = hold?.commercialJustification ?? "";
  const autoWord = why_.startsWith("Auto-held on advance payment")
    ? "held automatically when the advance came in"
    : why_.startsWith("Auto-held on proforma dispatch")
      ? "held automatically when the proforma was sent"
      : null;

  return (
    <StepCard
      flow="hold"
      flowAfter="proforma"
      title="The committed hold"
      summary={hold ? `${rooms} blocked until ${fmtDateTime(hold.expiresAt, tz)}` : undefined}
      acts={
        past ? undefined : (
          <Live>
            <SeeRow
              label="Set block time"
              note={
                ownTime
                  ? `blocked to ${fmtDateTime(ownTime, tz)} — set for this booking`
                  : `the hotel blocks for ${houseWords ?? "its own time"} — set this booking's own time`
              }
              onClick={editable ? () => setTimeOpen(true) : undefined}
              reason={editable ? undefined : "not at this step"}
            />
            {hold ? (
              <SeeRow
                label="Release"
                note="frees the rooms with a reason — they return to sale"
                onClick={editable && gm ? () => setReleaseOpen(true) : undefined}
                reason={!editable ? "not at this step" : gm ? undefined : "releasing a committed hold is the GM's call"}
              />
            ) : (
              <SeeRow
                kind="secondary"
                label="Block the rooms"
                note="with the reason these rooms are blocked — a block needs one"
                onClick={editable && !placeLock ? () => setPlaceOpen(true) : undefined}
                reason={!editable ? "not at this step" : (placeLock ?? undefined)}
              />
            )}
          </Live>
        )
      }
    >
      {hold ? (
        <>
          <BindingBox family={lapsing ? "provisional" : "pending"} stateWord={lapsing ? "hold time passed" : "committed hold"}>
            <div className="sm" style={{ paddingRight: 110 }}>
              {rooms} blocked until <b>{fmtDateTime(hold.expiresAt, tz)}</b> · takes the rooms from anyone else&rsquo;s marker
            </div>
          </BindingBox>
          <Facts wide style={{ marginTop: 8 }}>
            <Fact k="Why held" meta={autoWord ?? undefined}>
              {why_ || <span className="warn-ink">no reason recorded</span>}
            </Fact>
            <Fact k="Placed">{fmtStamp(hold.placedAt, tz)}</Fact>
            <Fact
              k="Block time"
              meta={ownTime ? `set for this booking${houseWords ? ` · the hotel blocks for ${houseWords}` : ""}` : undefined}
            >
              {ownTime ? `to ${fmtDateTime(ownTime, tz)}` : houseWords ? `the hotel's ${houseWords}` : null}
            </Fact>
          </Facts>
          {lapsing ? (
            <div className="sm warn-ink" style={{ marginTop: 6 }}>
              The block time has passed — the block lapses on the next sweep. Block the rooms again before Reserve.
            </div>
          ) : null}
        </>
      ) : (
        <>
          {carried ? (
            <p className="warn-ink" style={{ margin: "0 0 6px", fontWeight: 700 }} role="status">
              {rooms} {roomIds.length > 1 ? "are" : "is"} still kept for this booking by the reservation from an earlier pass. This pass needs its own block before Reserve — block the rooms again.
            </p>
          ) : null}
          <span className="meta">
            {carried
              ? `The earlier hold was placed ${fmtStamp(carried.placedAt, tz)}.`
              : raw
              ? `The last block ${raw.state === "EXPIRED" ? "ran out" : "was released"} — block the rooms again before Reserve.`
              : "Not blocked yet."}
            {!carried && !raw ? (
              <Help label="How the rooms are blocked">
                Recording an advance payment — even part of it — blocks {count === 1 ? "the room" : `all ${count} rooms`} automatically. Block them
                by hand when the rooms should be kept before any money arrives.
              </Help>
            ) : null}
          </span>
          {ownTime ? (
            <div className="sm" style={{ marginTop: 6 }}>
              When the rooms are blocked, the block runs to <b>{fmtDateTime(ownTime, tz)}</b> — set for this booking
              {houseWords ? `, not the hotel's ${houseWords}` : ""}.
            </div>
          ) : null}
        </>
      )}

      {placeOpen ? (
        <DsDialog
          open
          onClose={() => setPlaceOpen(false)}
          busy={place.isPending}
          title="Block the rooms"
          caseLines={[`${rooms} · ${fmtRange(entry.checkInDate, entry.checkOutDate)}`]}
          footer={
            <>
              <Button kind="quiet" state={place.isPending ? "inert" : "default"} onClick={() => setPlaceOpen(false)}>
                Not now
              </Button>
              <Button
                icon="lock"
                state={place.isPending ? "working" : why.trim() ? "default" : "inert"}
                title={why.trim() ? undefined : "write why the rooms are blocked"}
                workingLabel="Blocking…"
                onClick={() => place.mutate()}
              >
                Block the rooms
              </Button>
            </>
          }
        >
          <p className="sm">The rooms are taken from anyone else&rsquo;s marker. The first block wins.</p>
          <div className="field">
            <label>
              Why these rooms are blocked for this booking
              <Help label="About the reason">The reason recorded against the block. It runs for the hotel&rsquo;s time, or the block time set for this booking.</Help>
            </label>
            <textarea className="input" rows={2} value={why} onChange={(e) => setWhy(e.target.value)} autoFocus />
          </div>
        </DsDialog>
      ) : null}
      {blockedUntil && !timeOpen ? (
        <DsDialog
          open
          onClose={() => setBlockedUntil(null)}
          title="The rooms are blocked"
          caseLines={[`${rooms} · until ${fmtDateTime(blockedUntil, tz)}`]}
          help="The payment blocked the rooms. They stay blocked until this time; if the booking is not reserved by then, they go back on sale."
          footer={
            <>
              <Button
                kind="secondary"
                onClick={() => {
                  const until = blockedUntil;
                  setBlockedUntil(null);
                  sayBlocked(until, ownTime ? "BOOKING" : "HOUSE");
                }}
              >
                Keep this time
              </Button>
              <Button
                icon="clock"
                onClick={() => {
                  setBlockedUntil(null);
                  setTimeOpen(true);
                }}
              >
                Set block time
              </Button>
            </>
          }
        >
          <p className="sm">
            The advance came in, so {rooms} {count > 1 ? "are" : "is"} blocked until <b>{fmtDateTime(blockedUntil, tz)}</b> —{" "}
            {ownTime ? "the block time set for this booking" : houseWords ? `the hotel's ${houseWords}` : "the hotel's own time"}. Set a different
            block time?
          </p>
        </DsDialog>
      ) : null}
      {timeOpen ? (
        <HoldTimeDialog
          entry={entry}
          tz={tz}
          houseWords={houseWords}
          currentIso={hold?.expiresAt ?? blockAsk?.until ?? ownTime ?? null}
          hasOwnTime={!!ownTime}
          holdLive={!!hold || !!blockAsk?.until}
          onClose={() => setTimeOpen(false)}
          onChanged={onChanged}
          onSet={(until, whose, live) => {
            if (live) sayBlocked(until, whose);
          }}
        />
      ) : null}
      <ReasonDialog
        open={releaseOpen}
        danger
        onClose={() => setReleaseOpen(false)}
        busy={release.isPending}
        title="Release the committed hold"
        caseLines={hold ? [`${rooms} held until ${fmtDateTime(hold.expiresAt, tz)}`] : undefined}
        lead="The rooms go back on sale at once. This booking keeps its place at Set up and needs a new hold before Reserve."
        confirmLabel="Release"
        placeholder="why the rooms are freed"
        onConfirm={(r) => release.mutate(r)}
      />
      <StepMoved note={blockedNote} onClose={() => setBlockedNote(null)} />
    </StepCard>
  );
}

/**
 * "1 hour", "2 hours 30 minutes", "3 days 4 hours" — how long from now to a moment. Over an hour it
 * is rounded to 5 minutes: a time typed without seconds, three hours on, read "2 hours 59 minutes".
 * The exact moment is printed beside it.
 */
function forHowLong(untilIso: string, nowMs: number): string {
  const exact = Math.max(0, Math.round((new Date(untilIso).getTime() - nowMs) / 60_000));
  if (exact < 60) return plural(exact, "minute");
  const mins = Math.round(exact / 5) * 5;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours < 48) return rest ? `${plural(hours, "hour")} ${plural(rest, "minute")}` : plural(hours, "hour");
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${plural(days, "day")} ${plural(h, "hour")}` : plural(days, "day");
}

/** Nights between two stay dates (both stored at the start of their day). */
function nightsBetween(a: string, b: string): number | null {
  const n = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
  return n > 0 ? n : null;
}

/**
 * "Hold the rooms until six" — this booking's own hold time (2026-09-25, operator request).
 *
 * The day and time are the HOTEL's wall clock: what is typed here is what the hotel's clock will
 * read, whatever the desk machine's timezone is set to, because the server reads it in the
 * hotel's zone. The moment is kept on the booking, so a hold placed again later — after a
 * re-entry, or after one lapsed — runs to it instead of the house window.
 */
function HoldTimeDialog({
  entry,
  tz,
  houseWords,
  currentIso,
  hasOwnTime,
  holdLive,
  onClose,
  onChanged,
  onSet,
}: {
  entry: EntryDetail;
  tz: string;
  houseWords: string | null;
  currentIso: string | null;
  hasOwnTime: boolean;
  holdLive: boolean;
  onClose: () => void;
  onChanged: () => void;
  /** What the block now runs to, whose time that is, and whether a block stands now. */
  onSet?: (until: string | null, whose: "BOOKING" | "HOUSE", live: boolean) => void;
}) {
  const { session } = useSession();
  const seed = hotelFormParts(currentIso ?? new Date(Date.now() + 60 * 60_000).toISOString(), tz);
  const [date, setDate] = useState(seed.date);
  const [time, setTime] = useState(seed.time);
  const [why, setWhy] = useState("");

  const save = useMutation({
    mutationFn: (clear: boolean) =>
      setCommittedHoldExpiry(session!, entry.id, clear ? { clear: true, reason: why.trim() || undefined } : { date, time, reason: why.trim() || undefined }),
    onSuccess: (out) => {
      // A block standing now is said in the middle of the screen; one still to be placed, or a note
      // from the server, keeps its toast.
      if (!out.holdUpdated || out.note) {
        toast.success(
          out.source === "BOOKING"
            ? `The rooms are blocked until ${fmtDateTime(out.heldUntil, tz)}${out.holdUpdated ? "" : " — from the moment they are blocked"}`
            : "Back to the hotel's time",
          out.note ? { description: out.note, duration: 8000 } : undefined,
        );
      }
      onClose();
      onSet?.(out.heldUntil, out.source, out.holdUpdated);
      onChanged();
    },
    onError: (e) => toastRefusal(e, "The block time was not changed"),
  });

  const typed = date && time;
  return (
    <DsDialog
      open
      onClose={onClose}
      busy={save.isPending}
      width={560}
      title="Set block time"
      caseLines={[entry.id, houseWords ? `the hotel blocks for ${houseWords}` : "the hotel's own time"]}
      footer={
        <>
          <Button kind="quiet" state={save.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          {hasOwnTime ? (
            <Button kind="quiet" state={save.isPending ? "inert" : "default"} onClick={() => save.mutate(true)}>
              Back to the hotel&rsquo;s time
            </Button>
          ) : null}
          <Button
            icon="clock"
            state={save.isPending ? "working" : typed ? "default" : "inert"}
            title={typed ? undefined : "give the day and the time"}
            workingLabel="Setting…"
            onClick={() => save.mutate(false)}
          >
            Block until this time
          </Button>
        </>
      }
    >
      {holdLive ? <p className="sm">The block standing now moves to this time.</p> : null}
      <div className="form2" style={{ marginTop: holdLive ? 10 : 0 }}>
        <div className="field">
          <label>
            Blocked until · day
            <Help label="About the block time">
              The guest who says they will confirm by six gets until six. This booking remembers the time, so the rooms blocked again later stay
              blocked to it. It cannot run past the day they arrive.
            </Help>
          </label>
          <DateInput className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="field">
          <label>
            Blocked until · time
            <Help label="About the time">On the hotel&rsquo;s clock.</Help>
          </label>
          <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
        <div className="wide field">
          <label>Why, if it is worth saying · optional</label>
          <input className="input" value={why} onChange={(e) => setWhy(e.target.value)} placeholder="the guest rang — they confirm after their flight lands" />
        </div>
      </div>
    </DsDialog>
  );
}

/* ------------------------------------------------------------------ the terms disclosed */

function TermsCard({
  entry,
  editable,
  tz,
  status,
  onAskAdvance,
  onChanged,
}: {
  entry: EntryDetail;
  editable: boolean;
  tz: string;
  /** What the guest is asked to pay — the advance question after the terms reads it. */
  status: PaymentStatusSummary | undefined;
  /** "Yes, ask for an advance": open the payment plan's amount box. */
  onAskAdvance: () => void;
  onChanged: () => void;
}) {
  const { session } = useSession();
  const { past } = useStepMode();
  const d = entry.cancellationDisclosure ?? null;
  const [open, setOpen] = useState(false);
  // Once the terms are recorded and nothing is asked of the guest yet, the desk is asked whether
  // the hotel wants an advance (2026-10-28, operator: "after finishing the terms it takes the user
  // directly to the committed hold … it can prompt the user if the hotel wishes to impose advance
  // payment; if no, take the user to the committed hold; if yes, to the payment plan").
  const [askAdvance, setAskAdvance] = useState(false);
  const nothingAsked =
    !!status && status.requiredAmount === 0 && (status.totalReceived ?? 0) === 0 && !status.creditExtensionActive;
  // The terms the rooms were booked on carry from the booking they were split off (2026-10-14).
  const [statement, setStatement] = useState(entry.carryOver?.cancellation?.noShowTreatmentStatement || DEFAULT_NO_SHOW);
  const finish = useFinishWhenDone("terms");
  const record = useMutation({
    mutationFn: () =>
      recordCancellationDisclosure(session!, entry.id, {
        noShowTreatmentStatement: statement.trim(),
        disclosedTerms: { tier: "DEFAULT" },
      }),
    onSuccess: () => {
      toast.success("The terms are on record as disclosed");
      setOpen(false);
      onChanged();
      if (nothingAsked) setAskAdvance(true);
      else finish();
    },
    onError: (e) => toastRefusal(e, "The disclosure could not be recorded"),
  });
  return (
    <StepCard
      flow="terms"
      flowAfter="billing-model"
      title="Terms disclosed"
      summary={d ? `The hotel's standard terms · disclosed ${fmtStamp(d.disclosedAt, tz)}` : undefined}
      acts={
        d || past ? undefined : (
          <Live>
            <SeeRow
              kind="secondary"
              label="Record that the terms were disclosed"
              note="the no-show treatment in the words the guest was given — Reserve is refused without it"
              onClick={editable ? () => setOpen(true) : undefined}
              reason={editable ? undefined : "not at this step"}
            />
          </Live>
        )
      }
    >
      <Facts wide>
        <Fact k="Cancellation">the hotel&rsquo;s standard terms — the charge follows the notice given</Fact>
        <Fact k="No-show">{d ? d.noShowTreatmentStatement : statement}</Fact>
        <Fact k="Disclosed">
          {d ? (
            <Chip tone="success" icon="check">
              {fmtStamp(d.disclosedAt, tz)}
            </Chip>
          ) : (
            <>
              <Chip tone="warning">not yet</Chip>
              <Help label="About the disclosure">The booking keeps a disclosure record before Reserve.</Help>
            </>
          )}
        </Fact>
      </Facts>
      {open ? (
        <DsDialog
          open
          onClose={() => setOpen(false)}
          busy={record.isPending}
          title="Terms disclosed"
          caseLines={["Cancellation · the hotel's standard terms"]}
          help="The record keeps the words, who recorded them, and when." 
          footer={
            <>
              <Button kind="quiet" state={record.isPending ? "inert" : "default"} onClick={() => setOpen(false)}>
                Not now
              </Button>
              <Button
                state={record.isPending ? "working" : statement.trim() ? "default" : "inert"}
                title={statement.trim() ? undefined : "the no-show treatment is needed"}
                workingLabel="Recording…"
                onClick={() => record.mutate()}
              >
                Record the disclosure
              </Button>
            </>
          }
        >
          <div className="field">
            <label>The no-show treatment, as the guest was told</label>
            <textarea className="input" rows={2} value={statement} onChange={(e) => setStatement(e.target.value)} autoFocus />
          </div>
        </DsDialog>
      ) : null}
      {askAdvance ? (
        <DsDialog
          open
          // Closed without an answer: nothing is asked, so the work goes on to the hold as with No.
          onClose={() => {
            setAskAdvance(false);
            finish();
          }}
          title="Ask the guest for an advance?"
          caseLines={["Nothing is asked now · the hotel's settings ask for no advance"]}
          help="With an advance, the guest pays it before the booking is reserved and the proforma shows the amount. With none, the rooms are blocked next."
          footer={
            <>
              <Button
                kind="secondary"
                onClick={() => {
                  setAskAdvance(false);
                  finish();
                }}
              >
                No advance
              </Button>
              <Button
                onClick={() => {
                  setAskAdvance(false);
                  finish({ next: "money" });
                  onAskAdvance();
                }}
              >
                Yes, ask for an advance
              </Button>
            </>
          }
        >
          <p className="sm">Does the hotel want an advance on this booking?</p>
        </DsDialog>
      ) : null}
    </StepCard>
  );
}

/* ------------------------------------------------------------------ the proforma */

function ProformaCard({
  entry,
  editable,
  tz,
  proformas,
  current,
  status,
  passStart,
  answered,
  onChanged,
}: {
  entry: EntryDetail;
  editable: boolean;
  tz: string;
  proformas: InvoiceSummary[];
  current: InvoiceSummary | null;
  status: PaymentStatusSummary | undefined;
  passStart: string | null;
  /** The guest's answer to this pass's proforma is on record. */
  answered: boolean;
  onChanged: () => void;
}) {
  const { session } = useSession();
  const passes = passesOf(entry);
  const [paper, setPaper] = useState<PaperRef | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  // The proforma is made out to the agency or company when one booked, so it goes to their
  // address, never the traveller's by default (2026-09-18) — the backend applies the same rule.
  const [to, setTo] = useSendTo(entry);
  const finish = useFinishWhenDone("proforma");

  const draft = proformas.find((i) => i.state === "DRAFT") ?? null;
  const sendTarget = draft ?? proformas[0] ?? null;
  const send = useMutation({
    mutationFn: () => {
      if (!sendTarget) throw new Error("There is no proforma to send");
      return dispatchInvoice(session!, sendTarget.id, { dispatchedTo: to.trim() || undefined });
    },
    onSuccess: () => {
      toast.success("The proforma is sent — record the guest's answer when it comes");
      setSendOpen(false);
      setJustSent(true);
      onChanged();
    },
    onError: (e) => toastRefusal(e, "The proforma could not be sent"),
  });

  const pdf = (id: string) => {
    if (!session) return;
    openInvoicePdf(session, id).catch((e) => toastRefusal(e, "The PDF could not be opened"));
  };

  const sentLive = proformas.some((i) => i.state !== "SUPERSEDED" && i.dispatchedAt != null);
  // Once it has gone out the guest's answer is owed whether or not an advance is asked — Reserve
  // waits for it too (Policy 40) — so the answer box stands out from then on (2026-10-28).
  const answerDue = editable && sentLive && !answered;
  // After a send the page goes to the answer box and it flashes, so the next act is seen.
  const answerRef = useRef<HTMLDivElement | null>(null);
  const [justSent, setJustSent] = useState(false);
  useEffect(() => {
    if (!justSent || !answerDue || !answerRef.current) return;
    setJustSent(false);
    revealCard(answerRef.current);
  }, [justSent, answerDue]);

  if (proformas.length === 0) {
    return (
      <StepCard
        flow="proforma"
        flowAfter="terms"
        title="Proforma"
        icon="file"
        meta="Generated together with the provisional bill. Not a tax invoice; the tax invoice is issued at check-out."
      >
        <span className="sm">Set the billing model above — the proforma is generated with it.</span>
      </StepCard>
    );
  }

  const shown = current ?? proformas[0];
  const no = shown.invoiceNumber ?? shown.id;
  const basis = status?.requirementBasis ?? null;
  const asks = !status
    ? null
    : status.requiredAmount > 0
      ? `asks for ${basis?.mode === "PERCENT" ? `${basis.percent}% · ` : ""}${money(status.requiredAmount)}`
      : "asks for no advance";
  // Money is taken only against a proforma the guest has, and after their answer (the backend's
  // bill-before-money and answer-before-money rules): while an advance is asked, the card says
  // which comes first, and Send is the main act (2026-10-28).
  const advanceAsked = !!status && status.requiredAmount > 0 && !status.paidInFull;
  const nextUp = !editable ? null : advanceAsked && !sentLive ? "send" : answerDue ? "answer" : null;
  const sendLock = !editable
    ? "not at this step"
    : !draft
      ? shown.dispatchedAt
        ? "already sent — a changed amount or plan issues a new version to send"
        : "no proforma is ready to send"
      : null;
  const docRef = (inv: InvoiceSummary): PaperRef => {
    const old = inv.state === "SUPERSEDED" || (current != null && inv.id !== current.id);
    const kept = inv.pdfStorageKey != null || inv.dispatchedAt != null;
    return {
      kind: "invoice",
      id: inv.id,
      label: `Proforma ${inv.invoiceNumber ?? inv.id}${(inv.versionNumber ?? 1) > 1 ? ` · v${inv.versionNumber}` : ""}`,
      frozen: old && kept,
      notice:
        old && !kept
          ? "A replaced version that was never rendered or sent — no copy was kept, so this is rebuilt from the booking's current figures."
          : undefined,
    };
  };

  return (
    <StepCard
      // The POPULATED card carried no flow key, so once a proforma existed the card lost its
      // anchor: the side panel's "To do here" jump and any "go to the proforma" button found
      // nothing to scroll to (2026-10-06). The empty-state card above always had it.
      flow="proforma"
      flowAfter="terms"
      // The number is in the title; the line says where the bill stands.
      summary={[
        asks,
        shown.dispatchedAt ? `sent ${fmtStamp(shown.dispatchedAt, tz)}` : "not sent",
        shown.dispatchedAt ? (answered ? "the guest's answer recorded" : "the guest's answer awaited") : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      title={`Proforma · ${no}${(shown.versionNumber ?? 1) > 1 ? ` · v${shown.versionNumber}` : ""}`}
      icon="file"
      right={asks ? <Chip tone="quiet">{asks}</Chip> : null}
      meta="Not a tax invoice — the tax invoice is issued at check-out. Sending is optional, unless money is to be taken against it: a payment is logged against the bill the guest received."
      acts={
        <>
          <Button kind="secondary" compact icon="eye" onClick={() => setPaper(docRef(shown))}>
            Preview
          </Button>
          <Live>
            <Button
              kind={nextUp === "send" && !sendLock ? "primary" : "quiet"}
              compact
              icon="send"
              state={sendLock ? "inert" : "default"}
              title={sendLock ?? undefined}
              onClick={() => setSendOpen(true)}
            >
              {shown.dispatchedAt && draft ? "Send the new version" : "Send"}
            </Button>
          </Live>
          <Button kind="quiet" compact icon="file" onClick={() => pdf(shown.id)}>
            PDF
          </Button>
        </>
      }
    >
      {nextUp === "send" ? (
        <div className="notice next" role="status">
          <span>
            <b>Send this proforma to the guest first.</b> The advance of {money(status!.requiredAmount)} can be recorded once they have it.
          </span>
        </div>
      ) : null}
      <div className="meta">
        Generated {fmtStamp(shown.createdAt, tz)}
        {shown.dispatchedAt ? ` · sent ${fmtStamp(shown.dispatchedAt, tz)}${shown.dispatchedTo ? ` to ${shown.dispatchedTo}` : ""}` : " · not sent"}
      </div>

      {answerDue ? (
        // Sent and not yet answered: the answer is the next thing to do here (2026-10-28, operator:
        // "make it prominent on the page that it needs the guest's answer as well").
        <div ref={answerRef} className="answer-due" role="status">
          <span className="due-head">
            The guest&rsquo;s answer is needed
            <Help label="About the answer">
              Write down how the guest answered the proforma — by message or by telling the desk — and what they said.
            </Help>
          </span>
          <span className="sm">
            {advanceAsked
              ? `The advance of ${money(status!.requiredAmount)} can be recorded only after it.`
              : "The booking cannot be reserved until it is recorded."}
          </span>
          <AnswerLine
            entryId={entry.id}
            type="PROFORMA_INVOICE"
            sinceIso={passStart}
            what="the proforma"
            tz={tz}
            prominent
            // With an advance asked the money is next, so the page goes to the payment plan.
            onAnswered={() => finish(advanceAsked ? { next: "money" } : undefined)}
          />
        </div>
      ) : (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)", display: "grid", gap: 6 }}>
          <span className="sm" style={{ fontWeight: 600 }}>
            The guest&rsquo;s answer
            <Help label="About the answer">Needed before Reserve once the proforma has been sent.</Help>
          </span>
          <AnswerLine entryId={entry.id} type="PROFORMA_INVOICE" sinceIso={passStart} what="the proforma" tz={tz} onAnswered={finish} />
        </div>
      )}

      {proformas.length > 1 ? (
        <table className="table compact" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Version</th>
              {passes.many ? <th>Pass</th> : null}
              <th>Standing</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {proformas.map((inv) => {
              const isCurrent = current != null && inv.id === current.id;
              const passNo = passes.numberAt(inv.createdAt);
              return (
                <tr key={inv.id} className="static" style={isCurrent ? undefined : { opacity: 0.7 }}>
                  <td>
                    {inv.invoiceNumber ?? inv.id} · v{inv.versionNumber ?? 1}
                    <span className="sub">{fmtStamp(inv.createdAt, tz)}</span>
                  </td>
                  {passes.many ? <td>{passNo != null ? `Pass ${passNo}${passNo === passes.currentNumber ? " · now" : ""}` : "earlier"}</td> : null}
                  <td>
                    <Chip tone={isCurrent ? "success" : "quiet"}>{isCurrent ? "current" : "replaced"}</Chip>{" "}
                    <span className="meta">
                      {inv.dispatchedAt ? "sent" : inv.state === "DRAFT" ? "ready to send" : words(inv.state).toLowerCase()}
                    </span>
                  </td>
                  <td>
                    <div className="row-acts" style={{ justifyContent: "flex-end" }}>
                      <Button kind="quiet" compact icon="eye" onClick={() => setPaper(docRef(inv))}>
                        Preview
                      </Button>
                      <Button kind="quiet" compact icon="file" onClick={() => pdf(inv.id)}>
                        PDF
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
      {sendOpen && sendTarget ? (
        <DsDialog
          open
          onClose={() => setSendOpen(false)}
          busy={send.isPending}
          title={`Send proforma ${sendTarget.invoiceNumber ?? sendTarget.id}`}
          caseLines={[
            asks ? `It ${asks}` : "The advance it asks for is being read",
            "Once it goes out, the guest's answer is needed before money is logged",
          ]}
          footer={
            <>
              <Button kind="quiet" state={send.isPending ? "inert" : "default"} onClick={() => setSendOpen(false)}>
                Not now
              </Button>
              <Button kind="secondary" icon="print" onClick={() => pdf(sendTarget.id)}>
                Print instead
              </Button>
              <Button icon="send" state={send.isPending ? "working" : "default"} workingLabel="Sending…" onClick={() => send.mutate()}>
                Send now
              </Button>
            </>
          }
        >
          <SendToField entry={entry} value={to} onChange={setTo} label="Email address" />
        </DsDialog>
      ) : null}
    </StepCard>
  );
}

/* ------------------------------------------------------------------ groups and companies */

function CoordinatorCard({ entry, editable, inq, onChanged }: { entry: EntryDetail; editable: boolean; inq: InquiryScalars; onChanged: () => void }) {
  const { session } = useSession();
  const { past } = useStepMode();
  const contact = entry as EntryDetail & EntryContact;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState("");
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const confirm = useMutation({
    mutationFn: () => confirmCoordinator(session!, entry.id, { coordinatorName: name.trim(), authorityScope: scope.trim() }),
    onSuccess: () => {
      toast.success(`${name.trim()} is the coordinator`);
      setConfirmed(name.trim());
      setOpen(false);
      onChanged();
    },
    onError: (e) => toastRefusal(e, "The coordinator could not be confirmed"),
  });
  const ok = name.trim().length > 0 && scope.trim().length > 0;
  return (
    <StepCard
      title={entry.useType === "CORPORATE" ? "The company's coordinator" : "The coordinator"}
      right={confirmed ? <OnRecord word={`confirmed · ${confirmed}`} /> : null}
      acts={
        past ? undefined : (
          <Live>
            <SeeRow
              kind={confirmed ? "quiet" : "secondary"}
              label={confirmed ? "Change the coordinator" : "Confirm the coordinator"}
              note="their name, and the authority they carry for this booking"
              onClick={
                editable
                  ? () => {
                      setName(inq.corporateCoordinator ?? contact.contactPersonName ?? "");
                      setScope("this booking");
                      setOpen(true);
                    }
                  : undefined
              }
              reason={editable ? undefined : "not at this step"}
            />
          </Live>
        )
      }
    >
      <HelpHere label="About the coordinator">
        Who answers for this {entry.useType === "CONFERENCE" ? "conference" : entry.useType === "CORPORATE" ? "company's booking" : "group"} — the
        booking asks for a name before Reserve.
      </HelpHere>
      {open ? (
        <DsDialog
          open
          onClose={() => setOpen(false)}
          busy={confirm.isPending}
          title={entry.useType === "CORPORATE" ? "The company's coordinator" : "The coordinator"}
          footer={
            <>
              <Button kind="quiet" state={confirm.isPending ? "inert" : "default"} onClick={() => setOpen(false)}>
                Not now
              </Button>
              <Button
                state={confirm.isPending ? "working" : ok ? "default" : "inert"}
                title={ok ? undefined : "a name and their authority"}
                workingLabel="Confirming…"
                onClick={() => confirm.mutate()}
              >
                Confirm
              </Button>
            </>
          }
        >
          <div className="form2">
            <div className="field">
              <label>Name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </div>
            <div className="field">
              <label>Their authority</label>
              <input className="input" value={scope} onChange={(e) => setScope(e.target.value)} placeholder="this booking" />
            </div>
          </div>
        </DsDialog>
      ) : null}
    </StepCard>
  );
}

function FocCard({ entry, editable, gm, onChanged }: { entry: EntryDetail; editable: boolean; gm: boolean; onChanged: () => void }) {
  const { session } = useSession();
  const { past } = useStepMode();
  const approve = useMutation({
    mutationFn: () => approveFocGm(session!, entry.id, {}),
    onSuccess: () => {
      toast.success("The GM's approval of the free rooms is on record");
      onChanged();
    },
    onError: (e) => toastRefusal(e, "The approval could not be recorded"),
  });
  return (
    <StepCard
      title="Free-of-charge rooms"
      right={
        approve.isSuccess ? (
          <Chip tone="success" icon="check">
            approved by the GM
          </Chip>
        ) : (
          <Chip tone="warning">needs the GM</Chip>
        )
      }
      acts={
        past ? undefined : (
          <Live>
            <SeeRow
              kind="secondary"
              label="GM approves"
              note="records the GM's approval the Reserve gate asks for"
              onClick={editable && gm && !approve.isSuccess ? () => approve.mutate() : undefined}
              state={approve.isPending ? "working" : undefined}
              reason={!editable ? "not at this step" : !gm ? "free rooms are the GM's call" : approve.isSuccess ? "already approved" : undefined}
            />
          </Live>
        )
      }
    >
      <div className="sm">
        {plural(entry.numberOfRooms ?? 1, "room")} in the group
        <Help label="About free rooms">
          A free room is still a room out of the house&rsquo;s inventory, so a group&rsquo;s free rooms need the GM. The approval is kept on the
          booking&rsquo;s history.
        </Help>
      </div>
    </StepCard>
  );
}

function MilestonesCard({ entry, editable, onChanged }: { entry: EntryDetail; editable: boolean; onChanged: () => void }) {
  const { session } = useSession();
  const { past } = useStepMode();
  // The templates the hotel has configured (2026-09-18) — the card offered a free-text "DEFAULT"
  // the config never held, so scheduling could only fail with "Unknown templateKey".
  const templatesQuery = useQuery({
    queryKey: ["payment-milestone-templates"],
    queryFn: () => listPaymentMilestoneTemplates(session!),
    enabled: !!session,
  });
  const templates = templatesQuery.data?.templates ?? [];
  const [template, setTemplate] = useState("");
  useEffect(() => {
    if (!template && templates[0]) setTemplate(templates[0].key);
  }, [templates, template]);
  const noTemplates = templatesQuery.isSuccess && templates.length === 0;
  const schedule = useMutation({
    mutationFn: () => schedulePaymentMilestones(session!, entry.id, { templateKey: template.trim() }),
    onSuccess: () => {
      toast.success("The payment milestones are scheduled");
      onChanged();
    },
    onError: (e) => toastRefusal(e, "The milestones could not be scheduled"),
  });
  return (
    <StepCard
      title="Payment milestones"
      right={schedule.isSuccess ? <OnRecord word="scheduled" /> : null}
      acts={
        past ? undefined : (
          <Live>
            <SeeRow
              kind="secondary"
              label="Schedule the milestones"
              note="the dates the company pays, from the template — each one runs on its own clock"
              onClick={editable && !noTemplates && template.trim() && !schedule.isSuccess ? () => schedule.mutate() : undefined}
              state={schedule.isPending ? "working" : undefined}
              reason={
                !editable
                  ? "not at this step"
                  : noTemplates
                    ? "no payment-milestone templates are set up yet — an admin adds them in the configuration (paymentMilestone.scheduleTemplates)"
                    : !template.trim()
                      ? "choose the template"
                      : schedule.isSuccess
                        ? "already scheduled"
                        : undefined
              }
            />
          </Live>
        )
      }
    >
      <div className="field" style={{ maxWidth: 360 }}>
        <label>
          Template
          <Help label="About payment stages">A company or conference booking pays in stages.</Help>
        </label>
        {noTemplates ? (
          <span className="meta">No templates are set up yet — the admin adds them in the configuration.</span>
        ) : (
          <select className="input" value={template} disabled={!editable} onChange={(e) => setTemplate(e.target.value)}>
            {templates.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label} · {plural(t.milestones.length, "stage")}
              </option>
            ))}
          </select>
        )}
      </div>
    </StepCard>
  );
}

/** The Party block — drawn in full, not yet recordable (BE-34, BE-35). */
function PartyBlock({ entry }: { entry: EntryDetail }) {
  const g = entry.guestProfile ?? entry.inquiry?.guestProfile ?? null;
  // Who names the rest of the party — the agent's tour, a company's delegates, or the guest.
  const inqIds = (entry.inquiry ?? {}) as { travelAgentId?: string | null; corporateAccountId?: string | null };
  const fromWhom = inqIds.travelAgentId ? "to come from the agent" : inqIds.corporateAccountId ? "to come from the company" : "to be named";
  const leadRole = inqIds.travelAgentId ? "tour leader" : "lead";
  const rows = Math.max(1, Math.min(entry.guestCount ?? (entry.numberOfRooms ?? 1) * 2, 12));
  return (
    <div
      className="notice inert"
      style={{ padding: 0 }}
      title="Not possible yet — guests' roles, free rooms and the rooming list can't be recorded here"
    >
      <div inert>
        <StepCard title="Party" icon="person" quiet>
          <table className="table compact">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Free of charge</th>
                <th>Room</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: rows }, (_, i) => (
                <tr key={i} className="static">
                  <td>{i === 0 && g ? guestNameOf(g) : <i>{fromWhom}</i>}</td>
                  <td>{i === 0 ? leadRole : "guest"}</td>
                  <td className="dash">—</td>
                  <td className="dash">—</td>
                </tr>
              ))}
            </tbody>
          </table>
        </StepCard>
      </div>
      <HelpHere label="About this roster">
        Who is in the party. It can&rsquo;t be filled in yet — guests&rsquo; roles, free-of-charge rooms and the rooming list come later.
        The Room column fills in when rooms are given out at Arrival.
      </HelpHere>
    </div>
  );
}

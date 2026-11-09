"use client";

/**
 * Step 3 · Set up — "hold & deposit" (SS03 §6, prototype `stepCanvas[3]`, Storyboard 03).
 *
 * Who pays, the committed hold, the payment plan (the advance as a
 * chain — see s3-money.tsx), the terms disclosed, the proforma with the guest's answer, and —
 * when the booking is a group or a company's — the coordinator, free-of-charge rooms and payment
 * milestones. Nothing is frozen here; that happens at Reserve, from the gate bar.
 *
 * Figures come from the backend only: the advance from payment-status, the proforma as the
 * backend composes it. Nothing is added up here.
 */
import { ProformaValidity } from "./s3-proforma-validity";
import { StayDates } from "@/components/ds/stay-dates";
import { PersonName } from "@/components/ds/person-name";
import { joinTitled, splitTitle } from "@/lib/ds/person";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient, useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip, Icon } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useBookingRooms } from "@/hooks/use-booking-rooms";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import { openInvoicePdf } from "@/lib/api/documents";
import {
  approveFocGm,
  cancelEntryAtS3,
  confirmCoordinator,
  dispatchInvoice,
  ensureProvisionalFolio,
  generateProforma,
  getPayerChoices,
  getHoldWindow,
  initiateS3ReEntryToS1,
  initiateS3ReEntryToS2,
  releaseCommittedHold,
  setCommittedHoldExpiry,
  listPaymentMilestoneTemplates,
  schedulePaymentMilestones,
} from "@/lib/api/reservation-setup";
import { guestNameOf } from "@/lib/ds/status";
import { payerChoiceWord, payerPartyOf } from "@/lib/ds/payer-words";
import { blockWindowWords, fmtDateTime, fmtStamp, hotelFormParts, money, plural } from "@/lib/ds/format";
import { optionSelectedRoomIds, type EntryDetail, type InvoiceSummary, type PaymentStatusSummary } from "@/types/api";
import { renegotiateTrip, replySettled } from "@/lib/api/entries";
import { EarlierAdvanceQuestion } from "./s3-earlier-advance";
import { AnswerLine, useReplyAsked, Choice, DsDialog, Fact, Facts, Live, OnRecord, PaperDrawer, ReasonDialog, SeeRow, SendPaperPanel, StepCanvas, StepCard, atLeast, currentPassStart, toastRefusal, useCommunications, useRefreshEntry, useStepMode, words, type PaperRef, type ChangeBookingItem, ChangeBookingMenu, StageActs, useFlowUnsaved, useFinishWhenDone, useStepFlow, goToStepCard, revealCard, useOpenAlsoWay, useStepPane, OtherWaysTabs, InlineWay, ShutWay, parkTab, NightsChoice, NotSentChip } from "./kit";
import { TripProformaCard, useTripProforma } from "./s3-trip-proforma";
import { useStaysTogether } from "./s2-together";
import { SendToField, useSendTo } from "./s8-parts";
import { CancellationFiguresLine, WaiverTick, useRefundHow } from "./cancel-figures";
import { CompetingClaimsCard, passesOf, roomsHeldWord, useRoomNumbers, useRoomTypeNames } from "./s2-shared";
import { PaymentPlanCard, TogetherPaymentPlan } from "./s3-money";
import { Help, HelpHere } from "@/components/ds/help";
import { DateInput, TimeInput } from "@/components/ds/date-input";
import { billNo, proformaBaseNo, quoteNo } from "@/lib/ds/papers";

/* ------------------------------------------------------------------ vocabulary */

/** The two models a group can take without the GM (the backend refuses the rest below L3). */
const GROUP_FRIENDLY = new Set(["DIRECT_BILL", "TOUR_OPERATOR_VOUCHER"]);

const FOLIO_WORD: Record<string, string> = {
  PROVISIONAL: "The bill is provisional — nothing is charged before check-in.",
  LIVE: "The bill is open.",
  OUTSTANDING: "The bill is settled with money still owed.",
  SETTLED: "The bill is settled.",
  CLOSED: "The bill is closed.",
};

type InquiryScalars = {
  sourceChannel?: string | null;
  travelAgentId?: string | null;
  corporateAccountId?: string | null;
  corporateCoordinator?: string | null;
};
type EntryContact = { contactPersonName?: string | null; contactPersonPhone?: string | null };

/* ------------------------------------------------------------------ the step */

export const ROOMS_LEAD =
  "Who sleeps where, on what plan, with what beds. Click a room to change it — every night is checked again, the booking walks back through Negotiation and the price follows.";

export function S3SetUp({
  entry,
  past,
  parkNow,
  parking,
  goToStep,
  onChangeStay,
}: {
  entry: EntryDetail;
  past: boolean;
  /** Park with the reason typed in Other ways' own tab (2026-10-17). */
  parkNow?: (reason: string) => void;
  parking?: boolean;
  goToStep: (n: number) => void;
  /** Change booking › "Change the dates, rooms or guests" — the editor in the page (2026-10-29). */
  onChangeStay?: () => void;
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

  const payment = usePaymentStatus(entry.id, { enabled: !!folio });
  const status = payment.data;
  // "Yes, ask for an advance" after the terms (2026-10-28) opens the payment plan's advance box.
  const [askAdvance, setAskAdvance] = useState(0);
  // A payment that blocked the rooms — the hold card asks whether to set a block time (2026-10-28).
  const [blockAsk, setBlockAsk] = useState<number>(0);

  /* ---- the billing model the desk is choosing ---- */
  // What is offered and what it starts on are the server's (2026-11-05): the package to a travel
  // agent or a company first, the guest alone when there is nobody else to bill.
  const payerChoices = useQuery({
    queryKey: ["payer-choices", entry.id],
    queryFn: () => getPayerChoices(session!, entry.id),
    enabled: !!session,
  });
  const party = payerPartyOf(entry);
  const preselectedWhy =
    party === "TRAVEL_AGENT"
      ? "this booking came through a travel agent"
      : party === "CORPORATE"
        ? "a company made this booking"
        : entry.groupBillingMode === "GROUP_MASTER"
          ? "a group bills to one master bill"
          : null;
  const savedModel = folio?.billingModel ?? null;
  // Split off another booking (2026-10-14): its payer carries until the desk chooses otherwise.
  const carriedModel = entry.carryOver?.billingModel ?? null;
  const offeredCarry = carriedModel && payerChoices.data?.choices.includes(carriedModel) ? carriedModel : null;
  const defaultModel = payerChoices.data?.defaultChoice ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    setPicked(null);
  }, [savedModel]);
  const model = picked ?? savedModel ?? offeredCarry ?? defaultModel;

  /* ---- the rooms chosen at Inquiry ---- */
  const sealedPreferred = (entry.availabilityConfigs ?? []).find((c) => c.sealedAt && c.optionSelected);
  const sealedRoomIds = useMemo(() => optionSelectedRoomIds(sealedPreferred?.optionSelected), [sealedPreferred?.optionSelected]);

  /* ---- the proforma and the guest's answer to it (this pass) ---- */
  const proformas = (folio?.invoices ?? []).filter((i) => i.invoiceType === "PROFORMA");
  const currentProforma = proformas.find((i) => i.state !== "SUPERSEDED") ?? null;
  const together = useStaysTogether(past ? null : entry);
  const tripProforma = useTripProforma(entry);
  // Viewing the stays together, every section of this page acts on all of them (2026-11-09, operator).
  const groupStays = useMemo(
    () => (together.active ? [entry, ...together.others].sort((a, b) => together.stayNoOf(a.id) - together.stayNoOf(b.id)) : [entry]),
    [entry, together.active, together.others], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const qc = useQueryClient();
  const changedAll = () => {
    void qc.invalidateQueries({ queryKey: ["trip-proforma"] });
    refresh([...extraKeys, ...groupStays.flatMap((st) => [["entry", st.id], ["payment-status", st.id], ["entry-communications", st.id], ["billing-summary", st.id]])]);
  };
  const missingProforma = (tripProforma.data?.stays ?? []).filter((st) => !st.proforma).map((st) => st.entryId);
  /** "No advance": each stay's proforma, the box closing once the page has them. */
  const generateProformas = useMutation({
    mutationFn: async (ids: string[]) => {
      const failed: Array<{ id: string; error: unknown }> = [];
      for (const id of ids) {
        try {
          await generateProforma(session!, id);
        } catch (error) {
          failed.push({ id, error });
        }
      }
      await Promise.all([...ids.map((id) => qc.refetchQueries({ queryKey: ["entry", id] })), qc.refetchQueries({ queryKey: ["trip-proforma"] })]);
      return failed;
    },
    onSuccess: (failed, ids) => {
      if (failed.length < ids.length) toast.success("No advance asked · the proforma is generated, not sent");
      for (const f of failed) toastRefusal(f.error, `Stay ${together.stayNoOf(f.id)}'s proforma could not be generated`);
      changedAll();
    },
  });
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
  const answered = replySettled(latestProformaComm);
  const replyNotAsked = latestProformaComm?.acknowledgementStatus === "NOT_ASKED";

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
    mutationFn: async (v: { to: "S2" | "S1"; reason: string }): Promise<{ notMoved?: Array<{ entryId: string; message: string }> }> => {
      if (v.to === "S1") {
        await initiateS3ReEntryToS1(session!, entry.id, { reason: v.reason });
        return {};
      }
      if (together.active) return renegotiateTrip(session!, entry.id, v.reason);
      await initiateS3ReEntryToS2(session!, entry.id, { reason: v.reason });
      return {};
    },
    onSuccess: (res, v) => {
      toast.success(v.to === "S1" ? "A new pass is open at Inquiry" : together.active ? `${together.label} are back at Negotiation` : "A new pass is open at Negotiation");
      for (const n of res.notMoved ?? []) toast.warning(`${n.entryId} stayed at Set up — ${n.message}`);
      refresh([...extraKeys, ...together.others.map((o) => ["entry", o.id])]);
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
  const stepPane = useStepPane();
  const notNow = entry.status === "PARKED" ? "Resume the booking first" : "Not possible on this booking now";
  const changeItems: ChangeBookingItem[] = past
    ? []
    : [
        {
          key: "rooms",
          label: "Move a room",
          note: "Into another free room on the same dates. Every night is checked again and the price follows.",
          // In the page, as the Rooms tab was (2026-10-28) — not a pop-up.
          onSelect: editable ? () => stepPane.open("rooms") : undefined,
          reason: editable ? undefined : notNow,
        },
        {
          key: "renegotiate",
          label: "Renegotiate the price",
          note: together.active
            ? `${together.label} go back to Negotiation for fresh quotations. Each stay's hold is released and its proforma replaced.`
            : "Back to Negotiation for a fresh quotation. The hold is released and the proforma replaced.",
          onSelect: editable && elevated ? () => openAlsoWay("renegotiate") : undefined,
          reason: !editable ? notNow : elevated ? undefined : "The FOM's call",
        },
        {
          key: "reconfigure",
          label: "Change the dates, rooms or guests",
          note: "Here, on this step. The house is asked again, the rooms picked and the price made again — the booking comes back to Set up.",
          onSelect: editable && elevated && onChangeStay ? onChangeStay : undefined,
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
      {together.deciding ? (
        <span className="meta">Reading the stays…</span>
      ) : together.active ? (
        <>
          <TogetherWhoPays
            entry={entry}
            stays={groupStays}
            stayNoOf={together.stayNoOf}
            editable={editable}
            gm={gm}
            generate={generateProformas}
            onAskAdvance={() => setAskAdvance((n) => n + 1)}
            onChanged={changedAll}
          />
          {groupStays.map((st) => (
            <StayEarlierAdvance key={st.id} stay={st} tz={tz} onChanged={changedAll} />
          ))}
          <TripProformaCard
            entry={entry}
            editable={editable}
            inFlow
            advanceAsk={
              editable && missingProforma.length > 0 && groupStays.every((st) => !missingProforma.includes(st.id) || !!st.folio?.billingModel)
                ? { busy: generateProformas.isPending, onNo: () => generateProformas.mutate(missingProforma), onYes: () => setAskAdvance((n) => n + 1) }
                : null
            }
          />
          <TogetherPaymentPlan
            entry={entry}
            stays={groupStays}
            stayNoOf={together.stayNoOf}
            editable={editable}
            elevated={elevated}
            tz={tz}
            askAdvance={askAdvance}
            onAskAdvanceSeen={() => setAskAdvance(0)}
            onPaymentRecorded={() => setBlockAsk((n) => n + 1)}
            onChanged={changedAll}
          />
          <TogetherHold
            entry={entry}
            stays={groupStays}
            stayNoOf={together.stayNoOf}
            editable={editable}
            gm={gm}
            fom={atLeast(session?.actorLevel, "L2")}
            tz={tz}
            nowMs={clock.now}
            roomNos={roomNos}
            blockAsk={blockAsk}
            onBlockAskSeen={() => setBlockAsk(0)}
            onChanged={changedAll}
          />
        </>
      ) : (
        <>
      <BillingModelCard
        entry={entry}
        editable={editable}
        gm={gm}
        model={model}
        setModel={setPicked}
        savedModel={savedModel}
        offered={payerChoices.data?.choices ?? null}
        preselectedWhy={
          !savedModel && carriedModel && model === carriedModel
            ? `it carries from ${entry.carryOver!.fromEntryId}, the booking these rooms came from`
            : !savedModel && preselectedWhy && model === defaultModel
              ? preselectedWhy
              : null
        }
        onAskAdvance={() => setAskAdvance((n) => n + 1)}
        onChanged={changed}
      />

      {/* The order the desk works in (2026-09-25): the payer, then the bill and the money — and
          the rooms last, the only order the backend accepts them in. The terms are recorded by the
          system when a booking reaches Set up (2026-11-05). */}
      {/* Money from before this booking was sent back: on the new proforma, or refunded (2026-11-05). */}
      <EarlierAdvanceQuestion entry={entry} status={status} tz={tz} onChanged={changed} />

      {/* Viewing the stays together shows only the trip's proforma, once there is one; Send sends
          that one (2026-11-09, operator). A stay still without its own makes it here first. */}
      <ProformaCard
        entry={entry}
        editable={editable}
        tz={tz}
        proformas={proformas}
        current={currentProforma}
        status={status}
        passStart={passStart}
        answered={answered}
        replyNotAsked={replyNotAsked}
        onAskAdvance={() => setAskAdvance((n) => n + 1)}
        onChanged={changed}
      />

      <PaymentPlanCard
        entry={entry}
        editable={editable}
        elevated={elevated}
        status={status}
        statusLoading={payment.isLoading}
        tz={tz}
        bill={{ proforma: currentProforma, dispatched, answered, notAsked: replyNotAsked }}
        askAdvance={askAdvance}
        onAskAdvanceSeen={() => setAskAdvance(0)}
        onPaymentRecorded={() => setBlockAsk((n) => n + 1)}
        onChanged={changed}
      />

      <HoldCard
        entry={entry}
        editable={editable}
        gm={gm}
        fom={atLeast(session?.actorLevel, "L2")}
        tz={tz}
        nowMs={clock.now}
        roomIds={sealedRoomIds}
        roomNos={roomNos}
        blockAsk={blockAsk}
        onBlockAskSeen={() => setBlockAsk(0)}
        onChanged={changed}
      />
        </>
      )}
      {/* What Reserve asks that the sections above do not — the page between Set up and Reserve
          is gone (2026-10-29), and Reserve the booking floats in here. */}

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
                        caseLines={[<StayDates key="stay" checkIn={entry.checkInDate} checkOut={entry.checkOutDate} />]}
                        lead={
                          <>
                            Cancelling at Set up is final. The block is released and the rooms return to sale; the proforma is withdrawn and its
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
                        title={together.active ? `Renegotiate the price · ${together.label.toLowerCase()}` : "Renegotiate the price"}
                        caseLines={[together.active ? "A new pass opens at Negotiation for each stay" : "A new pass opens at Negotiation"]}
                        lead={
                          together.active
                            ? "Each stay's pass is sealed as it stands. Each block is released, each proforma replaced, and a fresh quotation is made for each stay in its new pass."
                            : "This pass is sealed as it stands. The block is released, the proforma replaced, and a fresh quotation is made in the new pass."
                        }
                        confirmLabel={together.active ? "Open a new pass for each" : "Open a new pass"}
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
        ]}
      />
    </StepCanvas>
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
  offered,
  preselectedWhy,
  onAskAdvance,
  onChanged,
}: {
  entry: EntryDetail;
  editable: boolean;
  gm: boolean;
  model: string | null;
  setModel: (m: string) => void;
  savedModel: string | null;
  /** What the server offers this booking; null until it has answered. */
  offered: string[] | null;
  /** Why the model shown was chosen for the desk — null when the desk chose it. */
  preselectedWhy: string | null;
  /** The desk said yes to an advance: the payment plan's advance box opens. */
  onAskAdvance: () => void;
  onChanged: () => void;
}) {
  const { session } = useSession();
  const folio = entry.folio ?? null;
  const group = entry.groupBillingMode === "GROUP_MASTER";
  const party = payerPartyOf(entry);
  // A booking from before this rule keeps what it has on the list, so the choice still reads true.
  const options = useMemo(() => {
    const keys = [...(offered ?? [])];
    if (savedModel && !keys.includes(savedModel)) keys.push(savedModel);
    return keys.map((k) => [k, payerChoiceWord(k, party)] as const);
  }, [offered, savedModel, party]);
  // Setting the payer finishes the section — no Done to press after it (2026-10-28).
  const finish = useFinishWhenDone("billing-model");
  /**
   * Setting who pays asks about an advance, when nothing is asked yet (2026-11-05, operator: it
   * followed the terms, which the system records now). The server says when: a travel agent's or
   * company's own percentage has already asked. The proforma, which prints the advance, waits for
   * the answer: No makes it now, Yes when the advance is saved. Closing the question decides
   * nothing, and the proforma's card asks it again.
   */
  const qc = useQueryClient();
  const [askAdvance, setAskAdvance] = useState(false);
  const save = useMutation({
    mutationFn: () => ensureProvisionalFolio(session!, entry.id, { billingModel: model!, askAdvanceFirst: true }),
    onSuccess: (out) => {
      // Keyed on a model being SET, not on the folio existing — the folio opens at Set up with no
      // model, so the first choice read as a change (2026-09-18).
      toast.success(savedModel ? "Who pays is changed" : "Who pays is set");
      onChanged();
      if (out.advanceQuestion) setAskAdvance(true);
      else finish();
    },
    onError: (e) => toastRefusal(e, "Who pays could not be set"),
  });
  const noAdvance = useMutation({
    // The box closes once the page holds the new booking (2026-11-09, operator): closing it first
    // showed the sections as they were for a moment, then a refresh.
    mutationFn: async () => {
      const out = await generateProforma(session!, entry.id);
      await qc.refetchQueries({ queryKey: ["entry", entry.id] });
      return out;
    },
    onSuccess: () => {
      toast.success("No advance asked · the proforma is generated, not sent");
      setAskAdvance(false);
      onChanged();
      finish({ next: "hold" });
    },
    onError: (e) => toastRefusal(e, "The proforma could not be generated"),
  });
  const dirty = !savedModel || model !== savedModel;
  // A payer changed and not saved keeps the section open, and holds the move (2026-10-28).
  useFlowUnsaved("billing-model", editable && !!savedModel && model !== savedModel, "Changes to who pays saved");
  const groupLock =
    group && !!model && !GROUP_FRIENDLY.has(model) && !gm ? "for a group, only the account or the package — anything else is the GM's call" : null;
  return (
    <StepCard
      flow="billing-model"
      title="Who pays"
      summary={savedModel ? payerChoiceWord(savedModel, party) : undefined}
      right={savedModel && !dirty ? <OnRecord /> : null}
      meta={
        <>
          Who the bill is made out to. The package is the rooms, extra beds and meal plans on the quotation; extras are anything else charged
          during the stay. It is chosen here, and can still be changed on the Stay step while the guest is staying.
          {preselectedWhy ? ` Pre-selected — ${preselectedWhy}; change it if they settle differently.` : ""}
          {group ? " A group has one bill for everyone." : ""}
          {folio ? "" : " The provisional bill opens with this choice."}
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
              className={groupLock || !model ? undefined : "go"}
              state={save.isPending ? "working" : groupLock || !model ? "inert" : "default"}
              title={groupLock ?? undefined}
              workingLabel="Saving…"
              onClick={() => save.mutate()}
            >
              {!folio ? "Open the provisional bill" : savedModel ? "Change who pays" : "Set who pays"}
            </Button>
            {savedModel ? (
              <Button kind="quiet" compact onClick={() => setModel(savedModel)}>
                Undo
              </Button>
            ) : null}
          </div>
        ) : null}
      </Live>
      {askAdvance ? (
        <DsDialog
          open
          closeX
          busy={noAdvance.isPending}
          onClose={() => {
            setAskAdvance(false);
            finish();
          }}
          title="Ask the guest for an advance?"
          caseLines={["Nothing is asked of this booking so far"]}
          help="The proforma prints the advance, so it is generated once this is answered. With an advance, it is generated when the amount is saved, and the guest pays it before the booking is reserved. With none, it is generated now and the rooms are blocked next."
          footer={
            <>
              <Button kind="secondary" state={noAdvance.isPending ? "working" : "default"} workingLabel="Generating…" onClick={() => noAdvance.mutate()}>
                No advance
              </Button>
              <Button
                state={noAdvance.isPending ? "inert" : "default"}
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

/* ------------------------------------------------------------------ the stays together */

/**
 * Viewing the stays together at Set up, each section acts on every stay (2026-11-09, operator: "it
 * should be doing for together like how it was done in stage 2"). Who pays is one choice, set on each
 * stay through its own checks; a stay refused is named.
 */
function TogetherWhoPays({
  entry,
  stays,
  stayNoOf,
  editable,
  gm,
  generate,
  onAskAdvance,
  onChanged,
}: {
  entry: EntryDetail;
  stays: EntryDetail[];
  stayNoOf: (id: string) => number;
  editable: boolean;
  gm: boolean;
  generate: { isPending: boolean; mutateAsync: (ids: string[]) => Promise<unknown> };
  onAskAdvance: () => void;
  onChanged: () => void;
}) {
  const { session } = useSession();
  const qc = useQueryClient();
  const choices = useQuery({ queryKey: ["payer-choices", entry.id], queryFn: () => getPayerChoices(session!, entry.id), enabled: !!session });
  const party = payerPartyOf(entry);
  const group = entry.groupBillingMode === "GROUP_MASTER";
  const saved = stays.map((st) => st.folio?.billingModel ?? null);
  const savedKey = saved.join("|");
  const common = saved.every((m) => m === saved[0]) ? saved[0] : null;
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => setPicked(null), [savedKey]);
  const model = picked ?? common ?? choices.data?.defaultChoice ?? null;
  const options = useMemo(() => {
    const keys = [...(choices.data?.choices ?? [])];
    for (const m of saved) if (m && !keys.includes(m)) keys.push(m);
    return keys.map((k) => [k, payerChoiceWord(k, party)] as const);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choices.data?.choices, savedKey, party]);
  const finish = useFinishWhenDone("billing-model");
  const dirty = stays.some((st) => st.folio?.billingModel !== model);
  useFlowUnsaved("billing-model", editable && !!common && model !== common, "Changes to who pays saved");
  const groupLock = group && !!model && !GROUP_FRIENDLY.has(model) && !gm ? "for a group, only the account or the package — anything else is the GM's call" : null;
  const [ask, setAsk] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: async () => {
      const asks: string[] = [];
      const failed: Array<{ id: string; error: unknown }> = [];
      for (const st of stays) {
        if (st.folio?.billingModel === model) continue;
        try {
          const out = await ensureProvisionalFolio(session!, st.id, { billingModel: model!, askAdvanceFirst: true });
          if (out.advanceQuestion) asks.push(st.id);
        } catch (error) {
          failed.push({ id: st.id, error });
        }
      }
      await Promise.all([...stays.map((st) => qc.refetchQueries({ queryKey: ["entry", st.id] })), qc.refetchQueries({ queryKey: ["trip-proforma"] })]);
      return { asks, failed };
    },
    onSuccess: ({ asks, failed }) => {
      if (failed.length < stays.length) toast.success("Who pays is set on every stay");
      for (const f of failed) toastRefusal(f.error, `Who pays could not be set on stay ${stayNoOf(f.id)}`);
      onChanged();
      if (asks.length) setAsk(asks);
      else finish();
    },
  });
  return (
    <StepCard
      flow="billing-model"
      title="Who pays"
      summary={common ? payerChoiceWord(common, party) : undefined}
      right={common && !dirty ? <OnRecord /> : null}
      meta="One choice for every stay viewed together. Who the bill is made out to; each stay keeps its own bill."
    >
      <Choice options={options} value={model} onChange={editable ? setPicked : undefined} disabled={!editable} />
      {!common && saved.some(Boolean) ? (
        <p className="sm warn-ink" style={{ marginTop: 6 }}>
          {stays.map((st) => `Stay ${stayNoOf(st.id)}: ${st.folio?.billingModel ? payerChoiceWord(st.folio.billingModel, party) : "not set"}`).join(" · ")}
        </p>
      ) : null}
      <Live>
        {editable && dirty ? (
          <div className="row-acts" style={{ marginTop: 10 }}>
            <Button
              compact
              className={groupLock || !model ? undefined : "go"}
              state={save.isPending ? "working" : groupLock || !model ? "inert" : "default"}
              title={groupLock ?? undefined}
              workingLabel="Saving…"
              onClick={() => save.mutate()}
            >
              {common ? "Change who pays" : "Set who pays"}
            </Button>
            {common ? (
              <Button kind="quiet" compact onClick={() => setPicked(common)}>
                Undo
              </Button>
            ) : null}
          </div>
        ) : null}
      </Live>
      {ask.length ? (
        <DsDialog
          open
          closeX
          busy={generate.isPending}
          onClose={() => {
            setAsk([]);
            finish();
          }}
          title="Ask the guest for an advance?"
          caseLines={["Nothing is asked of these stays so far"]}
          help="Each proforma prints the advance, so they are generated once this is answered."
          footer={
            <>
              <Button
                kind="secondary"
                state={generate.isPending ? "working" : "default"}
                workingLabel="Generating…"
                onClick={() => {
                  void generate.mutateAsync(ask).then(() => {
                    setAsk([]);
                    finish({ next: "hold" });
                  });
                }}
              >
                No advance
              </Button>
              <Button
                state={generate.isPending ? "inert" : "default"}
                onClick={() => {
                  setAsk([]);
                  finish({ next: "money" });
                  onAskAdvance();
                }}
              >
                Yes, ask for an advance
              </Button>
            </>
          }
        >
          <p className="sm">Does the hotel want an advance on these stays?</p>
        </DsDialog>
      ) : null}
    </StepCard>
  );
}

/** A stay's own question about money from an earlier pass, on the page viewing all the stays. */
function StayEarlierAdvance({ stay, tz, onChanged }: { stay: EntryDetail; tz: string; onChanged: () => void }) {
  const status = usePaymentStatus(stay.id, { enabled: !!stay.folio }).data;
  return <EarlierAdvanceQuestion entry={stay} status={status} tz={tz} onChanged={onChanged} />;
}

/** The block a stay holds in this pass: one kept by an earlier pass's reservation does not count. */
const heldOf = (st: EntryDetail) => {
  const raw = st.committedHold ?? null;
  return raw && raw.state !== "RELEASED" && raw.state !== "EXPIRED" && raw.state !== "CONFIRMED" ? raw : null;
};

function StayHoldRow({ stay, stayNo, tz, nowMs, roomNos, houseWords }: { stay: EntryDetail; stayNo: number; tz: string; nowMs: number; roomNos: Map<string, string>; houseWords: string | null }) {
  const roomNames = useBookingRooms(stay).named;
  const typeNames = useRoomTypeNames();
  const sealed = (stay.availabilityConfigs ?? []).find((c) => c.sealedAt && c.optionSelected);
  const ids = optionSelectedRoomIds(sealed?.optionSelected);
  const hold = heldOf(stay);
  const heldIds = ids.length ? ids : hold?.roomId ? [hold.roomId] : [];
  const rooms = roomsHeldWord(heldIds.map((id) => ({ number: roomNos.get(id) ?? null, typeName: typeNames.get(id) ?? null, quiet: roomNames.has(id) })));
  const many = heldIds.length > 1;
  if (!hold) {
    return (
      <div className="sm" style={{ marginBottom: 4 }}>
        <b>Stay {stayNo}</b> · {rooms} not blocked yet
      </div>
    );
  }
  const lapsed = new Date(hold.expiresAt).getTime() < nowMs;
  const whose = stay.holdExpiresAtOverride ? "the time set for this booking" : houseWords ? `the hotel's ${houseWords}` : "the hotel's time";
  return (
    <div className={`hold-line${lapsed ? " lapsed" : ""}`} style={{ marginBottom: 4 }}>
      <Icon name="lock" />
      <span className="hold-text">
        <b>Stay {stayNo}</b> · <b>{rooms}</b> {lapsed ? (many ? "were" : "was") : many ? "are" : "is"} blocked until <b>{fmtDateTime(hold.expiresAt, tz)}</b>
        <span className="hold-whose"> · {whose}</span>
        {lapsed ? <b className="crit-tag" style={{ marginLeft: 8 }}>Critical</b> : null}
      </span>
    </div>
  );
}

/** Block the Entry for every stay viewed together: one block time, one release. */
function TogetherHold({
  entry,
  stays,
  stayNoOf,
  editable,
  gm,
  fom,
  tz,
  nowMs,
  roomNos,
  blockAsk,
  onBlockAskSeen,
  onChanged,
}: {
  entry: EntryDetail;
  stays: EntryDetail[];
  stayNoOf: (id: string) => number;
  editable: boolean;
  gm: boolean;
  fom: boolean;
  tz: string;
  nowMs: number;
  roomNos: Map<string, string>;
  blockAsk: number;
  onBlockAskSeen: () => void;
  onChanged: () => void;
}) {
  const { session } = useSession();
  const flow = useStepFlow();
  const [askBlock, setAskBlock] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const allHeld = stays.every((st) => !!heldOf(st));
  useEffect(() => {
    if (!blockAsk) return;
    // Answered once: this card is drawn afresh whenever the view changes (2026-11-09).
    onBlockAskSeen();
    if (allHeld) return;
    if (flow.on) flow.open("hold");
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => goToStepCard("hold")));
    setAskBlock(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockAsk]);
  const house = useQuery({ queryKey: ["hold-window"], queryFn: () => getHoldWindow(session!), enabled: !!session, staleTime: 600_000 }).data ?? null;
  const houseWords = house ? blockWindowWords(house.minutes) : null;
  const held = stays.filter((st) => !!heldOf(st));
  const lapsing = held.some((st) => new Date(heldOf(st)!.expiresAt).getTime() < nowMs);
  const mayRelease = gm || (fom && lapsing);
  const mayRetime = !lapsing || fom;
  const release = useMutation({
    mutationFn: async (reason: string) => {
      const failed: Array<{ id: string; error: unknown }> = [];
      for (const st of held) {
        try {
          await releaseCommittedHold(session!, st.id, { releaseReason: reason });
        } catch (error) {
          failed.push({ id: st.id, error });
        }
      }
      return failed;
    },
    onSuccess: (failed) => {
      if (failed.length < held.length) toast.success("The blocks are released — the rooms are back on sale");
      for (const f of failed) toastRefusal(f.error, `Stay ${stayNoOf(f.id)}'s block could not be released`);
      setReleaseOpen(false);
      onChanged();
    },
  });
  const own = stays.find((st) => st.holdExpiresAtOverride) ?? null;
  return (
    <StepCard
      flow="hold"
      flowAfter="proforma"
      title="Block the Entry"
      acts={
        <Live>
          <SeeRow
            label="Set block time"
            note="the same time for every stay"
            onClick={editable && mayRetime ? () => setTimeOpen(true) : undefined}
            reason={!editable ? "not at this step" : mayRetime ? undefined : "the FOM's or GM's call now"}
          />
          {held.length ? (
            <SeeRow
              label="Release"
              note="frees every stay's rooms, with a reason"
              onClick={editable && mayRelease ? () => setReleaseOpen(true) : undefined}
              reason={!editable ? "not at this step" : mayRelease ? undefined : lapsing ? "the FOM's or GM's call" : "releasing a block is the GM's call"}
            />
          ) : null}
        </Live>
      }
    >
      {stays.map((st) => (
        <StayHoldRow key={st.id} stay={st} stayNo={stayNoOf(st.id)} tz={tz} nowMs={nowMs} roomNos={roomNos} houseWords={houseWords} />
      ))}
      {!allHeld ? <span className="meta">Move to Reserve blocks every stay&rsquo;s rooms not blocked yet.</span> : null}
      {askBlock && !timeOpen ? (
        <DsDialog
          open
          onClose={() => setAskBlock(false)}
          title="Block the rooms now?"
          footer={
            <>
              <Button kind="secondary" onClick={() => setAskBlock(false)}>
                Close
              </Button>
              <Button
                icon="clock"
                onClick={() => {
                  setAskBlock(false);
                  setTimeOpen(true);
                }}
              >
                Set block time
              </Button>
            </>
          }
        >
          <p className="sm">The payment is recorded. Set a block time to hold every stay&rsquo;s rooms until then. If you close this, they stay on sale until a block time is set here or you press Move to Reserve.</p>
        </DsDialog>
      ) : null}
      {timeOpen ? (
        <HoldTimeDialog
          entry={entry}
          tz={tz}
          houseWords={houseWords}
          currentIso={heldOf(entry)?.expiresAt ?? entry.holdExpiresAtOverride ?? own?.holdExpiresAtOverride ?? null}
          hasOwnTime={!!own}
          holdLive={!!heldOf(entry)}
          alsoFor={stays.filter((st) => st.id !== entry.id).map((st) => ({ id: st.id, stayNo: stayNoOf(st.id), holdLive: !!heldOf(st) }))}
          onClose={() => setTimeOpen(false)}
          onChanged={onChanged}
        />
      ) : null}
      {releaseOpen ? (
        <ReleaseDialog onlyRelease caseLine={`${held.length} stays blocked`} busy={release.isPending} onClose={() => setReleaseOpen(false)} onRelease={(r) => release.mutate(r)} onCancelBooking={() => undefined} />
      ) : null}
    </StepCard>
  );
}

/* ------------------------------------------------------------------ the committed hold */

function HoldCard({
  entry,
  editable,
  gm,
  fom,
  tz,
  nowMs,
  roomIds,
  roomNos,
  blockAsk,
  onBlockAskSeen,
  onChanged,
}: {
  entry: EntryDetail;
  editable: boolean;
  gm: boolean;
  fom: boolean;
  tz: string;
  nowMs: number;
  roomIds: string[];
  roomNos: Map<string, string>;
  /** Counts the payments just recorded here: each one asks about blocking the rooms. */
  blockAsk: number;
  onBlockAskSeen: () => void;
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
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);
  /**
   * After a payment (2026-11-09, operator: "we should prompt the user set block time or close option,
   * if closed it wont block until user sets the block time in the block the entry section, but move
   * to reserve will be enable"). A payment no longer blocks the rooms by itself; the card comes into
   * view and asks. Move to Reserve blocks them if nobody set a time.
   */
  const flow = useStepFlow();
  // A room the system chose and may still move reads "Deluxe Double · room 1" until Arrival.
  const roomNames = useBookingRooms(entry).named;
  const [askBlock, setAskBlock] = useState(false);
  /**
   * Once the block time is settled, the hold section says so (2026-10-28, operator: "show a message
   * saying these rooms are blocked … for this many hours"). It is said by the section's own line,
   * lit for a moment — not in the middle of the screen (the centred card is how a step move is
   * said, and the block read like one) and not as a second line ("too noisy"). The section keeps
   * one line, "2 Deluxe Double and 1 Executive are blocked until …", with Edit for the rest.
   */
  const [flash, setFlash] = useState(0);
  const [details, setDetails] = useState(false);
  const sayBlocked = (untilIso: string | null) => {
    if (!untilIso) return;
    setDetails(false);
    setFlash(Date.now());
  };
  useEffect(() => {
    if (!blockAsk) return;
    onBlockAskSeen();
    if (hold) return;
    if (flow.on) flow.open("hold");
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => goToStepCard("hold")));
    setAskBlock(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockAsk]);

  // The house's own window, so the card can say what it gives beside a time set for one booking.
  const house = useQuery({
    queryKey: ["hold-window"],
    queryFn: () => getHoldWindow(session!),
    enabled: !!session,
    staleTime: 600_000,
  }).data ?? null;
  const ownTime = entry.holdExpiresAtOverride ?? null;

  const release = useMutation({
    mutationFn: (reason: string) => releaseCommittedHold(session!, entry.id, { releaseReason: reason }),
    onSuccess: () => {
      toast.success("The block is released — the rooms are back on sale");
      setDetails(false);
      setReleaseOpen(false);
      onChanged();
    },
    onError: (e) => toastRefusal(e, "The hold could not be released"),
  });

  // The rooms by type and count — "2 Deluxe Double and 1 Executive" (2026-10-28, operator) — and a
  // room given by number by its number (2026-10-29).
  const typeNames = useRoomTypeNames();
  const heldIds = roomIds.length ? roomIds : hold?.roomId ? [hold.roomId] : [];
  const rooms = roomsHeldWord(heldIds.map((id) => ({ number: roomNos.get(id) ?? null, typeName: typeNames.get(id) ?? null, quiet: roomNames.has(id) })));
  const houseWords = house ? blockWindowWords(house.minutes) : null;
  const count = roomIds.length || 1;
  // The block's time has ended: the rooms stay held, it is critical, and the FOM or GM decides
  // (2026-11-05). So Release and a new time are theirs from here, and the page says so.
  const lapsing = hold ? new Date(hold.expiresAt).getTime() < nowMs : false;
  const mayRelease = gm || (fom && lapsing);
  const mayRetime = !lapsing || fom;
  const openAlsoWay = useOpenAlsoWay();
  // A standing block is one line; Edit opens its facts and its acts (2026-10-28, operator: "the
  // user no longer has to see it unless they have to release it or change the block time"). A
  // block whose time has passed, and a step looked back at, show everything.
  const showDetails = !hold || details || lapsing || past;
  const whoseTime = ownTime ? "the time set for this booking" : houseWords ? `the hotel's ${houseWords}` : "the hotel's time";
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
      title="Block the Entry"
      summary={hold ? (lapsing ? `Critical · the block ended ${fmtDateTime(hold.expiresAt, tz)}` : `${rooms} ${count > 1 ? "are" : "is"} blocked until ${fmtDateTime(hold.expiresAt, tz)}`) : undefined}
      acts={
        past || !showDetails ? undefined : (
          <Live>
            <SeeRow
              label="Set block time"
              note={
                ownTime
                  ? `blocked to ${fmtDateTime(ownTime, tz)} — set for this booking`
                  : hold
                    ? `the hotel blocks for ${houseWords ?? "its own time"} — set this booking's own time`
                    : "blocks the rooms now, until the time you set"
              }
              onClick={editable && mayRetime ? () => setTimeOpen(true) : undefined}
              reason={!editable ? "not at this step" : mayRetime ? undefined : "the FOM's or GM's call now"}
            />
            {hold ? (
              <SeeRow
                label="Release"
                note="frees the rooms with a reason — they return to sale"
                onClick={editable && mayRelease ? () => setReleaseOpen(true) : undefined}
                reason={!editable ? "not at this step" : mayRelease ? undefined : lapsing ? "the FOM's or GM's call" : "releasing a block is the GM's call"}
              />
            ) : null}
            {hold && lapsing ? (
              <SeeRow
                label="Cancel booking"
                note="after talking to the guest"
                onClick={editable && fom ? () => openAlsoWay("cancel") : undefined}
                reason={!editable ? "not at this step" : fom ? undefined : "the FOM's or GM's call"}
              />
            ) : null}
          </Live>
        )
      }
    >
      {hold ? (
        <>
          <HoldLine
            key={flash}
            lit={flash > 0}
            lapsed={lapsing}
            rooms={rooms}
            many={count > 1}
            until={fmtDateTime(hold.expiresAt, tz)}
            whose={whoseTime}
            open={showDetails}
            canToggle={!past && !lapsing}
            onToggle={() => setDetails((d) => !d)}
          />
          {showDetails ? (
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
          ) : null}
          {lapsing ? (
            <div className="notice block-soon block-ended" role="alert" data-block-ended style={{ marginTop: 8 }}>
              <span>
                <b className="crit-tag">Critical</b> <b>This block ended at {fmtDateTime(hold.expiresAt, tz)}. The rooms are still held.</b>{" "}
                {fom
                  ? "Talk to the guest, then cancel the booking, release the rooms, or set a new block time if they still want it."
                  : "The FOM and GM have been told. They talk to the guest, then cancel the booking or release the rooms."}
              </span>
            </div>
          ) : null}
        </>
      ) : (
        <>
          {carried ? (
            <p className="warn-ink" style={{ margin: "0 0 6px", fontWeight: 700 }} role="status">
              {rooms} {roomIds.length > 1 ? "are" : "is"} still kept for this booking by the reservation from an earlier pass. Move to Reserve gives this pass its own block.
            </p>
          ) : null}
          <span className="meta">
            {carried
              ? `The earlier hold was placed ${fmtStamp(carried.placedAt, tz)}.`
              : raw
              ? `The last block ${raw.state === "EXPIRED" || raw.releaseReason === "EXPIRY" ? "ran out" : "was released"}, so the rooms are back on sale. Move to Reserve blocks them again.`
              : `Not blocked yet. Move to Reserve blocks ${count === 1 ? "the room" : `all ${count} rooms`} for ${ownTime ? "the time set for this booking" : houseWords ? `the hotel's ${houseWords}` : "the hotel's time"}.`}
            {!carried && !raw ? <Help label="How the rooms are blocked">To block them before that, for a time you choose, use Set block time.</Help> : null}
          </span>
          {ownTime ? (
            <div className="sm" style={{ marginTop: 6 }}>
              When the rooms are blocked, the block runs to <b>{fmtDateTime(ownTime, tz)}</b> — set for this booking
              {houseWords ? `, not the hotel's ${houseWords}` : ""}.
            </div>
          ) : null}
        </>
      )}

      {askBlock && !timeOpen ? (
        <DsDialog
          open
          onClose={() => setAskBlock(false)}
          title="Block the rooms now?"
          caseLines={[rooms]}
          footer={
            <>
              <Button kind="secondary" onClick={() => setAskBlock(false)}>
                Close
              </Button>
              <Button
                icon="clock"
                onClick={() => {
                  setAskBlock(false);
                  setTimeOpen(true);
                }}
              >
                Set block time
              </Button>
            </>
          }
        >
          <p className="sm">
            The payment is recorded. Set a block time to hold {rooms} until then. If you close this, the {count > 1 ? "rooms stay" : "room stays"} on sale until a block time is set here or you press Move to Reserve.
          </p>
        </DsDialog>
      ) : null}
      {timeOpen ? (
        <HoldTimeDialog
          entry={entry}
          tz={tz}
          houseWords={houseWords}
          currentIso={hold?.expiresAt ?? ownTime ?? null}
          hasOwnTime={!!ownTime}
          holdLive={!!hold}
          onClose={() => setTimeOpen(false)}
          onChanged={onChanged}
          onSet={(until, whose, live) => {
            if (live) sayBlocked(until);
          }}
        />
      ) : null}
      {releaseOpen ? (
        <ReleaseDialog
          caseLine={hold ? `${rooms} · ${lapsing ? "the block ended" : "blocked until"} ${fmtDateTime(hold.expiresAt, tz)}` : null}
          busy={release.isPending}
          onClose={() => setReleaseOpen(false)}
          onRelease={(r) => release.mutate(r)}
          onCancelBooking={() => {
            setReleaseOpen(false);
            openAlsoWay("cancel");
          }}
        />
      ) : null}
    </StepCard>
  );
}

/**
 * Release asks first whether the booking goes too (2026-11-05, operator: "whenever release is clicked,
 * prompt the user here in set up if booking should be cancelled or not"). Nothing is chosen for the
 * desk. Yes opens the booking's own cancel form, which prices the charge and any refund and releases
 * the rooms as part of it; no asks why and releases them, and the booking stays at Set up.
 */
function ReleaseDialog({
  caseLine,
  busy,
  onClose,
  onRelease,
  onCancelBooking,
  onlyRelease = false,
}: {
  /** Several stays at once: cancelling is each stay's own act, so it is not asked here. */
  onlyRelease?: boolean;
  caseLine: string | null;
  busy: boolean;
  onClose: () => void;
  onRelease: (reason: string) => void;
  onCancelBooking: () => void;
}) {
  const [choice, setChoice] = useState<"KEEP" | "CANCEL" | null>(onlyRelease ? "KEEP" : null);
  const [why, setWhy] = useState("");
  return (
    <DsDialog
      open
      closeX
      onClose={onClose}
      busy={busy}
      title="Release the block"
      caseLines={caseLine ? [caseLine] : undefined}
      footer={
        choice === "CANCEL" ? (
          <Button kind="danger" onClick={onCancelBooking}>
            Go on to Cancel booking
          </Button>
        ) : choice === "KEEP" ? (
          <Button kind="danger" state={busy ? "working" : why.trim() ? "default" : "inert"} workingLabel="Releasing…" reason={why.trim() ? undefined : "say why the rooms are freed"} onClick={() => onRelease(why.trim())}>
            Release the rooms
          </Button>
        ) : (
          <span className="sm warn-ink">First: should the booking be cancelled?</span>
        )
      }
    >
      {onlyRelease ? null : (
        <div className="field">
          <label>Should the booking be cancelled as well?</label>
          <Choice
            options={[
              ["KEEP", "No, only release the rooms"],
              ["CANCEL", "Yes, cancel the booking"],
            ]}
            value={choice}
            onChange={setChoice}
          />
        </div>
      )}
      {choice === "KEEP" ? (
        <>
          <p className="sm" style={{ margin: "0 0 10px" }}>
            The rooms go back on sale at once. The booking stays at Set up, and Move to Reserve blocks them again.
          </p>
          <div className="field">
            <label>Why?</label>
            <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="why the rooms are freed" maxLength={500} autoFocus />
          </div>
        </>
      ) : null}
      {choice === "CANCEL" ? (
        <p className="sm" style={{ margin: 0 }}>
          The cancel form shows any charge and any refund. Cancelling releases the rooms too.
        </p>
      ) : null}
    </DsDialog>
  );
}

/**
 * The committed hold in one line (2026-10-28, operator): "2 Deluxe Double and 1 Executive are
 * blocked until 28 Oct 2026, 11:07 PM · the hotel's 1 hour", with Edit for the facts and the acts
 * (Set block time, Release). Lit for a moment when a block has just been placed or moved, and
 * brought into view then only when it is not on screen — it never moves a page being read.
 */
function HoldLine({
  lit,
  lapsed,
  rooms,
  many,
  until,
  whose,
  open,
  canToggle,
  onToggle,
}: {
  lit: boolean;
  lapsed: boolean;
  rooms: string;
  many: boolean;
  until: string;
  whose: string;
  open: boolean;
  canToggle: boolean;
  onToggle: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!lit || !el) return;
    // After the dialog that set the block has closed and handed the page back its scroll.
    const t = window.setTimeout(() => el.scrollIntoView({ block: "nearest", behavior: "smooth" }), 250);
    return () => window.clearTimeout(t);
  }, [lit]);
  return (
    <div ref={ref} className={`hold-line${lit ? " lit" : ""}${lapsed ? " lapsed" : ""}`} role={lit ? "status" : undefined}>
      <Icon name="lock" />
      <span className="hold-text">
        <b>{rooms}</b> {lapsed ? (many ? "were" : "was") : many ? "are" : "is"} blocked until <b>{until}</b>
        <span className="hold-whose"> · {whose}</span>
        <Help label="About the block">
          The block takes these rooms from anyone else&rsquo;s marker. If the booking is not reserved by then, the rooms stay held, and the FOM and GM are told and decide.
        </Help>
      </span>
      {canToggle ? (
        <Button kind="quiet" compact onClick={onToggle}>
          {open ? "Hide" : "Edit"}
        </Button>
      ) : null}
    </div>
  );
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
  alsoFor,
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
  /** Viewing stays together: the same time for these stays too. */
  alsoFor?: Array<{ id: string; stayNo: number; holdLive: boolean }>;
}) {
  const { session } = useSession();
  const seed = hotelFormParts(currentIso ?? new Date(Date.now() + 60 * 60_000).toISOString(), tz);
  const [date, setDate] = useState(seed.date);
  const [time, setTime] = useState(seed.time);
  const [why, setWhy] = useState("");

  const save = useMutation({
    mutationFn: async (clear: boolean) => {
      // Setting a block time is how the desk blocks the rooms at Set up (2026-11-05).
      const body = (live: boolean) => (clear ? { clear: true, reason: why.trim() || undefined } : { date, time, reason: why.trim() || undefined, blockNow: !live });
      const out = await setCommittedHoldExpiry(session!, entry.id, body(holdLive));
      for (const o of alsoFor ?? []) {
        await setCommittedHoldExpiry(session!, o.id, body(o.holdLive))
          .then((r) => {
            if (r.blockRefused) toast.warning(`Stay ${o.stayNo}'s rooms are not blocked yet`, { description: r.blockRefused, duration: 10000 });
          })
          .catch((e) => toastRefusal(e, `Stay ${o.stayNo}'s block time was not changed`));
      }
      return out;
    },
    onSuccess: (out) => {
      // A block standing now is said on its line; one that could not be placed says why.
      if (out.blockRefused) {
        toast.warning("The block time is saved, but the rooms are not blocked yet", { description: out.blockRefused, duration: 10000 });
      } else if (!out.holdUpdated || out.note) {
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
      caseLines={[alsoFor?.length ? "The same time for every stay" : entry.id, houseWords ? `the hotel blocks for ${houseWords}` : "the hotel's own time"]}
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
      <p className="sm">{holdLive ? "The block standing now moves to this time." : "The rooms are blocked now, until this time."}</p>
      <div className="form2" style={{ marginTop: 10 }}>
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
          <TimeInput className="input" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
        <div className="wide field">
          <label>Why, if it is worth saying · optional</label>
          <input className="input" value={why} onChange={(e) => setWhy(e.target.value)} placeholder="the guest rang — they confirm after their flight lands" />
        </div>
      </div>
    </DsDialog>
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
  replyNotAsked,
  onAskAdvance,
  onChanged,
}: {
  entry: EntryDetail;
  editable: boolean;
  tz: string;
  proformas: InvoiceSummary[];
  current: InvoiceSummary | null;
  status: PaymentStatusSummary | undefined;
  passStart: string | null;
  /** Nothing more is wanted from the guest on this pass's proforma. */
  answered: boolean;
  /** …because their reply is not asked for (the admin console's setting). */
  replyNotAsked: boolean;
  /** The desk said yes to an advance here: the payment plan's advance box opens. */
  onAskAdvance: () => void;
  onChanged: () => void;
}) {
  const { session } = useSession();
  const flow = useStepFlow();
  const passes = passesOf(entry);
  const [paper, setPaper] = useState<PaperRef | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  // Every night named on the copy sent, instead of a run as its first and last (2026-10-30).
  const [nightsEach, setNightsEach] = useState(false);
  // The proforma is made out to the agency or company when one booked, so it goes to their
  // address, never the traveller's by default (2026-09-18) — the backend applies the same rule.
  const [to, setTo] = useSendTo(entry);
  const finish = useFinishWhenDone("proforma");
  const replyAsked = useReplyAsked(entry.id, "PROFORMA_INVOICE");
  // On a trip of several stays the trip's proforma is the guest's paper; this stay's own Send steps back.
  const onTrip = (useTripProforma(entry).data?.stays.length ?? 0) > 1;
  const qc = useQueryClient();
  const generate = useMutation({
    mutationFn: async () => {
      const out = await generateProforma(session!, entry.id);
      await qc.refetchQueries({ queryKey: ["entry", entry.id] });
      return out;
    },
    onSuccess: () => {
      toast.success("The proforma is generated, not sent");
      onChanged();
      finish();
    },
    onError: (e) => toastRefusal(e, "The proforma could not be generated"),
  });

  const draft = proformas.find((i) => i.state === "DRAFT") ?? null;
  const sendTarget = draft ?? proformas[0] ?? null;
  const send = useMutation({
    mutationFn: () => {
      if (!sendTarget) throw new Error("There is no proforma to send");
      return dispatchInvoice(session!, sendTarget.id, { dispatchedTo: to.trim() || undefined, nightsEach });
    },
    onSuccess: () => {
      toast.success(replyAsked ? "The proforma is sent — record the guest's answer when it comes" : "The proforma is sent");
      setSendOpen(false);
      setJustSent(true);
      onChanged();
      // No answer to wait for: the section is finished, as the answer finishes it otherwise.
      if (!replyAsked) finish(advanceAsked ? { next: "money" } : undefined);
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
    // Who pays is set and the advance is not answered: the question stands here, so a page closed or
    // read again never leaves the booking with no way to its bill (2026-11-05).
    const payerSet = !!entry.folio?.billingModel;
    const asked = (status?.requiredAmount ?? 0) > 0;
    return (
      <StepCard
        flow="proforma"
        flowAfter="billing-model"
        title="Proforma"
        icon="file"
        right={payerSet ? <Chip tone="warning">not generated yet</Chip> : null}
        meta="It prints the advance, so it is generated once who pays is set and the advance is answered. Not a tax invoice; the tax invoice is issued at check-out."
      >
        {!payerSet ? (
          <span className="sm">Choose who pays above — the proforma follows it.</span>
        ) : !editable ? (
          <span className="sm">Not generated.</span>
        ) : asked ? (
          <Button className="go" state={generate.isPending ? "working" : "default"} workingLabel="Generating…" onClick={() => generate.mutate()}>
            Generate the proforma
          </Button>
        ) : (
          <>
            <p className="sm" style={{ marginBottom: 10 }}>
              <b>Does the hotel want an advance on this booking?</b>
            </p>
            <div className="row-acts">
              <Button kind="secondary" state={generate.isPending ? "working" : "default"} workingLabel="Generating…" onClick={() => generate.mutate()}>
                No advance
              </Button>
              <Button
                state={generate.isPending ? "inert" : "default"}
                onClick={() => {
                  flow.open("money");
                  onAskAdvance();
                }}
              >
                Yes, ask for an advance
              </Button>
            </div>
          </>
        )}
      </StepCard>
    );
  }

  const shown = current ?? proformas[0];
  const no = billNo(shown);
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
  // Its time ended with the guest still to answer: it is made again (2026-11-05).
  const lapsed = !!shown.lapsedAt && shown.state !== "SUPERSEDED";
  const nextUp = !editable || lapsed ? null : advanceAsked && !sentLive ? "send" : answerDue ? "answer" : null;
  const sendLock = !editable
    ? "not at this step"
    : lapsed
      ? "it ran out. Make it again first"
    : status?.earlierAdvance?.asked
      ? "first say what happens to the advance paid before"
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
      invoiceType: "PROFORMA",
      label: `Proforma ${proformaBaseNo(inv)}${(inv.versionNumber ?? 1) > 1 ? ` · v${inv.versionNumber}` : ""}`,
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
      flowAfter="billing-model"
      keepRight
      // The number is in the title; the line says where the bill stands.
      summary={[
        asks,
        shown.dispatchedAt ? `sent ${fmtStamp(shown.dispatchedAt, tz)}` : null,
        shown.dispatchedAt && !replyNotAsked ? (answered ? "the guest's answer recorded" : "the guest's answer awaited") : null,
        shown.validUntil && !lapsed && !(status && status.requiredAmount > 0 && status.paidInFull) ? `valid until ${fmtDateTime(shown.validUntil, tz)}` : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      title={`Proforma · ${no}`}
      icon="file"
      // Where it stands with the guest, on the paper's own line as on the quotation (2026-11-05).
      right={
        lapsed ? (
          <Chip tone="danger">ran out</Chip>
        ) : !shown.dispatchedAt ? (
          <NotSentChip />
        ) : replyNotAsked ? (
          <Chip tone="quiet">sent</Chip>
        ) : answered ? (
          <Chip tone="success" icon="check">
            sent · answered
          </Chip>
        ) : (
          <Chip tone="warning">sent · awaiting the answer</Chip>
        )
      }
      meta="Not a tax invoice — the tax invoice is issued at check-out. Sending is optional, unless money is to be taken against it: a payment is logged against the bill the guest received."
      acts={
        <>
          <Button kind="secondary" compact icon="eye" onClick={() => setPaper(docRef(shown))}>
            Preview
          </Button>
          <Live>
            <Button
              kind={nextUp === "send" && !sendLock ? (onTrip ? "secondary" : "primary") : "quiet"}
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
        {shown.dispatchedAt ? ` · sent ${fmtStamp(shown.dispatchedAt, tz)}${shown.dispatchedTo ? ` to ${shown.dispatchedTo}` : ""}` : ""}
        {asks ? ` · ${asks}` : ""}
      </div>

      {lapsed && editable ? (
        <div className="notice ended pf-lapsed" role="alert">
          <span className="ended-mark" aria-hidden>
            !
          </span>
          <span>
            <b>This proforma ran out{shown.validUntil ? ` on ${fmtDateTime(shown.validUntil, tz)}` : ""}.</b>{" "}
            <span className="rest">The booking stays as it is. Make it again, then it can go out and the booking can move on.</span>
          </span>
          <Button className="go" state={generate.isPending ? "working" : "default"} workingLabel="Making it…" onClick={() => generate.mutate()}>
            Make it again
          </Button>
        </div>
      ) : !lapsed ? (
        <ProformaValidity entry={entry} inv={shown} status={status} editable={editable} tz={tz} onChanged={onChanged} />
      ) : null}

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
      ) : !replyNotAsked && (replyAsked || answered) ? (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)", display: "grid", gap: 6 }}>
          <span className="sm" style={{ fontWeight: 600 }}>
            The guest&rsquo;s answer
            {replyAsked ? <Help label="About the answer">Needed before Reserve once the proforma has been sent.</Help> : null}
          </span>
          <AnswerLine entryId={entry.id} type="PROFORMA_INVOICE" sinceIso={passStart} what="the proforma" tz={tz} onAnswered={finish} />
        </div>
      ) : null}

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
                    {proformaBaseNo(inv)} · v{inv.versionNumber ?? 1}
                    <span className="sub">{fmtStamp(inv.createdAt, tz)}</span>
                  </td>
                  {passes.many ? <td>{passNo != null ? `Pass ${passNo}${passNo === passes.currentNumber ? " · now" : ""}` : "earlier"}</td> : null}
                  <td>
                    <Chip tone={isCurrent ? "success" : "quiet"}>{isCurrent ? "current" : "replaced"}</Chip>{" "}
                    <span className="meta">
                      {inv.dispatchedAt ? "sent" : inv.state === "DRAFT" ? "generated · not sent" : words(inv.state).toLowerCase()}
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
          width={720}
          beside={<SendPaperPanel paper={docRef(sendTarget)} nightsEach={nightsEach} />}
          title={`Send proforma ${billNo(sendTarget)}`}
          caseLines={[
            asks ? `It ${asks}` : "The advance it asks for is being read",
            ...(replyAsked ? ["Once it goes out, the guest's answer is needed before money is logged"] : []),
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
          <div className="paper-faces in-dialog">
            <NightsChoice each={nightsEach} onChange={setNightsEach} of={{ invoiceId: sendTarget.id }} />
          </div>
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
              <PersonName
                title={splitTitle(name).title}
                name={splitTitle(name).name}
                onTitle={(t) => setName(joinTitled(t, splitTitle(name).name))}
                onName={(n) => setName(joinTitled(splitTitle(name).title, n))}
                autoFocus
              />
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

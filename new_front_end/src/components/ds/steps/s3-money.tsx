"use client";

/**
 * Set up · the payment plan — the advance as a chain, not a figure (SS03 §6.2, Storyboard 03).
 *
 * Rule → amount → due by → how they will pay → the bill → state → the remainder, with the acts in
 * the order the desk works them: what the guest must pay, how they will pay it, the proforma that
 * asks for it, then the money. Two locks hold that order at this step (backend p27): money is
 * logged only against a proforma that went out, and only once the guest's answer to it is on
 * record.
 *
 * Every figure is `GET /api/entries/:id/payment-status` — received, required, remaining — summed
 * server-side in Decimal. Nothing is added up here.
 */
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { BindingBox, Button, Chip, Icon, MoneyInput } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import {
  reconcileAdvancePayment,
  recordCreditExtension,
  ADVANCE_PAYMENT_MODES,
  recordFolioPayment,
  type AdvancePaymentMode,
  setAdvanceTerms,
} from "@/lib/api/reservation-setup";
import { expiryModeForPlanDue, resolveCreditExpiry, type CreditExpiryChoice } from "@/components/desk/workspace/advance-settlement";
import { fmtDate, fmtDateTime, fmtStamp, money, plural } from "@/lib/ds/format";
import { STEP_NAMES, stepNoOfStage } from "@/lib/ds/steps";
import type { AdvancePaymentPlanSummary, EntryDetail, InvoiceSummary, PaymentStatusSummary } from "@/types/api";
import { ActionRow, Choice, DsDialog, Fact, Facts, Live, SeeRow, StepCard, goToStepCard, toastRefusal, useFinishWhenDone, useStepFlow } from "./kit";
import { hotelLocalToIso, isoToHotelLocal } from "./s2-shared";
import { Help, HelpHere } from "@/components/ds/help";
import { DateTimeInput } from "@/components/ds/date-input";

/* ------------------------------------------------------------------ words */

const PLAN_WORD: Record<AdvancePaymentPlanSummary["plan"], string> = {
  FULL: "The whole amount",
  PARTIAL: "Part now — the rest later",
  INSTALLMENTS: "In instalments",
};

const PLAN_CHOICES = [
  ["FULL", "The whole amount"],
  ["PARTIAL", "Part now — the rest later"],
  ["INSTALLMENTS", "In instalments"],
] as const;
type PlanKind = (typeof PLAN_CHOICES)[number][0];

type Due = "" | "BEFORE_CHECKIN" | "AT_CHECKIN";

function dueWords(plan: AdvancePaymentPlanSummary["plan"], due: AdvancePaymentPlanSummary["balanceDueAt"]): string | null {
  if (!due) return plan === "FULL" ? "paying now, at the desk" : null;
  const subject = plan === "FULL" ? "paying" : "the rest";
  if (due === "BEFORE_CHECKIN") return `${subject} before check-in`;
  if (due === "AT_CHECKIN") return `${subject} at the check-in desk`;
  return `${subject} at check-out`;
}

/** The fixed list of payment modes (BE-13) — shown, not yet recordable. */
const REQUIREMENT_MODES = [
  ["PERCENT", "A percent of the quotation"],
  ["AMOUNT", "A flat amount"],
] as const;
type RequirementMode = (typeof REQUIREMENT_MODES)[number][0];
/** The amount's choice in the advance box — "the hotel's default" is offered when this booking set its own. */
type AmountMode = RequirementMode | "DEFAULT";

type Reissued = { versionNumber: number; supersededIds: string[] } | null | undefined;

function reissueWords(r: Reissued): string | null {
  if (!r) return null;
  return r.supersededIds.length > 0
    ? `The proforma was issued again (version ${r.versionNumber}) — send it to the guest again.`
    : `A fresh proforma (version ${r.versionNumber}) is ready for this pass — send it when ready.`;
}

function isAmount(v: string): boolean {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) && n > 0;
}

/* ------------------------------------------------------------------ the card */

export function PaymentPlanCard({
  entry,
  editable,
  elevated,
  status,
  statusLoading,
  refetching,
  onRefetch,
  tz,
  bill,
  askAdvance = 0,
  onRoomsBlocked,
  onChanged,
  setUp = true,
}: {
  entry: EntryDetail;
  editable: boolean;
  elevated: boolean;
  status: PaymentStatusSummary | undefined;
  statusLoading: boolean;
  refetching: boolean;
  onRefetch: () => void;
  tz: string;
  /** This pass's proforma, whether it went out, and whether the guest's answer is on record. */
  bill: { proforma: InvoiceSummary | null; dispatched: boolean; answered: boolean };
  /** Raised when the desk says yes to an advance after the terms: the advance box opens. */
  askAdvance?: number;
  /**
   * A payment came in and the rooms were blocked by it (`until`), or not (`null`) — the hold card
   * then asks whether to set a block time, or shows itself to block them by hand (2026-10-28).
   */
  onRoomsBlocked?: (until: string | null) => void;
  onChanged: () => void;
  /**
   * Reserve's advance (2026-10-29, operator: "sometimes the advance can be paid even in stage 4 … it
   * can have the option there to file an advance payment like in stage 3"): the same card, not a
   * section of the step's flow. Money is not held for the proforma there — bill-before-money and
   * answer-before-money are Set-up rules — and a payment can be recorded even once the advance is
   * paid, the guest paying more ahead.
   */
  setUp?: boolean;
}) {
  const { session } = useSession();
  const folio = entry.folio ?? null;
  const [open, setOpen] = useState<null | "advance" | "pay" | "credit">(null);
  useEffect(() => {
    if (askAdvance > 0) setOpen("advance");
  }, [askAdvance]);
  // Money in, or credit extended, finishes the section once it covers the advance (2026-10-28).
  const finish = useFinishWhenDone("money");
  const moneyIn = () => {
    onChanged();
    finish();
  };
  /**
   * The advance, then the proforma (2026-10-28, operator: "when I change the amount asked and
   * record how they'll pay, I have to send the proforma first, so it should take the user to that
   * section and tell them there"). The proforma prints both, and money is taken only against a
   * proforma the guest has, so a saved advance goes on to it while it still has to be sent.
   */
  const flow = useStepFlow();
  const goToProforma = () => {
    if (flow.on) flow.open("proforma");
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => goToStepCard("proforma")));
  };
  const afterAdvance = (askedNow: number, reissued: boolean) => {
    onChanged();
    if (!setUp) {
      if (reissued) toast.info("A new proforma was made with the new advance", { description: "It waits, not sent, in the booking file — Papers › Proforma invoices." });
      return;
    }
    if (askedNow > 0 && (reissued || !bill.dispatched)) goToProforma();
  };
  /** A payment came in: the money section finishes, and the hold card takes it from there. */
  const paid = (blockedUntil: string | null | undefined) => {
    moneyIn();
    if (blockedUntil !== undefined) onRoomsBlocked?.(blockedUntil);
  };

  const inPayments = (folio?.payments ?? []).filter((p) => /IN/i.test(p.paymentDirection ?? "") && !/OUT|REFUND/i.test(p.paymentDirection ?? ""));
  const reconciled = !!folio?.advancePaymentReconciliationComplete;
  const received = status?.totalReceived ?? 0;
  const plan = status?.paymentPlan ?? null;
  const cur = folio?.lines?.[0]?.currency;

  const reconcileM = useMutation({
    mutationFn: () => reconcileAdvancePayment(session!, folio!.id, { entryId: entry.id }),
    onSuccess: () => {
      toast.success("The money position is signed off");
      onChanged();
    },
    onError: (e) => toastRefusal(e, "The money position could not be signed off"),
  });

  /* ---- the locks, in the order the desk meets them ---- */
  /**
   * Why money cannot be logged yet — and WHICH card on this step would release it
   * (2026-10-06, operator: "to record payment it doesn't tell how the user should do it ... the
   * UI UX should be able to do it"). The words alone left the person to find the place
   * themselves; `card` turns the blocker into a button that takes them there.
   */
  const payHold: { why: string; card: string; cta: string } | null = !folio
    ? { why: "Open the provisional bill first — money has nowhere to land until there is one.", card: "billing-model", cta: "Open the bill" }
    : !setUp
      ? null
      : !bill.dispatched
      ? { why: "Send the proforma first — money is logged against the bill the guest received.", card: "proforma", cta: "Go to the proforma" }
      : !bill.answered
        ? { why: "Record the guest's answer to the proforma first.", card: "proforma", cta: "Go to the proforma" }
        : null;
  const payLock = payHold?.why ?? null;
  // The proforma went out, the guest answered, and the advance is still short: money is next.
  const payDue = !payHold && !!status && status.requiredAmount > 0 && !status.paidInFull && status.shortfall > 0;
  const reconcilable = received > 0 || inPayments.length > 0 || ["DIRECT_BILL", "GOVERNMENT"].includes(folio?.billingModel ?? "");
  const reconcileLock = !folio
    ? "open the provisional bill first"
    : reconciled
      ? "already signed off"
      : !reconcilable
        ? "nothing received yet"
        : null;

  const nothingAsked = !!status && status.requiredAmount === 0 && received === 0 && !status.creditExtensionActive;
  const stateChip = !status ? null : status.paidInFull ? (
    <Chip tone="success" icon="check">
      received
    </Chip>
  ) : status.requiredAmount === 0 ? (
    <Chip tone="quiet">nothing asked</Chip>
  ) : status.satisfied ? (
    <Chip tone="accent">covered by credit</Chip>
  ) : received > 0 ? (
    <Chip tone="warning">part received</Chip>
  ) : (
    <Chip tone="warning">not received</Chip>
  );

  // The line the section folds to once the advance is settled (2026-10-28) — the server's figures.
  const summary = !status
    ? undefined
    : status.requiredAmount === 0 && received === 0
      ? "No advance asked"
      : status.paidInFull
        ? `Received ${money(received, cur)} of ${money(status.requiredAmount, cur)}`
        : status.satisfied
          ? `Covered by credit · received ${money(received, cur)} of ${money(status.requiredAmount, cur)}`
          : `Received ${money(received, cur)} of ${money(status.requiredAmount, cur)}`;
  const basis = status?.requirementBasis ?? null;
  const advWindow = status?.advanceWindow ?? null;
  const shortWithPlan =
    !!status && !status.paidInFull && received > 0 && !!plan && (plan.plan !== "FULL" || !!plan.balanceDueAt) && !status.creditExtensionActive;

  return (
    <StepCard
      flow={setUp ? "money" : undefined}
      flowAfter={setUp ? "proforma" : undefined}
      title={setUp ? "The payment plan" : "The advance"}
      right={stateChip}
      summary={setUp ? summary : undefined}
    >
      {!folio ? (
        <span className="meta">The plan is set once the provisional bill exists — choose the billing model above.</span>
      ) : !status ? (
        <span className="meta">{statusLoading ? "Reading what has been paid…" : "The payment position could not be read."}</span>
      ) : (
        <>
          {nothingAsked ? (
            <BindingBox family="bound" stateWord="no advance" style={{ marginBottom: 10 }}>
              <div className="sm" style={{ paddingRight: 90 }}>
                No advance is asked for this booking ·{" "}
                {status.requirementSource === "OPERATOR" ? "set for this booking" : "the hotel's settings ask for nothing"}
              </div>
            </BindingBox>
          ) : null}
          <Facts wide>
            <Fact
              k="Rule"
              meta={
                status.requirementSource === "OPERATOR"
                  ? `set for this booking · the hotel's minimum stays ${money(status.configuredBaseAmount ?? null, cur)}`
                  : status.groupBoostApplied
                    ? `raised to ${status.groupBoostApplied.multiplierPercent}% for a group · the base is ${money(status.groupBoostApplied.baseAmount, cur)}`
                    : "from the hotel's settings"
              }
            >
              {status.requirementSource === "OPERATOR"
                ? basis?.mode === "PERCENT"
                  ? `advance ${basis.percent}% of the quotation`
                  : "a flat advance"
                : "the house advance"}
            </Fact>
            <Fact
              k="Amount"
              meta={basis?.mode === "PERCENT" && basis.baseTotal != null ? `${basis.percent}% of ${money(basis.baseTotal, cur)}` : undefined}
            >
              <b className="money">{money(status.requiredAmount, cur)}</b>
            </Fact>
            <Fact
              k="Due by"
              meta={
                advWindow?.overdue
                  ? undefined
                  : advWindow?.opensAt
                    ? `the window opened when the proforma went out · ${fmtStamp(advWindow.opensAt, tz)}`
                    : "check-in · the window opens when the proforma goes out"
              }
            >
              {advWindow?.deadline || entry.checkInDate ? (
                <>
                  {fmtDate(advWindow?.deadline ?? entry.checkInDate)}
                  {advWindow?.overdue ? <b style={{ color: "var(--danger)" }}> · overdue — check-in passed with the advance unpaid</b> : null}
                </>
              ) : null}
            </Fact>
            <Fact k="How they'll pay">
              {plan ? (
                <>
                  {plan.plan === "FULL" && plan.balanceDueAt ? "The whole amount" : PLAN_WORD[plan.plan]}
                  {dueWords(plan.plan, plan.balanceDueAt) ? ` · ${dueWords(plan.plan, plan.balanceDueAt)}` : ""}
                  {plan.balanceDueAt === "BEFORE_CHECKIN" && plan.promisedBy ? (
                    <>
                      {" "}
                      · by <b>{fmtDateTime(plan.promisedBy, tz)}</b>
                    </>
                  ) : null}
                  {plan.promiseOverdue && !status.paidInFull ? <b className="warn-ink"> · the promise lapsed</b> : null}
                  {plan.note ? <span className="meta"> · “{plan.note}”</span> : null}
                </>
              ) : (
                <span className="meta">not recorded yet</span>
              )}
            </Fact>
            <Fact k="The bill">
              {bill.proforma ? (
                <>
                  Proforma {bill.proforma.invoiceNumber ?? bill.proforma.id}
                  {bill.dispatched ? (
                    <span className="meta">
                      {" "}
                      · sent{bill.proforma.dispatchedAt ? ` ${fmtStamp(bill.proforma.dispatchedAt, tz)}` : ""} ·{" "}
                      {bill.answered ? "their answer is on record" : "awaiting their answer"}
                    </span>
                  ) : (
                    <span className="meta"> · generated, not sent</span>
                  )}
                </>
              ) : (
                <span className="meta">no proforma yet</span>
              )}
            </Fact>
            <Fact k="Received" meta={(status.installments?.length ?? 0) > 1 ? `in ${status.installments!.length} payments` : undefined}>
              <span className="money">{money(status.totalReceived, cur)}</span> <span className="meta">of {money(status.requiredAmount, cur)}</span>
            </Fact>
            <Fact k="The remainder" meta={status.shortfall > 0 && plan ? (dueWords(plan.plan, plan.balanceDueAt) ?? undefined) : undefined}>
              {status.shortfall > 0 ? <span className="money">{money(status.shortfall, cur)}</span> : "nothing left to pay on the advance"}
            </Fact>
            {status.creditExtensionActive || status.creditExtensionExpired ? (
              <Fact k="Credit">
                {status.creditExtensionActive ? (
                  <>
                    up to <span className="money">{money(status.ceilingAmount, cur)}</span>
                    <span className="meta">
                      {" "}
                      · {status.creditExtensionExpiresAt ? `until ${fmtDateTime(status.creditExtensionExpiresAt, tz)}` : "no time limit"}
                    </span>
                  </>
                ) : (
                  <span className="warn-ink">the credit extension ran out — it no longer counts</span>
                )}
              </Fact>
            ) : null}
            {reconciled ? <Fact k="Signed off">yes — the money position is accepted</Fact> : null}
          </Facts>

          {status.installments?.length ? (
            <table className="table compact" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th>Received</th>
                  <th>At</th>
                  <th>Note</th>
                  <th style={{ textAlign: "right" }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {status.installments.map((p) => (
                  <tr key={p.id} className="static">
                    <td className="nowrap">{fmtStamp(p.receivedAt, tz)}</td>
                    <td>{p.stage ? STEP_NAMES[stepNoOfStage(p.stage) - 1] : <span className="dash">—</span>}</td>
                    <td>{p.notes || <span className="dash">—</span>}</td>
                    <td className="money" style={{ textAlign: "right" }}>
                      {money(p.amount, cur)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {status.installments?.length ? (
            <HelpHere label="About receipts">
              Every payment is kept on the booking. A printed receipt can&rsquo;t be made yet.
            </HelpHere>
          ) : null}
          {shortWithPlan && setUp ? (
            <div className="sm warn-ink" style={{ marginTop: 8 }}>
              The guest still owes {money(status.shortfall, cur)} and said {plan!.plan === "FULL" ? "they would pay" : "the rest comes"}{" "}
              {plan!.balanceDueAt === "BEFORE_CHECKIN" ? "before check-in" : plan!.balanceDueAt === "AT_CHECKIN" ? "at the check-in desk" : "later"}.
              To reserve before the money lands, the FOM covers the remainder with credit.
            </div>
          ) : null}
        </>
      )}

      <Live>
        {editable && folio && payDue ? (
          <div className="notice next" role="status" style={{ marginTop: 12, marginBottom: 0 }}>
            <span>
              <b>Record the payment now.</b>{" "}
              {setUp ? "The guest has the proforma and their answer is on record — " : ""}
              {money(status!.shortfall, cur)} of the advance is still to come.
            </span>
          </div>
        ) : null}
        {editable && folio ? (
          // The acts side by side, not one per line (2026-10-28, operator: "the buttons are taking
          // needless space by being arranged vertically, make it horizontal").
          <div className="actbar">
            <ActionRow
              label={status?.requirementSource === "OPERATOR" || plan ? "Change the advance" : "Set the advance"}
              caption="How much the guest pays, and how and when. The proforma prints both, so a change issues it again."
              onClick={() => setOpen("advance")}
            />
            <ActionRow
              kind="primary"
              // Green and full size once it is time (2026-10-28, operator: "more prominent than just a
              // black button, so the user knows it's time to record the payment now").
              className={payDue ? "go big" : undefined}
              label="Record payment"
              caption={
                setUp
                  ? "The rooms are blocked automatically when money comes in — even part of it."
                  : "It goes on the booking's bill with the advance already received."
              }
              onClick={() => setOpen("pay")}
              state={payHold ? "inert" : "default"}
              heldBy={payHold?.why}
              goTo={payHold?.card}
              goToLabel={payHold?.cta}
            />
            <ActionRow
              label="Mark reconciled"
              caption="Signs off the money position — ticks the arrival checklist and stops the chasing. It needs money received first; a direct-bill booking is the exception."
              onClick={() => reconcileM.mutate()}
              state={reconcileM.isPending ? "working" : reconcileLock ? "inert" : "default"}
              heldBy={reconcileLock}
            />
            <ActionRow
              label="Extend credit"
              caption="Lets the booking go on without the advance, up to a ceiling and for a time."
              onClick={elevated ? () => setOpen("credit") : undefined}
              state={elevated ? "default" : "inert"}
              heldBy={elevated ? null : "Extending credit is the FOM's call."}
            />
            <ActionRow
              label="Read the payment again"
              caption="When money was logged on another terminal."
              onClick={onRefetch}
              state={refetching ? "working" : "default"}
            />
          </div>
        ) : null}
      </Live>

      {open === "advance" ? <AdvanceDialog entry={entry} status={status} tz={tz} onClose={() => setOpen(null)} onDone={afterAdvance} /> : null}
      {open === "pay" && folio ? (
        <PaymentDialog entry={entry} folioId={folio.id} status={status} currency={cur} onClose={() => setOpen(null)} onDone={paid} />
      ) : null}
      {open === "credit" ? (
        <CreditDialog entry={entry} status={status} tz={tz} currency={cur} onClose={() => setOpen(null)} onDone={moneyIn} />
      ) : null}
    </StepCard>
  );
}

/* ------------------------------------------------------------------ the advance */

/**
 * The advance in one box (2026-10-28, operator: "change the amount asked and record how they'll pay
 * should be inside one button"): how much the guest pays, and how and when. Saved together, so the
 * proforma — which prints both — is issued again once. Only what changed is sent: an amount left
 * as it is, or no answer picked for how they'll pay, is left alone.
 */
function AdvanceDialog({
  entry,
  status,
  tz,
  onClose,
  onDone,
}: {
  entry: EntryDetail;
  status: PaymentStatusSummary | undefined;
  tz: string;
  onClose: () => void;
  /** With the amount now asked, and whether the proforma was issued again. */
  onDone: (askedNow: number, reissued: boolean) => void;
}) {
  const { session } = useSession();
  const clock = useHotelClock(60_000);
  const nowLocal = isoToHotelLocal(clock.now, tz);

  /* ---- how much ---- */
  // The box opens on the figure set for this booking, never on a grey example (2026-10-23: a
  // placeholder "50" read as the value already there). A first advance opens with nothing chosen,
  // and each question appears once the one before it is answered (2026-10-28, operator: "step by
  // step — ask for, the figure, how they'll pay, when the rest is coming, then save").
  const pinned = status?.requirementSource === "OPERATOR" ? status.requirementBasis : null;
  const pinnedMode: AmountMode | null = pinned ? (pinned.mode === "AMOUNT" ? "AMOUNT" : "PERCENT") : null;
  const pinnedValue =
    pinned?.mode === "PERCENT" && pinned.percent != null
      ? String(pinned.percent)
      : pinned?.mode === "AMOUNT" && status?.requiredAmount != null
        ? String(status.requiredAmount)
        : "";
  const [mode, setMode] = useState<AmountMode | null>(pinnedMode);
  const [value, setValue] = useState(pinnedValue);
  const amountModes: ReadonlyArray<readonly [AmountMode, string]> = pinned ? [...REQUIREMENT_MODES, ["DEFAULT", "The hotel's default"] as const] : REQUIREMENT_MODES;
  const n = Number(value);
  const typed = value.trim() !== "";
  const amountOk = mode === "DEFAULT" || (mode === "PERCENT" && isAmount(value) && n <= 100) || (mode === "AMOUNT" && isAmount(value));
  const requirement =
    mode === "DEFAULT"
      ? pinned
        ? ({ mode: "CLEAR" } as const)
        : null
      : !mode || !amountOk
        ? null
        : pinnedMode === mode && pinnedValue === value.trim()
          ? null
          : mode === "AMOUNT"
            ? ({ mode: "AMOUNT", amount: n } as const)
            : ({ mode: "PERCENT", percent: n } as const);
  // Back to the hotel's settings when they ask for nothing: there is nothing for the guest to pay,
  // so there is no plan to ask about either.
  const noAdvance = mode === "DEFAULT" && (status?.configuredBaseAmount ?? 0) <= 0;

  /* ---- how and when they'll pay ---- */
  const saved = status?.paymentPlan ?? null;
  const savedDue: Due | null = saved ? (saved.balanceDueAt ? (saved.balanceDueAt === "AT_CHECKOUT" ? "AT_CHECKIN" : saved.balanceDueAt) : "") : null;
  const savedPromised = saved?.promisedBy ? isoToHotelLocal(saved.promisedBy, tz) : "";
  // Nothing is picked until the desk picks it — opening the box to change the amount must not
  // record "the whole amount, now" on the guest's behalf.
  const [plan, setPlan] = useState<PlanKind | null>(saved?.plan ?? null);
  const [due, setDue] = useState<Due | null>(savedDue);
  const [promised, setPromised] = useState(savedPromised);
  const [note, setNote] = useState(saved?.note ?? "");
  const [clearPlan, setClearPlan] = useState(false);
  // A plan is asked for whenever there is an advance to pay; clearing it is an answer too.
  const planAsked = !noAdvance && !clearPlan;
  const planChanged =
    clearPlan || (noAdvance && !!saved)
      ? !!saved
      : plan != null &&
        due != null &&
        (plan !== (saved?.plan ?? null) || due !== savedDue || promised !== savedPromised || note.trim() !== (saved?.note ?? "").trim());
  const planBody = (): NonNullable<Parameters<typeof setAdvanceTerms>[2]["plan"]> | null => {
    if (clearPlan || noAdvance) return saved ? { plan: "CLEAR" } : null;
    if (!plan || due == null || !planChanged) return null;
    const note_ = note.trim() || null;
    if (due === "") return { plan, note: note_ };
    if (due === "BEFORE_CHECKIN") {
      const iso = hotelLocalToIso(promised, tz);
      if (!iso) throw new Error("Pick the date the guest promised");
      return { plan, balanceDueAt: due, promisedBy: iso, note: note_ };
    }
    return { plan, balanceDueAt: due, note: note_ };
  };

  const save = useMutation({
    mutationFn: () => {
      const p = planBody();
      return setAdvanceTerms(session!, entry.id, { ...(requirement ? { requirement } : {}), ...(p ? { plan: p } : {}) });
    },
    onSuccess: (res) => {
      const words = [
        requirement ? (requirement.mode === "CLEAR" ? "the hotel's default advance applies again" : `the advance is ${money(res.requiredAmount)}`) : null,
        clearPlan || (noAdvance && saved) ? "how they'll pay is cleared" : planChanged ? "how they'll pay is recorded" : null,
      ].filter(Boolean);
      const said = words.join(" · ");
      toast.success(said.charAt(0).toUpperCase() + said.slice(1), {
        description: reissueWords(res.reissuedProforma) ?? undefined,
        duration: res.reissuedProforma ? 9000 : undefined,
      });
      onClose();
      onDone(Number(res.requiredAmount ?? 0), !!res.reissuedProforma);
    },
    onError: (e) => toastRefusal(e, "The advance could not be saved"),
  });

  const timing: ReadonlyArray<readonly [Due, string]> =
    plan === "PARTIAL" || plan === "INSTALLMENTS"
      ? [
          ["BEFORE_CHECKIN", "Before check-in, by a date"],
          ["AT_CHECKIN", "At the check-in desk"],
        ]
      : [
          ["", "Now, at the desk"],
          ["BEFORE_CHECKIN", "Before check-in, by a date"],
          ["AT_CHECKIN", "At the check-in desk"],
        ];

  // The questions in order; each one answered opens the next.
  const askedFor = mode != null;
  const figureIn = askedFor && amountOk;
  const planIn = figureIn && (!planAsked || plan != null);
  const dueIn = planIn && (!planAsked || due != null);
  const dateIn = dueIn && (!planAsked || due !== "BEFORE_CHECKIN" || !!promised);
  const changed = !!requirement || planChanged;
  const holdReason = !askedFor
    ? "Choose how much to ask for"
    : !figureIn
      ? mode === "PERCENT"
        ? typed
          ? "Put in a percent from 1 to 100"
          : "Put in the percent"
        : typed
          ? "Put in an amount above zero"
          : "Put in the amount"
      : !planIn
        ? "Pick how they'll pay"
        : !dueIn
          ? plan === "FULL"
            ? "Pick when they'll pay"
            : "Pick when the rest is coming"
          : !dateIn
            ? "Pick the date they promised"
            : !changed
              ? "Nothing changed yet"
              : undefined;

  let q = 0;
  const num = () => ++q;

  return (
    <DsDialog
      open
      onClose={onClose}
      busy={save.isPending}
      width={620}
      title="The advance"
      caseLines={[
        status
          ? `Asked now: ${money(status.requiredAmount)} · ${status.requirementSource === "OPERATOR" ? "set for this booking" : "the hotel's default"} · received ${money(status.totalReceived)}`
          : "Nothing read yet",
      ]}
      help="The proforma prints the amount and how the guest will pay, so a change issues it again — to send again."
      footer={
        <>
          {holdReason ? (
            <span className="dlg-next" role="status">
              {holdReason}
            </span>
          ) : null}
          <Button2 kind="quiet" disabled={save.isPending} onClick={onClose}>
            Not now
          </Button2>
          {/* Green and full size once every answer is in (2026-10-28, operator: "make the button more prominent"). */}
          <Button2 className="go big" working={save.isPending} disabled={!!holdReason} reason={holdReason} onClick={() => save.mutate()}>
            Save the advance
          </Button2>
        </>
      }
    >
      <div className="qsteps">
        <Ask n={num()} done={askedFor} label="Ask for">
          <Choice
            options={amountModes}
            value={mode}
            onChange={(m) => {
              setMode(m);
              setValue(m === pinnedMode ? pinnedValue : ""); // 20 percent is not Nu 20
            }}
          />
        </Ask>

        {mode === "PERCENT" || mode === "AMOUNT" ? (
          <Ask
            n={num()}
            done={figureIn}
            label={mode === "PERCENT" ? "Percent of the quotation" : "Amount"}
            help={
              <Help label="About the amount">
                {mode === "PERCENT"
                  ? "The house works the figure out from the quotation now — if the quotation changes, set it again."
                  : "For this booking only — the hotel's minimum is untouched."}
              </Help>
            }
          >
            {mode === "AMOUNT" ? (
              <MoneyInput key="amount" value={value} onChange={(e) => /^\d*\.?\d{0,2}$/.test(e.target.value) && setValue(e.target.value)} autoFocus />
            ) : (
              <div className="suffix">
                <input
                  key="percent"
                  className="input narrow"
                  inputMode="decimal"
                  aria-label="Percent of the quotation"
                  value={value}
                  onChange={(e) => /^\d*\.?\d{0,2}$/.test(e.target.value) && setValue(e.target.value)}
                  autoFocus
                />
                <span aria-hidden="true">%</span>
              </div>
            )}
          </Ask>
        ) : mode === "DEFAULT" ? (
          <p className="meta qnote">
            The amount set for this booking is dropped — the hotel&rsquo;s settings decide again
            {noAdvance ? (
              <>
                . They ask for no advance on this booking, so there is nothing for the guest to pay
                {saved ? <> and how they&rsquo;ll pay is cleared too</> : null}.
              </>
            ) : (
              <> — they ask for {money(status?.configuredBaseAmount ?? 0)}.</>
            )}
          </p>
        ) : null}

        {figureIn && planAsked ? (
          <Ask n={num()} done={planIn} label="How will they pay?" sep>
            <Choice
              options={PLAN_CHOICES}
              value={plan}
              onChange={(next) => {
                setPlan(next);
                // "Now, at the desk" is an answer only for the whole amount.
                if (next !== "FULL" && due === "") setDue(null);
              }}
            />
            {saved ? (
              <div style={{ marginTop: 8 }}>
                <Button2 kind="quiet" onClick={() => setClearPlan(true)}>
                  Clear how they&rsquo;ll pay
                </Button2>
              </div>
            ) : null}
          </Ask>
        ) : null}
        {figureIn && clearPlan ? (
          <p className="sm qnote qsep">
            How they&rsquo;ll pay is cleared when you save.{" "}
            <Button2 kind="quiet" onClick={() => setClearPlan(false)}>
              Keep it
            </Button2>
          </p>
        ) : null}

        {planIn && planAsked ? (
          <Ask n={num()} done={dueIn} label={plan === "FULL" ? "When will they pay?" : "When is the rest coming?"}>
            <Choice options={timing} value={due} onChange={setDue} />
            {due === "AT_CHECKIN" ? (
              <p className="meta" style={{ marginTop: 6 }}>
                No countdown — the money is collected at the check-in desk. To check in unpaid, the FOM covers the gap with credit.
              </p>
            ) : null}
          </Ask>
        ) : null}

        {dueIn && planAsked && due === "BEFORE_CHECKIN" ? (
          <Ask
            n={num()}
            done={dateIn}
            label="Promised by"
            help={
              <Help label="About the promise">
                On the hotel&rsquo;s clock. A countdown runs to it and the booking is flagged if the money has not come. A date after check-in
                is taken as check-in.
              </Help>
            }
          >
            <DateTimeInput className="input" value={promised} min={nowLocal || undefined} onChange={(e) => setPromised(e.target.value)} />
          </Ask>
        ) : null}

        {dateIn && planAsked ? (
          <Ask n={num()} done={false} optional label="What they said, in their words · optional">
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="will transfer the rest after payday" />
          </Ask>
        ) : null}
      </div>
    </DsDialog>
  );
}

/** One question in a box that asks one thing at a time: its number (a tick once answered), its label, its answer. */
function Ask({
  n,
  done,
  optional,
  sep,
  label,
  help,
  children,
}: {
  n: number;
  done: boolean;
  optional?: boolean;
  /** A line above it — the start of a new part of the box. */
  sep?: boolean;
  label: React.ReactNode;
  help?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={["qstep", done ? "done" : "", optional ? "optional" : "", sep ? "qsep" : ""].filter(Boolean).join(" ")}>
      <span className="qn" aria-hidden="true">
        {done ? <Icon name="check" /> : n}
      </span>
      <div className="field">
        <label>
          {label}
          {help}
        </label>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ the money */

function PaymentDialog({
  entry,
  folioId,
  status,
  currency,
  onClose,
  onDone,
}: {
  entry: EntryDetail;
  folioId: string;
  status: PaymentStatusSummary | undefined;
  currency?: string;
  onClose: () => void;
  /**
   * With when the rooms are now blocked to: the time when this payment blocked them, `null` when
   * it should have and could not, `undefined` when it was not for this payment to block them.
   */
  onDone: (blockedUntil: string | null | undefined) => void;
}) {
  const { session } = useSession();
  // Prefilled with what is owed only while nothing has been paid (2026-08-07 ruling) — after a
  // part-payment a refilled box read like a second bill due now.
  const [amount, setAmount] = useState(status && status.shortfall > 0 && status.totalReceived === 0 ? String(status.shortfall) : "");
  const [notes, setNotes] = useState("");
  // How it came in (2026-09-18) — stored on the payment; every advance used to be recorded as cash.
  const [mode, setMode] = useState<AdvancePaymentMode | null>(null);
  const pay = useMutation({
    mutationFn: () =>
      recordFolioPayment(session!, folioId, {
        entryId: entry.id,
        amount: Number(amount),
        notes: notes.trim() || undefined,
        paymentMethod: mode ?? undefined,
      }),
    onSuccess: (res) => {
      toast.success(`${money(Number(amount), currency)} recorded`);
      const ah = res.autoHold;
      // A block placed by this payment is asked about on the hold card — keep the time, or set
      // one (2026-10-28). One the payment could not place is said here, and the card shows itself.
      let blockedUntil: string | null | undefined;
      if (ah?.placed) blockedUntil = ah.expiresAt;
      else if (ah && !ah.placed && ah.reason !== "ALREADY_HELD" && ah.reason !== "NOT_AT_S3") {
        toast.warning("The rooms were not blocked automatically", {
          description: `${ah.message} — block them by hand.`,
          duration: 10000,
        });
        blockedUntil = null;
      }
      onClose();
      onDone(blockedUntil);
    },
    onError: (e) => toastRefusal(e, "The payment could not be recorded"),
  });
  const ok = isAmount(amount) && !!mode;
  const prefilled = !!status && status.shortfall > 0 && amount === String(status.shortfall);
  return (
    <DsDialog
      open
      onClose={onClose}
      busy={pay.isPending}
      title="Record payment"
      caseLines={
        status
          ? [
              `Asked ${money(status.requiredAmount, currency)} · received ${money(status.totalReceived, currency)} · still owed ${money(status.shortfall, currency)}`,
            ]
          : undefined
      }
      footer={
        <>
          <Button2 kind="quiet" disabled={pay.isPending} onClick={onClose}>
            Not now
          </Button2>
          <Button2
            working={pay.isPending}
            disabled={!ok}
            reason={ok ? undefined : !isAmount(amount) ? "put in the amount received" : "choose how it was paid"}
            onClick={() => pay.mutate()}
          >
            Record the payment
          </Button2>
        </>
      }
    >
      <div className="field">
        <label>
          Amount received
          <Help label="About the amount">The gross the guest paid.{prefilled ? " Filled with what is still owed on the advance — change it if they paid a different amount." : ""}</Help>
        </label>
        <MoneyInput value={amount} onChange={(e) => /^\d*\.?\d{0,2}$/.test(e.target.value) && setAmount(e.target.value)} autoFocus />
        {status && status.shortfall > 0 && !prefilled ? (
          <span className="hint">
            still owed {money(status.shortfall, currency)} ·{" "}
            <a
              href="#use"
              onClick={(e) => {
                e.preventDefault();
                setAmount(String(status.shortfall));
              }}
            >
              use that
            </a>
          </span>
        ) : null}
      </div>
      <div className="field">
        <label>
          How it was paid
          <Help label="About the payment">
            Put the bank slip&rsquo;s or the transfer&rsquo;s reference in the note. The payment is recorded with today&rsquo;s date — if it was paid on another day, say so in the note. A printed receipt can&rsquo;t be made yet.
          </Help>
        </label>
        <Choice options={ADVANCE_PAYMENT_MODES} value={mode} onChange={setMode} />
      </div>
      <div className="field">
        <label>Note</label>
        <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="QR · paid from India · ref 4471…" />
      </div>
      <p className="meta">
        {entry.committedHold
          ? "The rooms are already held."
          : entry.cancellationDisclosure
            ? "A payment — even part of the advance — holds the rooms automatically."
            : "A payment holds the rooms automatically only once the terms are disclosed — record the disclosure first, or place the hold by hand after."}
      </p>
    </DsDialog>
  );
}

/* ------------------------------------------------------------------ credit (the FOM) */

function CreditDialog({
  entry,
  status,
  tz,
  currency,
  onClose,
  onDone,
}: {
  entry: EntryDetail;
  status: PaymentStatusSummary | undefined;
  tz: string;
  currency?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { session } = useSession();
  const anchors = {
    promisedBy: status?.paymentPlan?.promisedBy ?? null,
    checkInDate: entry.checkInDate ?? null,
    checkOutDate: entry.checkOutDate ?? null,
  };
  const [ceiling, setCeiling] = useState(status && status.shortfall > 0 ? String(status.shortfall) : "");
  const [reason, setReason] = useState("");
  const [choice, setChoice] = useState<CreditExpiryChoice>(() => ({
    mode: expiryModeForPlanDue(status?.paymentPlan?.balanceDueAt ?? null, anchors) ?? "NONE",
    hours: "",
  }));
  const extend = useMutation({
    mutationFn: () =>
      recordCreditExtension(session!, entry.id, {
        ceilingAmount: Number(ceiling),
        reason: reason.trim(),
        ...resolveCreditExpiry(choice, anchors),
      }),
    onSuccess: () => {
      toast.success(`Credit extended up to ${money(Number(ceiling), currency)}`);
      onClose();
      onDone();
    },
    onError: (e) => toastRefusal(e, "The credit could not be extended"),
  });
  const hoursOk = choice.mode !== "HOURS" || isAmount(choice.hours);
  const ok = isAmount(ceiling) && reason.trim().length > 0 && hoursOk;
  return (
    <DsDialog
      open
      onClose={onClose}
      busy={extend.isPending}
      title="Extend credit"
      caseLines={status ? [`Still owed on the advance: ${money(status.shortfall, currency)}`] : undefined}
      footer={
        <>
          <Button2 kind="quiet" disabled={extend.isPending} onClick={onClose}>
            Not now
          </Button2>
          <Button2
            working={extend.isPending}
            disabled={!ok}
            reason={ok ? undefined : !isAmount(ceiling) ? "a ceiling amount" : !reason.trim() ? "the commercial reason" : "the number of hours"}
            onClick={() => extend.mutate()}
          >
            Extend the credit
          </Button2>
        </>
      }
    >
      <div className="field">
        <label>
          Ceiling
          <Help label="About the credit">
            The booking can go on without the advance, up to the ceiling. With a time limit it stops counting when the time runs out — the advance
            is due again.
          </Help>
        </label>
        <MoneyInput value={ceiling} onChange={(e) => /^\d*\.?\d{0,2}$/.test(e.target.value) && setCeiling(e.target.value)} />
        {status && status.shortfall > 0 && ceiling !== String(status.shortfall) ? (
          <span className="hint">
            still owed {money(status.shortfall, currency)} ·{" "}
            <a
              href="#cover"
              onClick={(e) => {
                e.preventDefault();
                setCeiling(String(status.shortfall));
              }}
            >
              cover that
            </a>
          </span>
        ) : null}
      </div>
      <div className="field">
        <label>Why · the commercial reason</label>
        <input
          className="input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="a trusted agent; the transfer is on its way"
          autoFocus
        />
      </div>
      <div className="field">
        <label>
          Counts until
          <Help label="About the time limit">Follows the guest&rsquo;s plan until you choose otherwise.</Help>
        </label>
        <select className="input" value={choice.mode} onChange={(e) => setChoice({ ...choice, mode: e.target.value as CreditExpiryChoice["mode"] })}>
          <option value="NONE">No time limit</option>
          {anchors.promisedBy ? <option value="PROMISE">The date the guest promised · {fmtDateTime(anchors.promisedBy, tz)}</option> : null}
          {anchors.checkInDate ? <option value="CHECKIN">Check-in · {fmtDate(anchors.checkInDate)}</option> : null}
          {anchors.checkOutDate ? <option value="CHECKOUT">Check-out · {fmtDate(anchors.checkOutDate)}</option> : null}
          <option value="HOURS">A number of hours…</option>
        </select>
      </div>
      {choice.mode === "HOURS" ? (
        <div className="field">
          <label>Hours</label>
          <input
            className="input narrow"
            inputMode="numeric"
            value={choice.hours}
            onChange={(e) => setChoice({ ...choice, hours: e.target.value.replace(/\D/g, "") })}
          />
          <span className="hint">{isAmount(choice.hours) ? `${plural(Number(choice.hours), "hour")} from now` : "at least one hour"}</span>
        </div>
      ) : null}
    </DsDialog>
  );
}

/* ------------------------------------------------------------------ a footer button */

/** The design-system button with the dialog footer's three states spelled out. */
function Button2({
  kind = "primary",
  working,
  disabled,
  reason,
  className,
  onClick,
  children,
}: {
  kind?: "primary" | "secondary" | "quiet";
  working?: boolean;
  disabled?: boolean;
  reason?: string;
  className?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button kind={kind} className={className} state={working ? "working" : disabled ? "inert" : "default"} title={reason} workingLabel="Working…" onClick={onClick}>
      {children}
    </Button>
  );
}

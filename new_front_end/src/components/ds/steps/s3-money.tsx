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
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { BindingBox, Button, Chip, MoneyInput } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import {
  reconcileAdvancePayment,
  recordCreditExtension,
  ADVANCE_PAYMENT_MODES,
  recordFolioPayment,
  type AdvancePaymentMode,
  setAdvancePaymentPlan,
  setAdvanceRequirement,
} from "@/lib/api/reservation-setup";
import { expiryModeForPlanDue, resolveCreditExpiry, type CreditExpiryChoice } from "@/components/desk/workspace/advance-settlement";
import { fmtDate, fmtDateTime, fmtStamp, money, plural } from "@/lib/ds/format";
import { STEP_NAMES, stepNoOfStage } from "@/lib/ds/steps";
import type { AdvancePaymentPlanSummary, EntryDetail, InvoiceSummary, PaymentStatusSummary } from "@/types/api";
import { Choice, DsDialog, Fact, Facts, Live, SeeRow, StepCard, toastRefusal } from "./kit";
import { hotelLocalToIso, isoToHotelLocal } from "./s2-shared";

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
  onChanged,
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
  onChanged: () => void;
}) {
  const { session } = useSession();
  const folio = entry.folio ?? null;
  const [open, setOpen] = useState<null | "amount" | "plan" | "pay" | "credit">(null);

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
  const payLock = !folio
    ? "open the provisional bill first — the billing model above"
    : !bill.dispatched
      ? "send the proforma first — money is logged against the bill the guest received"
      : !bill.answered
        ? "record the guest's answer to the proforma first — it is on the proforma below"
        : null;
  const reconcilable = received > 0 || inPayments.length > 0 || ["DIRECT_BILL", "GOVERNMENT"].includes(folio?.billingModel ?? "");
  const reconcileLock = !folio
    ? "open the provisional bill first"
    : reconciled
      ? "already signed off"
      : !reconcilable
        ? "log a payment first — with nothing received there is nothing to sign off (a direct-bill booking is the exception)"
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

  const basis = status?.requirementBasis ?? null;
  const advWindow = status?.advanceWindow ?? null;
  const shortWithPlan =
    !!status && !status.paidInFull && received > 0 && !!plan && (plan.plan !== "FULL" || !!plan.balanceDueAt) && !status.creditExtensionActive;

  return (
    <StepCard flow="money" flowAfter="proforma" title="The payment plan" right={stateChip}>
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
            <div className="meta" style={{ marginTop: 4 }}>
              The money is on the booking&rsquo;s record · a receipt as a paper is not in the backend yet (BE-43)
            </div>
          ) : null}
          {shortWithPlan ? (
            <div className="sm warn-ink" style={{ marginTop: 8 }}>
              The guest still owes {money(status.shortfall, cur)} and said {plan!.plan === "FULL" ? "they would pay" : "the rest comes"}{" "}
              {plan!.balanceDueAt === "BEFORE_CHECKIN" ? "before check-in" : plan!.balanceDueAt === "AT_CHECKIN" ? "at the check-in desk" : "later"}.
              To reserve before the money lands, the FOM covers the remainder with credit.
            </div>
          ) : null}
        </>
      )}

      <Live>
        {editable && folio ? (
          <div className="stack sm" style={{ display: "grid", gap: 4, marginTop: 12 }}>
            <SeeRow
              label="Change the amount asked…"
              note="a flat amount, or a percent of the quotation · a changed amount issues the proforma again"
              onClick={() => setOpen("amount")}
            />
            <SeeRow
              label={plan ? "Change how they'll pay…" : "Record how they'll pay…"}
              note="the whole now, part now or in instalments, and when — the proforma prints it, so a change issues it again"
              onClick={() => setOpen("plan")}
            />
            <SeeRow
              kind="primary"
              label="Record payment…"
              note="the rooms are held automatically when money comes in — even part of it"
              onClick={() => setOpen("pay")}
              state={payLock ? "inert" : "default"}
              reason={payLock ?? undefined}
            />
            {payLock ? <div className="sm warn-ink">Before money can be logged: {payLock}.</div> : null}
            <SeeRow
              label="Mark reconciled"
              note="signs off the money position — ticks the arrival checklist and stops the chasing"
              onClick={() => reconcileM.mutate()}
              state={reconcileM.isPending ? "working" : reconcileLock ? "inert" : "default"}
              reason={reconcileLock ?? undefined}
            />
            <SeeRow
              label="Extend credit…"
              note="lets the booking go on without the advance, up to a ceiling and for a time — the FOM's call"
              onClick={elevated ? () => setOpen("credit") : undefined}
              reason={elevated ? undefined : "extending credit is the FOM's call"}
            />
            <SeeRow
              label="Read the payment again"
              note="when money was logged on another terminal"
              onClick={onRefetch}
              state={refetching ? "working" : "default"}
            />
          </div>
        ) : null}
      </Live>

      {open === "amount" ? <RequirementDialog entry={entry} status={status} onClose={() => setOpen(null)} onDone={onChanged} /> : null}
      {open === "plan" ? <PlanDialog entry={entry} status={status} tz={tz} onClose={() => setOpen(null)} onDone={onChanged} /> : null}
      {open === "pay" && folio ? (
        <PaymentDialog entry={entry} folioId={folio.id} status={status} currency={cur} onClose={() => setOpen(null)} onDone={onChanged} />
      ) : null}
      {open === "credit" ? (
        <CreditDialog entry={entry} status={status} tz={tz} currency={cur} onClose={() => setOpen(null)} onDone={onChanged} />
      ) : null}
    </StepCard>
  );
}

/* ------------------------------------------------------------------ what the guest must pay */

function RequirementDialog({
  entry,
  status,
  onClose,
  onDone,
}: {
  entry: EntryDetail;
  status: PaymentStatusSummary | undefined;
  onClose: () => void;
  onDone: () => void;
}) {
  const { session } = useSession();
  const [mode, setMode] = useState<RequirementMode>(status?.requirementBasis?.mode === "AMOUNT" ? "AMOUNT" : "PERCENT");
  const [value, setValue] = useState("");
  const set = useMutation({
    mutationFn: (body: { mode: "AMOUNT"; amount: number } | { mode: "PERCENT"; percent: number } | { mode: "CLEAR" }) =>
      setAdvanceRequirement(session!, entry.id, body),
    onSuccess: (res, body) => {
      toast.success(body.mode === "CLEAR" ? "The hotel's default advance applies again" : `Amount asked: ${money(res.requiredAmount)}`, {
        description: reissueWords(res.reissuedProforma) ?? undefined,
        duration: res.reissuedProforma ? 9000 : undefined,
      });
      onClose();
      onDone();
    },
    onError: (e) => toastRefusal(e, "The amount asked could not be set"),
  });
  const n = Number(value);
  const valid = isAmount(value) && (mode === "AMOUNT" || n <= 100);
  return (
    <DsDialog
      open
      onClose={onClose}
      busy={set.isPending}
      title="What the guest must pay"
      caseLines={[
        status
          ? `Asked now: ${money(status.requiredAmount)} · ${status.requirementSource === "OPERATOR" ? "set for this booking" : "the hotel's default"}`
          : "Nothing read yet",
      ]}
      footer={
        <>
          <Button2 kind="quiet" disabled={set.isPending} onClick={onClose}>
            Not now
          </Button2>
          {status?.requirementSource === "OPERATOR" ? (
            <Button2 kind="secondary" disabled={set.isPending} onClick={() => set.mutate({ mode: "CLEAR" })}>
              Use the hotel&rsquo;s default
            </Button2>
          ) : null}
          <Button2
            working={set.isPending}
            disabled={!valid}
            reason={valid ? undefined : mode === "PERCENT" ? "a percent from 1 to 100" : "a positive amount"}
            onClick={() => set.mutate(mode === "AMOUNT" ? { mode: "AMOUNT", amount: n } : { mode: "PERCENT", percent: n })}
          >
            Set the amount
          </Button2>
        </>
      }
    >
      <div className="field">
        <label>Ask for</label>
        <Choice options={REQUIREMENT_MODES} value={mode} onChange={setMode} />
      </div>
      <div className="field">
        <label>{mode === "PERCENT" ? "Percent of the quotation" : "Amount"}</label>
        {mode === "AMOUNT" ? (
          <MoneyInput value={value} onChange={(e) => /^\d*\.?\d{0,2}$/.test(e.target.value) && setValue(e.target.value)} autoFocus />
        ) : (
          <input
            className="input narrow"
            inputMode="decimal"
            value={value}
            placeholder="50"
            onChange={(e) => /^\d*\.?\d{0,2}$/.test(e.target.value) && setValue(e.target.value)}
            autoFocus
          />
        )}
        <span className="hint">
          {mode === "PERCENT"
            ? "the house works the figure out from the quotation now — if the quotation changes, set it again"
            : "for this booking only — the hotel's minimum is untouched"}
        </span>
      </div>
      <p className="meta">A changed amount replaces the proforma with a new version; it has to be sent again.</p>
    </DsDialog>
  );
}

/* ------------------------------------------------------------------ how they will pay */

function PlanDialog({
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
  onDone: () => void;
}) {
  const { session } = useSession();
  const saved = status?.paymentPlan ?? null;
  const [plan, setPlan] = useState<PlanKind>(saved?.plan ?? "FULL");
  const [due, setDue] = useState<Due>(saved?.balanceDueAt ? (saved.balanceDueAt === "AT_CHECKOUT" ? "AT_CHECKIN" : saved.balanceDueAt) : "");
  const [promised, setPromised] = useState(saved?.promisedBy ? isoToHotelLocal(saved.promisedBy, tz) : "");
  const [note, setNote] = useState(saved?.note ?? "");
  const clock = useHotelClock(60_000);
  const nowLocal = isoToHotelLocal(clock.now, tz);

  const toastReissue = (r: Reissued) => {
    const w = reissueWords(r);
    if (w) toast.info(w, { duration: 9000 });
  };
  const save = useMutation({
    mutationFn: () => {
      const note_ = note.trim() || null;
      if (due === "") return setAdvancePaymentPlan(session!, entry.id, { plan, note: note_ });
      if (due === "BEFORE_CHECKIN") {
        const iso = hotelLocalToIso(promised, tz);
        if (!iso) throw new Error("Pick the date the guest promised");
        return setAdvancePaymentPlan(session!, entry.id, { plan, balanceDueAt: due, promisedBy: iso, note: note_ });
      }
      return setAdvancePaymentPlan(session!, entry.id, { plan, balanceDueAt: due, note: note_ });
    },
    onSuccess: (res) => {
      toast.success("The guest's payment plan is recorded");
      toastReissue(res.reissuedProforma);
      onClose();
      onDone();
    },
    onError: (e) => toastRefusal(e, "The plan could not be recorded"),
  });
  const clear = useMutation({
    mutationFn: () => setAdvancePaymentPlan(session!, entry.id, { plan: "CLEAR" }),
    onSuccess: (res) => {
      toast.success("The payment plan is cleared");
      toastReissue(res.reissuedProforma);
      onClose();
      onDone();
    },
    onError: (e) => toastRefusal(e, "The plan could not be cleared"),
  });

  const timing: ReadonlyArray<readonly [Due, string]> =
    plan === "FULL"
      ? [
          ["", "Now, at the desk"],
          ["BEFORE_CHECKIN", "Before check-in, by a date"],
          ["AT_CHECKIN", "At the check-in desk"],
        ]
      : [
          ["BEFORE_CHECKIN", "Before check-in, by a date"],
          ["AT_CHECKIN", "At the check-in desk"],
        ];
  const needsDate = due === "BEFORE_CHECKIN" && !promised;
  const busy = save.isPending || clear.isPending;

  return (
    <DsDialog
      open
      onClose={onClose}
      busy={busy}
      title="How the guest will pay the advance"
      caseLines={[status ? `The advance: ${money(status.requiredAmount)} · received ${money(status.totalReceived)}` : "Nothing read yet"]}
      footer={
        <>
          <Button2 kind="quiet" disabled={busy} onClick={onClose}>
            Not now
          </Button2>
          {saved ? (
            <Button2 kind="secondary" disabled={busy} working={clear.isPending} onClick={() => clear.mutate()}>
              Clear the plan
            </Button2>
          ) : null}
          <Button2
            working={save.isPending}
            disabled={needsDate || clear.isPending}
            reason={needsDate ? "pick the date they promised" : undefined}
            onClick={() => save.mutate()}
          >
            Record the plan
          </Button2>
        </>
      }
    >
      <div className="field">
        <label>What they said</label>
        <Choice
          options={PLAN_CHOICES}
          value={plan}
          onChange={(next) => {
            setPlan(next);
            if (next !== "FULL" && due === "") setDue("BEFORE_CHECKIN");
          }}
        />
      </div>
      <div className="field">
        <label>{plan === "FULL" ? "When will they pay?" : "When is the rest coming?"}</label>
        <Choice options={timing} value={due} onChange={setDue} />
      </div>
      {due === "BEFORE_CHECKIN" ? (
        <div className="field">
          <label>Promised by · on the hotel&rsquo;s clock</label>
          <input className="input" type="datetime-local" value={promised} min={nowLocal || undefined} onChange={(e) => setPromised(e.target.value)} />
          <span className="hint">
            a countdown runs to it and the booking is flagged if the money has not come · a date after check-in is taken as check-in
          </span>
        </div>
      ) : null}
      <div className="field">
        <label>What they said, in their words · optional</label>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="will transfer the rest after payday" />
      </div>
      <p className="meta">
        {due === "AT_CHECKIN"
          ? "No countdown — the money is collected at the check-in desk. To check in unpaid, the FOM covers the gap with credit."
          : due === ""
            ? "Paying now records no promise."
            : "The proforma prints this plan — a change issues it again, to send again."}
      </p>
    </DsDialog>
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
  onDone: () => void;
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
      if (ah?.placed) {
        toast.success("The rooms are held for this booking", {
          description: "The advance came in, so the committed hold was placed. It runs on the standard hold clock.",
          duration: 9000,
        });
      } else if (ah && !ah.placed && ah.reason !== "ALREADY_HELD") {
        toast.warning("The rooms were not held automatically", {
          description: `${ah.message} — place the committed hold by hand.`,
          duration: 10000,
        });
      }
      onClose();
      onDone();
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
        <label>Amount received · the gross the guest paid</label>
        <MoneyInput value={amount} onChange={(e) => /^\d*\.?\d{0,2}$/.test(e.target.value) && setAmount(e.target.value)} autoFocus />
        {status && status.shortfall > 0 ? (
          <span className="hint">
            {prefilled ? (
              "what is still owed on the advance — change it if they paid a different amount"
            ) : (
              <>
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
              </>
            )}
          </span>
        ) : null}
      </div>
      <div className="field">
        <label>How it was paid</label>
        <Choice options={ADVANCE_PAYMENT_MODES} value={mode} onChange={setMode} />
        <span className="hint">the slip&rsquo;s reference goes in the note; the payment is dated today (a back-dated receipt is BE-13)</span>
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
            : "A payment holds the rooms automatically only once the terms are disclosed — record the disclosure first, or place the hold by hand after."}{" "}
        The receipt as a paper is BE-43.
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
      <p className="sm">
        The booking can go on without the advance, up to the ceiling. With a time limit it stops counting when the time runs out — the advance is due
        again.
      </p>
      <div className="field">
        <label>Ceiling</label>
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
        <label>Counts until</label>
        <select className="input" value={choice.mode} onChange={(e) => setChoice({ ...choice, mode: e.target.value as CreditExpiryChoice["mode"] })}>
          <option value="NONE">No time limit</option>
          {anchors.promisedBy ? <option value="PROMISE">The date the guest promised · {fmtDateTime(anchors.promisedBy, tz)}</option> : null}
          {anchors.checkInDate ? <option value="CHECKIN">Check-in · {fmtDate(anchors.checkInDate)}</option> : null}
          {anchors.checkOutDate ? <option value="CHECKOUT">Check-out · {fmtDate(anchors.checkOutDate)}</option> : null}
          <option value="HOURS">A number of hours…</option>
        </select>
        <span className="hint">follows the guest&rsquo;s plan until you choose otherwise</span>
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
  onClick,
  children,
}: {
  kind?: "primary" | "secondary" | "quiet";
  working?: boolean;
  disabled?: boolean;
  reason?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button kind={kind} state={working ? "working" : disabled ? "inert" : "default"} title={reason} workingLabel="Working…" onClick={onClick}>
      {children}
    </Button>
  );
}

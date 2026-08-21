"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, Check, Clock } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  getPaymentStatus,
  recordCreditExtension,
  recordFolioPayment,
  reconcileAdvancePayment,
  setAdvancePaymentPlan,
} from "@/lib/api/reservation-setup";
import { money } from "@/lib/desk/workspace";
import { countdownTo } from "@/lib/desk/timers";
import type { AdvancePaymentPlanSummary, EntryDetail, PaymentStatusSummary } from "@/types/api";

/**
 * The advance-payment settlement surface (2026-08-07, operator request).
 *
 * A guest rarely pays the whole advance in one go: they pay a portion against the proforma and
 * say when the rest is coming — before check-in (a dated promise), at the check-in desk, or at
 * check-out — sometimes in several installments. These pieces render that story everywhere the
 * money can arrive:
 *
 *  - `AdvancePlanCapture` (S3, setup-step): record what the guest said with their proforma reply.
 *  - `AdvancePlanFacts` + `InstallmentHistory`: the plan chip / promise countdown / payment rows,
 *    reused by every stage that shows the advance.
 *  - `AdvanceSettlementBlock` (S4 confirm · S5 arrival · S6 check-in): live status + "log the
 *    remainder" + FOM credit extension aligned to the promise + reconcile.
 *
 * No money is computed here — every figure (shortfall, received, required) is the backend's own
 * payment-status; the desk only renders and posts.
 */

function BlockH({ children }: { children: React.ReactNode }) {
  return (
    <div className="block-h">
      {children}
      <span className="ln" />
    </div>
  );
}

function isElevated(level?: string) {
  return level === "L2" || level === "L3" || level === "L4";
}

export const PLAN_LABEL: Record<AdvancePaymentPlanSummary["plan"], string> = {
  FULL: "Full amount at once",
  PARTIAL: "Part now — rest later",
  INSTALLMENTS: "In installments",
};

export const DUE_LABEL: Record<NonNullable<AdvancePaymentPlanSummary["balanceDueAt"]>, string> = {
  BEFORE_CHECKIN: "rest before check-in",
  AT_CHECKIN: "rest at the check-in desk",
  AT_CHECKOUT: "rest at check-out",
};

/** The same timing on a FULL plan is the WHOLE payment, not a remainder (2026-08-19). */
const DUE_LABEL_FULL: Record<NonNullable<AdvancePaymentPlanSummary["balanceDueAt"]>, string> = {
  BEFORE_CHECKIN: "paying before check-in",
  AT_CHECKIN: "paying at the check-in desk",
  AT_CHECKOUT: "paying at check-out",
};

export function dueLabel(plan: AdvancePaymentPlanSummary["plan"], due: AdvancePaymentPlanSummary["balanceDueAt"]) {
  if (!due) return null;
  return (plan === "FULL" ? DUE_LABEL_FULL : DUE_LABEL)[due];
}

/** Desk names for the stage a payment was taken at (installment history rows). */
const STAGE_STEP_LABEL: Record<string, string> = {
  S3: "Set up",
  S4: "Confirm",
  S5: "Arrival",
  S6: "Check-in",
  S7: "Stay",
  S8: "Check-out",
};

function fmtDate(iso: string | null | undefined) {
  return iso ? iso.slice(0, 16).replace("T", " ") : "—";
}

/** Plan chip + promise countdown. Renders nothing when no plan is recorded. */
export function AdvancePlanFacts({ status }: { status: PaymentStatusSummary | undefined }) {
  const plan = status?.paymentPlan ?? null;
  // 30s tick keeps the countdown honest without per-second re-renders (same as the S3 window).
  const [tick, setTick] = useState(() => Date.now());
  const promiseActive = !!plan?.promisedBy && !plan.promiseOverdue && !status?.paidInFull;
  useEffect(() => {
    if (!promiseActive) return;
    const t = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [promiseActive]);

  if (!plan) return null;
  const countdown = plan.promisedBy ? countdownTo(plan.promisedBy, tick) : null;
  const settled = status?.paidInFull === true;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start", margin: "0 0 11px" }}>
      <div className="fact b-transit" style={{ padding: "6px 11px", fontSize: 12.5, width: "100%", justifyContent: "space-between" }}>
        <span>
          Guest&rsquo;s plan: <b>{plan.plan === "FULL" && plan.balanceDueAt ? "Full amount" : PLAN_LABEL[plan.plan]}</b>
          {dueLabel(plan.plan, plan.balanceDueAt) ? ` · ${dueLabel(plan.plan, plan.balanceDueAt)}` : ""}
          {plan.balanceDueAt === "BEFORE_CHECKIN" && plan.promisedBy ? ` · by ${fmtDate(plan.promisedBy)}` : ""}
        </span>
        {settled ? <span className="tag">Kept — paid in full</span> : null}
      </div>
      {!settled && plan.promiseOverdue && (
        <span className="timer crit">
          <Clock style={{ width: 12, height: 12 }} />
          Promise lapsed — the guest said they&rsquo;d pay by {fmtDate(plan.promisedBy)} and the advance is still short
        </span>
      )}
      {!settled && !plan.promiseOverdue && plan.balanceDueAt === "BEFORE_CHECKIN" && plan.promisedBy && (
        <span className={`timer ${countdown?.level || "warn"}`}>
          {plan.plan === "FULL" ? "Payment" : "Remainder"} promised {countdown?.text ?? "soon"} · by{" "}
          {fmtDate(plan.promisedBy)}
        </span>
      )}
      {plan.note && (
        <span style={{ fontSize: 11, color: "var(--ink-3)" }}>&ldquo;{plan.note}&rdquo;</span>
      )}
    </div>
  );
}

/** The payments so far, oldest first — lets the desk read "2,000 at Set up · 1,500 at Arrival". */
export function InstallmentHistory({ status, currency }: { status: PaymentStatusSummary | undefined; currency?: string }) {
  const rows = status?.installments ?? [];
  if (rows.length === 0) return null;
  return (
    <div style={{ margin: "0 0 11px" }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", marginBottom: 5 }}>
        Payments so far ({rows.length})
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        {rows.map((p) => (
          <div key={p.id} className="fact" style={{ justifyContent: "space-between", fontSize: 12, padding: "5px 10px" }}>
            <span>
              {fmtDate(p.receivedAt)}
              {p.stage ? ` · ${STAGE_STEP_LABEL[p.stage] ?? p.stage}` : ""}
              {p.notes ? <span style={{ color: "var(--ink-3)" }}> · {p.notes}</span> : null}
            </span>
            <span className="mono">{money(p.amount, currency)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Credit-extension expiry aligned to the promise ────────────────────────────────────────

export type CreditExpiryChoice = { mode: "NONE" | "HOURS" | "PROMISE" | "CHECKIN" | "CHECKOUT"; hours: string };

/** Translate the picker's choice into the API body — a date the backend already knows, never
 *  computed money/derived figures. Returns {} for "no limit". */
export function resolveCreditExpiry(
  choice: CreditExpiryChoice,
  anchors: { promisedBy?: string | null; checkInDate?: string | null; checkOutDate?: string | null },
): { validForHours?: number | null; validUntil?: string | null } {
  switch (choice.mode) {
    case "HOURS": {
      const n = Number(choice.hours);
      return Number.isFinite(n) && n > 0 ? { validForHours: n } : {};
    }
    case "PROMISE":
      return anchors.promisedBy ? { validUntil: anchors.promisedBy } : {};
    case "CHECKIN":
      return anchors.checkInDate ? { validUntil: anchors.checkInDate } : {};
    case "CHECKOUT":
      return anchors.checkOutDate ? { validUntil: anchors.checkOutDate } : {};
    default:
      return {};
  }
}

/**
 * The expiry mode the guest's own plan implies — "rest before check-in" → cover until the
 * promised date; "at check-in" / "at check-out" → cover until that day. Null when the plan
 * names no timing or its anchor date is missing (then the picker stays where it was). Parents
 * apply it as a DEFAULT only (a touched picker is never overwritten — the dropdown stays
 * freely changeable).
 */
export function expiryModeForPlanDue(
  due: AdvancePaymentPlanSummary["balanceDueAt"],
  anchors: { promisedBy?: string | null; checkInDate?: string | null; checkOutDate?: string | null },
): CreditExpiryChoice["mode"] | null {
  if (due === "BEFORE_CHECKIN" && anchors.promisedBy) return "PROMISE";
  if (due === "AT_CHECKIN" && anchors.checkInDate) return "CHECKIN";
  if (due === "AT_CHECKOUT" && anchors.checkOutDate) return "CHECKOUT";
  return null;
}

export function CreditExpiryPicker({
  choice,
  onChange,
  anchors,
}: {
  choice: CreditExpiryChoice;
  onChange: (c: CreditExpiryChoice) => void;
  anchors: { promisedBy?: string | null; checkInDate?: string | null; checkOutDate?: string | null };
}) {
  return (
    <div className="frow">
      <div className="field">
        <label>Covers the gate until</label>
        <select value={choice.mode} onChange={(e) => onChange({ ...choice, mode: e.target.value as CreditExpiryChoice["mode"] })}>
          <option value="NONE">No time limit</option>
          {anchors.promisedBy && <option value="PROMISE">The promised payment date ({fmtDate(anchors.promisedBy)})</option>}
          {anchors.checkInDate && <option value="CHECKIN">Check-in ({anchors.checkInDate.slice(0, 10)})</option>}
          {anchors.checkOutDate && <option value="CHECKOUT">Check-out ({anchors.checkOutDate.slice(0, 10)})</option>}
          <option value="HOURS">A number of hours…</option>
        </select>
      </div>
      {choice.mode === "HOURS" && (
        <div className="field" style={{ maxWidth: 130 }}>
          <label>Hours</label>
          <input type="number" min={1} value={choice.hours} onChange={(e) => onChange({ ...choice, hours: e.target.value })} />
        </div>
      )}
    </div>
  );
}

// ─── S3: capture what the guest said ───────────────────────────────────────────────────────

/**
 * "How will the guest pay?" — recorded alongside their answer to the proforma (S3 setup step).
 * Shows the saved plan as a settled fact with Change/Clear; the form otherwise.
 */
export function AdvancePlanCapture({
  entry,
  status,
  disabled,
  disabledHint,
}: {
  entry: EntryDetail;
  status: PaymentStatusSummary | undefined;
  /** Lock the form (e.g. before the folio exists). */
  disabled?: boolean;
  disabledHint?: string;
}) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const saved = status?.paymentPlan ?? null;

  const [editing, setEditing] = useState(false);
  const [plan, setPlan] = useState<"FULL" | "PARTIAL" | "INSTALLMENTS">("FULL");
  // AT_CHECKOUT removed 2026-08-08 (the advance settles before or at check-in) — the backend
  // refuses it; legacy saved plans that carry it seed the form as AT_CHECKIN.
  // "" = no timing recorded — offered on FULL only (2026-08-19), and it means "paying now at the
  // desk". A guest paying the WHOLE amount can still be paying it on Friday, and that promise
  // needs somewhere to live (it arms the same W38 clock as a remainder promise).
  const [balanceDueAt, setBalanceDueAt] = useState<"" | "BEFORE_CHECKIN" | "AT_CHECKIN">("");
  const [promisedBy, setPromisedBy] = useState("");
  const [note, setNote] = useState("");

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["payment-status", entry.id] });
    // The proforma list rides on the entry detail — a plan change can re-issue it (2026-08-08).
    void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry.id] });
  };
  /** The PI prints the plan, so a change mints a corrected version — tell the operator to send it. */
  const toastReissue = (res: { reissuedProforma?: { versionNumber: number; supersededIds: string[] } | null }) => {
    const r = res.reissuedProforma;
    if (!r) return;
    toast.info(
      r.supersededIds.length > 0
        ? `The proforma was re-issued with this plan (v${r.versionNumber}) — dispatch it to the guest again.`
        : `A fresh proforma (v${r.versionNumber}) was generated with this plan — dispatch it when ready.`,
      { duration: 9000 },
    );
  };

  const saveM = useMutation({
    mutationFn: () => {
      if (balanceDueAt === "BEFORE_CHECKIN" && !promisedBy) {
        throw new Error("Pick the date the guest promised");
      }
      const body =
        balanceDueAt === ""
          ? ({ plan } as const) // FULL, paying now — no timing to record
          : balanceDueAt === "BEFORE_CHECKIN"
            ? { plan, balanceDueAt, promisedBy: new Date(promisedBy).toISOString() }
            : { plan, balanceDueAt };
      return setAdvancePaymentPlan(session!, entry.id, { ...body, note: note.trim() || null });
    },
    onSuccess: (res) => {
      toast.success("Guest's payment plan recorded");
      toastReissue(res);
      setEditing(false);
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Couldn't save the plan"),
  });
  const clearM = useMutation({
    mutationFn: () => setAdvancePaymentPlan(session!, entry.id, { plan: "CLEAR" }),
    onSuccess: (res) => {
      toast.success("Payment plan cleared");
      toastReissue(res);
      setEditing(false);
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't clear the plan"),
  });

  return (
    <div className="block">
      <BlockH>
        <Banknote style={{ width: 13, height: 13 }} />
        How will the guest pay the advance?
      </BlockH>
      {saved && !editing ? (
        <>
          <AdvancePlanFacts status={status} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                // Seed the form from the saved plan so Change opens on what's in force. A legacy
                // at-check-out plan seeds as at-check-in — the closest option still offered.
                setPlan(saved.plan);
                setBalanceDueAt(
                  saved.balanceDueAt ? (saved.balanceDueAt === "AT_CHECKOUT" ? "AT_CHECKIN" : saved.balanceDueAt) : "",
                );
                setPromisedBy(saved.promisedBy ? saved.promisedBy.slice(0, 16) : "");
                setNote(saved.note ?? "");
                setEditing(true);
              }}
            >
              Change
            </button>
            <button className="btn btn-ghost btn-sm" disabled={clearM.isPending} onClick={() => clearM.mutate()}>
              {clearM.isPending ? "Clearing…" : "Clear — guest changed their mind"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 0, lineHeight: 1.5 }}>
            How will the guest pay the advance: the whole amount at once, part now with the rest
            later, or several installments — and <b>when</b> that money is coming. Even a guest
            paying the whole amount can be paying it on a date they named: record it and the
            promise gets its own countdown. The proforma <b>prints this plan</b>, so
            record it before sending — and if the guest later says they can&rsquo;t pay that way,
            change it here and a corrected proforma is issued to send again.
          </p>
          {disabled && disabledHint && (
            <p style={{ fontSize: 11.5, color: "var(--warn)", margin: "0 0 9px" }}>{disabledHint}</p>
          )}
          <div className="frow">
            <div className="field">
              <label>What they said</label>
              <select
                value={plan}
                onChange={(e) => {
                  const next = e.target.value as typeof plan;
                  setPlan(next);
                  // A remainder must have a due point; only FULL may say "paying now".
                  if (next !== "FULL" && balanceDueAt === "") setBalanceDueAt("BEFORE_CHECKIN");
                }}
                disabled={disabled}
              >
                <option value="FULL">{PLAN_LABEL.FULL}</option>
                <option value="PARTIAL">{PLAN_LABEL.PARTIAL}</option>
                <option value="INSTALLMENTS">{PLAN_LABEL.INSTALLMENTS}</option>
              </select>
            </div>
            {/* Timing (2026-08-19, operator request): FULL carries it too — "the whole amount, on
                Friday" is a promise like any other, and a dated one arms the same countdown. On
                FULL it may also be left as "paying now", which records no promise. */}
            <div className="field">
              <label>{plan === "FULL" ? "When will they pay?" : "When is the rest coming?"}</label>
              <select
                value={balanceDueAt}
                onChange={(e) => setBalanceDueAt(e.target.value as typeof balanceDueAt)}
                disabled={disabled}
              >
                {plan === "FULL" && <option value="">Now — paying at the desk</option>}
                <option value="BEFORE_CHECKIN">Before check-in (dated promise)</option>
                <option value="AT_CHECKIN">At the check-in desk</option>
              </select>
            </div>
            {balanceDueAt === "BEFORE_CHECKIN" && (
              <div className="field">
                <label>Promised by</label>
                <input type="datetime-local" value={promisedBy} onChange={(e) => setPromisedBy(e.target.value)} disabled={disabled} />
              </div>
            )}
          </div>
          <div className="field">
            <label>Note (optional — what they actually said)</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} disabled={disabled} placeholder="e.g. will transfer the rest after payday" />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn-primary"
              disabled={disabled || saveM.isPending || (balanceDueAt === "BEFORE_CHECKIN" && !promisedBy)}
              onClick={() => saveM.mutate()}
            >
              {saveM.isPending ? "Saving…" : "Record the plan"}
            </button>
            {editing && (
              <button className="btn btn-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
          {plan !== "FULL" && (
            <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "7px 0 0", lineHeight: 1.5 }}>
              {balanceDueAt === "BEFORE_CHECKIN"
                ? "A countdown is armed to the promised date — if the money hasn't arrived by then the booking flags the lapse."
                : "No timer — the remainder is collected at the check-in desk. To pass check-in unpaid, an FOM credit extension covers the gap."}
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ─── S4–S6: the settlement surface ─────────────────────────────────────────────────────────

/**
 * Live advance-settlement block for Confirm (S4), Arrival (S5) and Check-in (S6): what's been
 * received vs required, the guest's plan, installment history, "log the remainder", the FOM
 * credit extension aligned to the promise, and reconcile. The backend accepts advance payments
 * S3–S6 (2026-08-07), so money the guest hands over at any of these desks can be logged here.
 */
export function AdvanceSettlementBlock({
  entry,
  title = "Advance settlement",
  intro,
  children,
}: {
  entry: EntryDetail;
  title?: string;
  /** One-line stage-specific framing above the facts. */
  intro?: string;
  /** Stage-specific extras (e.g. the S5 FOM credit-ceiling acknowledgement button). */
  children?: React.ReactNode;
}) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const elevated = isElevated(session?.actorLevel);
  const folio = entry.folio ?? null;
  const currency = folio?.lines?.[0]?.currency;

  const statusQuery = useQuery({
    queryKey: ["payment-status", entry.id],
    queryFn: () => getPaymentStatus(session!, entry.id),
    enabled: !!session && !!folio?.id,
  });
  const status = statusQuery.data;
  const plan = status?.paymentPlan ?? null;

  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [ceiling, setCeiling] = useState("");
  const [creditReason, setCreditReason] = useState("");
  const [creditExpiry, setCreditExpiry] = useState<CreditExpiryChoice>({ mode: "NONE", hours: "" });

  // Prefill "amount" with the backend's shortfall (the no-money-math rule: the figure comes
  // from payment-status, never summed here) — but ONLY while nothing has been paid yet
  // (2026-08-07 operator report: after logging a partial 2,000 the box refilled with the
  // remaining 3,000 and read like the guest owed a second payment now). Once any payment
  // exists the box stays blank; the "still owed" hint + the credit-extension ceiling carry
  // the remainder instead. Latches on first keystroke.
  const suggestedAmount = status && status.shortfall > 0 && status.totalReceived === 0 ? String(status.shortfall) : "";
  const editedRef = useRef(false);
  useEffect(() => {
    if (editedRef.current) return;
    setAmount(suggestedAmount);
  }, [suggestedAmount]);
  // The credit ceiling always defaults to the uncovered remainder — covering the gap is
  // exactly what the extension is for.
  const suggestedCeiling = status && status.shortfall > 0 ? String(status.shortfall) : "";
  const ceilingEditedRef = useRef(false);
  useEffect(() => {
    if (ceilingEditedRef.current) return;
    setCeiling(suggestedCeiling);
  }, [suggestedCeiling]);
  // The expiry dropdown follows the guest's own plan (promised date / check-in / check-out)
  // until the operator picks something themselves — then their choice always wins.
  const expiryTouchedRef = useRef(false);
  const planDue = plan?.balanceDueAt ?? null;
  const planPromisedBy = plan?.promisedBy ?? null;
  useEffect(() => {
    if (expiryTouchedRef.current) return;
    const mode = expiryModeForPlanDue(planDue, {
      promisedBy: planPromisedBy,
      checkInDate: entry.checkInDate,
      checkOutDate: entry.checkOutDate,
    });
    if (mode) setCreditExpiry((c) => (c.mode === mode ? c : { ...c, mode }));
  }, [planDue, planPromisedBy, entry.checkInDate, entry.checkOutDate]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["payment-status", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry.id] });
  };

  const paymentM = useMutation({
    mutationFn: () => {
      if (!folio) throw new Error("No folio on this booking");
      return recordFolioPayment(session!, folio.id, { entryId: entry.id, amount: Number(amount), notes: notes.trim() || undefined });
    },
    onSuccess: () => {
      toast.success("Payment logged against the advance");
      setAmount("");
      setNotes("");
      editedRef.current = false;
      ceilingEditedRef.current = false;
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't log the payment"),
  });
  const creditM = useMutation({
    mutationFn: () =>
      recordCreditExtension(session!, entry.id, {
        ceilingAmount: Number(ceiling),
        reason: creditReason.trim(),
        ...resolveCreditExpiry(creditExpiry, {
          promisedBy: plan?.promisedBy,
          checkInDate: entry.checkInDate,
          checkOutDate: entry.checkOutDate,
        }),
      }),
    onSuccess: () => {
      toast.success("Credit extension approved — the gate is covered");
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't approve the extension"),
  });
  const reconcileM = useMutation({
    mutationFn: () => {
      if (!folio) throw new Error("No folio on this booking");
      return reconcileAdvancePayment(session!, folio.id, { entryId: entry.id, note: `${title} reconciliation` });
    },
    onSuccess: () => {
      toast.success("Advance reconciled");
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't reconcile"),
  });

  if (!folio) return null;

  const settled = status?.paidInFull === true;
  // The backend's collection window is S3–S6 (provisional folio). When this block is being
  // REVIEWED from a later stage (e.g. the Confirm step opened while in-house), show the facts
  // but not a form the server would refuse — money now flows through the folio / settlement.
  const collectable = ["S3", "S4", "S5", "S6"].includes(entry.currentStage);
  // Mirrors the backend's p27 reconcile gate: at least one logged payment, unless the folio is
  // direct-bill-like (agent/government settles later — "no advance" is legitimate there).
  const canReconcile =
    (status?.totalReceived ?? 0) > 0 || ["DIRECT_BILL", "GOVERNMENT"].includes(folio.billingModel ?? "");

  return (
    <div className="block">
      <BlockH>
        <Banknote style={{ width: 13, height: 13 }} />
        {title}
      </BlockH>
      {intro && <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 0, lineHeight: 1.5 }}>{intro}</p>}

      {status && (
        <div className="fact b-transit" style={{ marginBottom: 9, padding: "7px 11px", fontSize: 12.5, width: "100%", justifyContent: "space-between" }}>
          <span>
            Received {money(status.totalReceived, currency)} of the{" "}
            {status.requirementSource === "OPERATOR" ? "requested" : "min threshold"} {money(status.requiredAmount, currency)}
            {(status.installments?.length ?? 0) > 1 ? ` · ${status.installments!.length} payments` : ""}
          </span>
          <span className={`tag ${settled ? "" : status.satisfied ? "" : "warn"}`}>
            {settled
              ? "Paid in full"
              : status.satisfied
                ? `Covered by credit · short ${money(status.shortfall, currency)}`
                : `Short ${money(status.shortfall, currency)}`}
          </span>
        </div>
      )}

      {/* Held-vs-Reserved (2026-08-07): a booking confirmed with the advance still short keeps
          its rooms "Held" — same inventory block, honest label. They flip to Reserved the
          moment the remainder is logged below (an at-check-out plan confirms straight to
          Reserved, so this strip never shows for it). */}
      {!!entry.reservation?.confirmedAt &&
        status &&
        status.paidInFull === false &&
        status.paymentPlan?.balanceDueAt !== "AT_CHECKOUT" && (
          <div className="fact b-transit" style={{ padding: "7px 11px", fontSize: 12, width: "100%", marginBottom: 9, display: "block", lineHeight: 1.55 }}>
            The rooms are <b>Held, not yet Reserved</b> — the booking is confirmed but the advance is
            still short {money(status.shortfall, currency)}. Logging the remainder here flips them to
            Reserved automatically.
          </div>
        )}

      <AdvancePlanFacts status={status} />
      <InstallmentHistory status={status} currency={currency} />

      {status?.creditExtensionActive && (
        <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "0 0 9px" }}>
          Credit extension active
          {status.creditExtensionExpiresAt ? ` until ${fmtDate(status.creditExtensionExpiresAt)}` : " (no time limit)"} — the
          gate is covered, the money is still owed.
        </p>
      )}
      {status?.creditExtensionExpired && !status.creditExtensionActive && (
        <p style={{ fontSize: 11.5, color: "var(--warn)", margin: "0 0 9px" }}>
          A credit extension EXPIRED — it no longer covers the advance.
        </p>
      )}

      {!settled && !collectable && (
        <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "0 0 4px", lineHeight: 1.5 }}>
          The stay is live — advance collection closed at check-in. Remaining money flows through
          the folio and is collected at check-out settlement.
        </p>
      )}

      {!settled && collectable && (
        <>
          <div className="frow">
            <div className="field">
              <label>Amount received (Nu)</label>
              <input
                type="number"
                min={0.01}
                step="0.01"
                value={amount}
                onChange={(e) => {
                  editedRef.current = true;
                  setAmount(e.target.value);
                }}
              />
              {status && status.shortfall > 0 && (
                <div style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 3, lineHeight: 1.4 }}>
                  {suggestedAmount !== "" && amount === suggestedAmount ? (
                    <>Pre-filled with what&rsquo;s still owed — change it if the guest paid a different amount.</>
                  ) : (
                    <>
                      Still owed on the advance: {money(status.shortfall, currency)}.{" "}
                      <button
                        type="button"
                        className="rcb-mini"
                        onClick={() => {
                          editedRef.current = true;
                          setAmount(String(status.shortfall));
                        }}
                      >
                        Use that
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="field">
              <label>Notes</label>
              <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. cash at desk / bank ref" />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <button className="btn btn-primary" disabled={!amount || paymentM.isPending} onClick={() => paymentM.mutate()}>
              {paymentM.isPending ? "Logging…" : "Log payment received"}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              disabled={!!folio.advancePaymentReconciliationComplete || reconcileM.isPending || !canReconcile}
              title={
                canReconcile
                  ? "Sign off the advance position as accepted — ticks the payment-reconciliation checklist and stops follow-up chasing. Use it when a shortfall is deliberately accepted (e.g. covered by credit or agent-settled)."
                  : "Log a payment first — reconciling records that the money position was reviewed, and with nothing received there is nothing to reconcile (direct-bill folios are the exception)."
              }
              onClick={() => reconcileM.mutate()}
            >
              {folio.advancePaymentReconciliationComplete ? "✓ Reconciled" : reconcileM.isPending ? "Reconciling…" : "Mark reconciled"}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              disabled={statusQuery.isFetching}
              title="Re-read the payment status from the server — use it if money was logged on another terminal."
              onClick={() => statusQuery.refetch()}
            >
              Refresh
            </button>
          </div>
        </>
      )}

      {settled && (
        <div className="fact b-bound" style={{ padding: "8px 12px", fontSize: 12.5, marginBottom: 4 }}>
          <Check style={{ width: 14, height: 14, color: "var(--green-d)" }} />
          Advance settled in full
          {folio.advancePaymentReconciliationComplete ? " · reconciled" : ""}
        </div>
      )}

      {!settled && collectable && elevated && !status?.creditExtensionActive && (
        <div style={{ marginTop: 10, borderTop: "1px dashed var(--line-2)", paddingTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", marginBottom: 6 }}>
            Cover the remainder — credit extension (FOM+)
          </div>
          <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "0 0 7px", lineHeight: 1.5 }}>
            Lets the booking pass the arrival gates while the guest still owes the remainder. Align
            its clock with the plan — it stops counting when the clock runs out.
          </p>
          <div className="frow">
            <div className="field">
              <label>Ceiling amount</label>
              <input
                type="number"
                value={ceiling}
                onChange={(e) => {
                  ceilingEditedRef.current = true;
                  setCeiling(e.target.value);
                }}
              />
            </div>
            <div className="field">
              <label>Reason</label>
              <input value={creditReason} onChange={(e) => setCreditReason(e.target.value)} placeholder="e.g. remainder due at check-out per plan" />
            </div>
          </div>
          <CreditExpiryPicker
            choice={creditExpiry}
            onChange={(c) => {
              expiryTouchedRef.current = true;
              setCreditExpiry(c);
            }}
            anchors={{ promisedBy: plan?.promisedBy, checkInDate: entry.checkInDate, checkOutDate: entry.checkOutDate }}
          />
          <button className="btn btn-ghost btn-sm" disabled={!ceiling || !creditReason.trim() || creditM.isPending} onClick={() => creditM.mutate()}>
            {creditM.isPending ? "Approving…" : "Approve credit extension"}
          </button>
        </div>
      )}

      {children}
    </div>
  );
}

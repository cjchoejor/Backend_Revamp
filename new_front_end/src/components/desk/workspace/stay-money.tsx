"use client";

import { BankFields, useBankEntry } from "@/components/ds/bank-fields";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, Check, Eye, EyeOff, Receipt } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { recipientHint, useInvoiceRecipient, type InvoiceRecipient } from "@/hooks/use-invoice-recipient";
import { ApiError } from "@/lib/api/client";
import { dispatchInvoice } from "@/lib/api/reservation-setup";
import { openInvoicePdf } from "@/lib/api/documents";
import {
  createInterimPayment,
  listInterimPayments,
  recordInterimPayment,
  recordInterimPromise,
  setInterimDueBy,
  withdrawInterimPayment,
  type InterimPaymentRow,
} from "@/lib/api/stay-money";
import { listEntryCommunications, replySettled } from "@/lib/api/entries";
import { money } from "@/lib/desk/workspace";
import { countdownTo } from "@/lib/desk/timers";
import type { EntryDetail } from "@/types/api";
import { CommunicationAcceptanceBlock } from "./communication-acceptance";
import { PdfButton } from "./pdf-button";
import { ProformaPreview } from "./quotation-preview";
import { Help } from "@/components/ds/help";
import { DateTimeInput } from "@/components/ds/date-input";

/**
 * Mid-stay money on the Stay step (2026-08-21, operator ruling):
 *  - **Interim payment** — "sometimes when a guest stays for a longer period, the hotel needs
 *    to get a certain payment halfway through the stay". Manual any time; the night audit also
 *    raises a prompt every N nights (config). The ask is a % or a Nu amount of the PROJECTED
 *    total (nights slept + to come + other charges so far), net of money received — the
 *    backend computes it, the INTERIM invoice prints it, and the money is recorded only after
 *    the bill went out and the guest answered (the S3 order, at S7).
 *  - **Extend the stay** — N more nights. Not a walk back to S1: availability is checked for
 *    the extra nights (a taken room becomes a move from the old checkout), the price is
 *    projected, the interim bill goes out, and the extension COMMITS only once that payment
 *    is in. FOM (L2+).
 *
 * Shape (2026-08-22, operator report — "the extend-the-stay section is confusing to use"):
 * both blocks are NUMBERED STEP LISTS, because each is an ordered journey and the first cut
 * showed every control at once. Setting up an extension is four steps — new checkout →
 * rooms for the extra nights → price & the payment to take now (one small ledger, not three
 * separate totals) → hold the nights & generate the bill. An open request is a five-step
 * checklist — nights held → send the bill → the guest's answer → log the payment → commit —
 * and only the CURRENT step carries its controls; the steps after it say what they wait for.
 * The shared `InterimRequestPanel` renders the bill → answer → money steps for both blocks.
 * Every figure shown here is read from the API.
 */

const LEVEL_RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };
const fmtDay = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};
const fmtWhen = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** datetime-local ⇄ ISO: the input speaks local wall-clock, the API speaks ISO. */
const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (v: string): string | undefined => (v ? new Date(v).toISOString() : undefined);

function BlockH({ children, expanded, onToggle }: { children: ReactNode; expanded?: boolean; onToggle?: () => void }) {
  // With onToggle the whole header is the collapse control (2026-08-24, operator request —
  // both money blocks start collapsed); the state tags stay on the header so an open bill or
  // an overdue payment is never hidden behind the fold.
  return (
    <div
      className="block-h"
      onClick={onToggle}
      role={onToggle ? "button" : undefined}
      style={onToggle ? { cursor: "pointer", userSelect: "none" } : undefined}
      title={onToggle ? (expanded ? "Hide this section" : "Show this section") : undefined}
    >
      {children}
      <span className="ln" />
      {onToggle && (
        <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--ink-3)", whiteSpace: "nowrap", letterSpacing: 0.3 }}>
          {expanded ? "Hide ▴" : "Show ▾"}
        </span>
      )}
    </div>
  );
}

/** Interim-request states in desk words. */
const STATE_TAG: Record<string, { label: string; cls: string }> = {
  SUGGESTED: { label: "Due — set the amount", cls: "tag warn" },
  REQUESTED: { label: "Bill generated · not sent", cls: "tag warn" },
  BILLED: { label: "Bill sent — awaiting payment", cls: "tag warn" },
  PAID: { label: "Paid", cls: "tag ok" },
  WITHDRAWN: { label: "Withdrawn", cls: "tag" },
  LAPSED: { label: "Lapsed", cls: "tag" },
};
// ── Step list + ledger primitives ─────────────────────────────────────────────────────────────

type StepItem = {
  key: string;
  label: ReactNode;
  state: "done" | "cur" | "todo";
  /** One line beside the label — what was done, or what this step waits for. */
  summary?: ReactNode;
  /** The step's controls / facts. Rendered whenever present (the list is a form, not a wizard). */
  body?: ReactNode;
};

/** Numbered steps: green tick = done, terra number = the step that needs you, dashed = later. */
function StepList({ steps }: { steps: StepItem[] }) {
  return (
    <ol className="xsteps">
      {steps.map((s, i) => (
        <li key={s.key} className={`xstep ${s.state}`}>
          <span className="g">{s.state === "done" ? <Check /> : i + 1}</span>
          <div className="xmain">
            <div className="xl">
              <span>{s.label}</span>
              {s.summary !== undefined && s.summary !== null && <span className="xs">{s.summary}</span>}
            </div>
            {s.body && <div className="xb">{s.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

type LedgerRow = { key: string; label: ReactNode; value: ReactNode; kind?: "minus" | "total" | "muted" | "ask" };

/** A small money ledger — label left, figure right, reads top to bottom as the arithmetic it is. */
function Ledger({ rows, style }: { rows: Array<LedgerRow | false | null | undefined>; style?: CSSProperties }) {
  return (
    <div className="xledger" style={style}>
      {rows
        .filter((r): r is LedgerRow => !!r)
        .map((r) => (
          <div key={r.key} className={r.kind ?? ""}>
            <span>{r.label}</span>
            <span className="v">
              {r.kind === "minus" ? "− " : ""}
              {r.value}
            </span>
          </div>
        ))}
    </div>
  );
}

/** The ask — a % or a Nu figure of the projected total. Compact, inline. */
function AskInline({
  mode,
  value,
  onChange,
  disabled,
}: {
  mode: "PERCENT" | "AMOUNT";
  value: string;
  onChange: (p: { mode?: "PERCENT" | "AMOUNT"; value?: string }) => void;
  disabled?: boolean;
}) {
  const segBtn: CSSProperties = { padding: "4px 10px", fontSize: 12 };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <input
        inputMode="decimal"
        value={value}
        disabled={disabled}
        placeholder={mode === "PERCENT" ? "e.g. 50" : "e.g. 20000"}
        onChange={(e) => onChange({ value: e.target.value })}
        style={{ width: 92, padding: "5px 8px", fontSize: 13, fontFamily: "var(--deskmono)", border: "1px solid var(--line-2)", borderRadius: 6, background: "#fff" }}
      />
      <span className="seg" style={{ display: "inline-grid", gridTemplateColumns: "auto auto", padding: 3, gap: 3 }}>
        <button type="button" className={mode === "PERCENT" ? "on" : ""} disabled={disabled} style={segBtn} onClick={() => onChange({ mode: "PERCENT" })}>
          %
        </button>
        <button type="button" className={mode === "AMOUNT" ? "on" : ""} disabled={disabled} style={segBtn} onClick={() => onChange({ mode: "AMOUNT" })}>
          Nu
        </button>
      </span>
    </span>
  );
}

const hint: CSSProperties = { fontSize: 11.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 };
const row: CSSProperties = { display: "flex", alignItems: "flex-end", gap: 8, flexWrap: "wrap" };
const fieldTight: CSSProperties = { marginBottom: 0 };
const miniHeading: CSSProperties = { ...hint, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 10.5 };


/**
 * One interim request as a checklist: the bill (generated) → send it → the guest's answer →
 * the money. Only the current step carries controls; the later ones say what they wait for,
 * which is the reason the payment form used to sit greyed-out under the send form. Shared by
 * the long-stay block and the extension block — the latter adds "nights held" before and
 * "commit" after (the extension's payment is just an interim request of kind EXTENSION).
 */
function InterimRequestPanel({
  entryId,
  request,
  recipient,
  onChanged,
  canWithdraw = true,
  leadSteps = [],
  tailSteps = [],
}: {
  entryId: string;
  request: InterimPaymentRow;
  /** Who the bill goes to by default — the agency or company when one booked (2026-09-18). */
  recipient: InvoiceRecipient;
  onChanged: () => void;
  canWithdraw?: boolean;
  leadSteps?: StepItem[];
  tailSteps?: StepItem[];
}) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const currency = request.figures?.currency ?? "BTN";
  const dispatched = !!request.invoice?.dispatchedAt && request.invoice.state !== "SUPERSEDED";
  // The bill is SHOWN the moment it exists (2026-08-22, operator: "it shows bill is generated
  // but I cannot see the bill") — open until it is sent, the way S3 shows the proforma; it
  // folds once it has gone out so the eye moves to the guest's answer, and View re-opens it.
  const [previewOpen, setPreviewOpen] = useState(!dispatched);
  useEffect(() => {
    if (dispatched) setPreviewOpen(false);
  }, [dispatched]);
  // Starts at the backend's own default recipient and follows it until the desk types.
  const [sendTo, setSendToRaw] = useState(recipient.defaultTo);
  const sendToTouched = useRef(false);
  useEffect(() => {
    if (!sendToTouched.current && !recipient.loading) setSendToRaw(recipient.defaultTo);
  }, [recipient.defaultTo, recipient.loading]);
  const setSendTo = (v: string) => {
    sendToTouched.current = true;
    setSendToRaw(v);
  };
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("CASH");
  const bank = useBankEntry();
  const [amountTouched, setAmountTouched] = useState(false);
  const dueNow = request.dueNow ?? 0;
  const remaining = Math.max(0, Number((dueNow - request.receivedAgainstAsk).toFixed(2)));
  useEffect(() => {
    if (!amountTouched) setAmount(remaining > 0 ? String(remaining) : "");
  }, [remaining, amountTouched]);

  const commsQuery = useQuery({
    queryKey: ["entry-communications", entryId],
    queryFn: () => listEntryCommunications(session!, entryId),
    enabled: !!session,
  });
  const answeredComm =
    (commsQuery.data?.items ?? []).find(
      (c) => c.commType === "INTERIM_INVOICE" && c.sendStatus === "DISPATCHED" && (c.createdAt ?? "") >= request.requestedAt && replySettled(c),
    ) ?? null;
  const answered = !!answeredComm;
  const replyOff = (commsQuery.data?.repliesOff ?? []).includes("INTERIM_INVOICE");
  // Its reply is not asked for (the admin console's setting): the checklist has no such step.
  const hideAnswer = answeredComm?.acknowledgementStatus === "NOT_ASKED" || (replyOff && !answered);
  const paid = request.state === "PAID";
  const invalidateAll = () => {
    for (const key of ["interim-payments", "stay-extensions", "entry", "entry-communications", "billing-summary", "entry-timers", "entry-trace", "invoice-preview"]) {
      void queryClient.invalidateQueries({ queryKey: [key, entryId] });
    }
    void queryClient.invalidateQueries({ queryKey: ["invoice-preview", request.invoiceId] });
    onChanged();
  };

  // Mid-stay payment reminder (2026-08-22): the due-by and the W41 clock's state ride on the
  // interim-payments list (shared with the long-stay block), so the extension's bill reads the
  // same server-computed facts.
  const listQ = useQuery({
    queryKey: ["interim-payments", entryId],
    queryFn: () => listInterimPayments(session!, entryId),
    enabled: !!session,
  });
  const listed = listQ.data?.requests.find((r) => r.id === request.id) ?? null;
  const reminder = listed?.reminder ?? null;
  const dueBy = listed?.dueBy ?? request.dueBy ?? reminder?.dueBy ?? null;
  const remindersSent = listed?.remindersSent ?? request.remindersSent ?? 0;
  const lastReminderAt = listed?.lastReminderAt ?? request.lastReminderAt ?? null;
  const overdue = !paid && !!dueBy && new Date(dueBy).getTime() < Date.now();
  const [dueEdit, setDueEdit] = useState(false);
  const [dueDraft, setDueDraft] = useState("");
  // The guest's promise (2026-08-22 — S3's "when will they pay?" at S7): noted BEFORE the bill
  // goes out; a dated promise becomes the bill's due-by, so the reminder fires at the guest's
  // own time, and the document prints it. "Paying at the desk" keeps the default reminder.
  const promiseKind = (listed?.promiseKind ?? request.promiseKind ?? null) as "NOW" | "BY_DATE" | null;
  const promisedBy = listed?.promisedBy ?? request.promisedBy ?? null;
  const promiseNote = listed?.promiseNote ?? request.promiseNote ?? null;
  const promiseText = promiseKind === "BY_DATE" && promisedBy ? `by ${fmtWhen(promisedBy)}` : promiseKind === "NOW" ? "paying at the desk" : null;
  const [promiseEdit, setPromiseEdit] = useState(false);
  const [pKind, setPKind] = useState<"NOW" | "BY_DATE">("BY_DATE");
  const [pWhen, setPWhen] = useState("");
  const [pNote, setPNote] = useState("");
  const openPromiseForm = () => {
    setPKind(promiseKind ?? "BY_DATE");
    setPWhen(toLocalInput(promisedBy ?? dueBy));
    setPNote(promiseNote ?? "");
    setPromiseEdit(true);
  };
  const promiseM = useMutation({
    mutationFn: () =>
      recordInterimPromise(session!, request.id, {
        kind: pKind,
        promisedBy: pKind === "BY_DATE" ? fromLocalInput(pWhen) : undefined,
        note: pNote.trim() || undefined,
      }),
    onSuccess: (r) => {
      toast.success(r.promiseKind === "BY_DATE" ? `Promise recorded — the reminder is set for ${fmtWhen(r.promisedBy)}` : "Recorded — paying at the desk");
      setPromiseEdit(false);
      invalidateAll();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not record the promise"),
  });
  const dueM = useMutation({
    mutationFn: () => setInterimDueBy(session!, request.id, fromLocalInput(dueDraft)!),
    onSuccess: () => {
      toast.success("Payment due-by updated — the reminder clock is re-armed");
      setDueEdit(false);
      invalidateAll();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not change the due date"),
  });

  const sendM = useMutation({
    mutationFn: () => dispatchInvoice(session!, request.invoiceId!, { dispatchedTo: sendTo.trim() || undefined }),
    onSuccess: () => {
      toast.success(replyOff ? "Interim invoice sent" : "Interim invoice sent — next, record the guest's answer");
      invalidateAll();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not send the interim invoice"),
  });
  const payM = useMutation({
    mutationFn: () => recordInterimPayment(session!, request.id, { amount: Number(amount), paymentMethod: method, ...bank.body(method) }),
    onSuccess: (out) => {
      toast.success(
        out.paidInFull
          ? `Interim payment received in full (${money(out.receivedAgainstAsk, currency)})`
          : `${money(Number(amount), currency)} received — ${money(out.remaining, currency)} still to come on this bill`,
      );
      setAmountTouched(false);
      invalidateAll();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not record the payment"),
  });
  const withdrawM = useMutation({
    mutationFn: () => withdrawInterimPayment(session!, request.id),
    onSuccess: () => {
      toast.info("Interim bill withdrawn — its invoice is superseded");
      invalidateAll();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not withdraw"),
  });

  const f = request.figures;
  const askLabel = f?.askLabel ?? (request.askMode === "PERCENT" ? `${request.askValue}% of the projected total` : money(request.askValue ?? 0, currency));

  const billStateLabel = !dispatched ? "generated · not sent" : paid ? "Paid" : "Sent";
  const billStep: StepItem = {
    key: "bill",
    label: "Interim bill generated",
    state: "done",
    summary: askLabel,
    body: (
      <>
        {/* The document row — the same shape as the S3 proforma row: number · state · View · PDF,
            with the house-format document inline beneath it (no PDF needed to look at it). */}
        {request.invoiceId && (
          <div>
            <div className="fact b-transit" style={{ padding: "6px 11px", fontSize: 12, justifyContent: "space-between", width: "100%" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <Receipt style={{ width: 13, height: 13 }} />
                <span className="mono">{request.invoiceId}</span>
                <span className="tag">Interim invoice</span>
                <span style={{ color: "var(--ink-3)" }}>due now {money(dueNow, currency)}</span>
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span className={`tag${paid ? " ok" : !dispatched ? " warn" : ""}`}>{billStateLabel}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setPreviewOpen((o) => !o)}
                  title="Show the interim invoice right here — no PDF needed"
                >
                  {previewOpen ? <EyeOff style={{ width: 14, height: 14 }} /> : <Eye style={{ width: 14, height: 14 }} />}
                  {previewOpen ? "Hide" : "View"}
                </button>
                {session && <PdfButton label="PDF" open={() => openInvoicePdf(session, request.invoiceId!)} />}
              </span>
            </div>
            {previewOpen && <ProformaPreview invoiceId={request.invoiceId} title="Interim invoice document" />}
          </div>
        )}
        <Ledger
          rows={[
            f && {
              key: "proj",
              label: (
                <>
                  Projected total at checkout{" "}
                  <span style={{ color: "var(--ink-3)" }}>
                    ({f.nightsSlept} slept + {f.nightsToCome} to come{f.otherChargesSoFar > 0 ? ` + ${money(f.otherChargesSoFar, currency)} other charges` : ""})
                  </span>
                </>
              ),
              value: money(f.projectedTotal, currency),
            },
            f && { key: "ask", label: `This bill — ${askLabel}`, value: money(f.askAmount ?? dueNow, currency) },
            f && f.receivedSoFar > 0 && { key: "recv", label: "Already received before this bill", value: money(f.receivedSoFar, currency), kind: "minus" as const },
            {
              key: "due",
              label: request.receivedAgainstAsk > 0 && !paid ? `Due now (${money(request.receivedAgainstAsk, currency)} of it received)` : "Due now",
              value: money(dueNow, currency),
              kind: "total" as const,
            },
            f && f.balanceAtCheckout != null && { key: "bal", label: "Left to pay at checkout after this", value: money(f.balanceAtCheckout, currency), kind: "muted" as const },
          ]}
        />
        {!paid && (
          <div style={{ display: "grid", gap: 6 }}>
            <div
              className="fact"
              style={{
                padding: "6px 11px",
                fontSize: 12,
                width: "100%",
                flexWrap: "wrap",
                gap: 8,
                ...(overdue ? { borderColor: "var(--stop)", background: "var(--stop-t)", color: "var(--stop)" } : {}),
              }}
            >
              <AlarmClock style={{ width: 13, height: 13 }} />
              {dueBy ? (
                overdue ? (
                  <b>
                    {promiseKind === "BY_DATE" ? "Promise lapsed — the guest said" : "Payment overdue — was due"} {fmtWhen(dueBy)}
                  </b>
                ) : (
                  <span>
                    {promiseKind === "BY_DATE" ? "Payment promised by" : "Payment due by"} <b>{fmtWhen(dueBy)}</b> · reminder {countdownTo(dueBy).text}
                  </span>
                )
              ) : (
                <span>No due date — no reminder clock is set</span>
              )}
              {remindersSent > 0 && (
                <span style={{ color: overdue ? "inherit" : "var(--ink-3)" }}>
                  · {plural(remindersSent, "reminder")} raised{lastReminderAt ? `, last ${fmtWhen(lastReminderAt)}` : ""}
                </span>
              )}
              {reminder?.nextReminderAt && remindersSent > 0 && (
                <span style={{ color: overdue ? "inherit" : "var(--ink-3)" }}>· next {countdownTo(reminder.nextReminderAt).text}</span>
              )}
              <span className="ln" />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  if (promiseKind === "BY_DATE") {
                    openPromiseForm();
                    return;
                  }
                  setDueDraft(toLocalInput(dueBy));
                  setDueEdit((v) => !v);
                }}
              >
                {dueEdit ? "Cancel" : dueBy ? "Change" : "Set a due date"}
              </button>
            </div>
            {dueEdit && (
              <div style={row}>
                <div className="field" style={fieldTight}>
                  <label>Payment due by</label>
                  <DateTimeInput className="dinput" value={dueDraft} onChange={(e) => setDueDraft(e.target.value)} />
                </div>
                <button type="button" className="btn btn-primary btn-sm" disabled={!dueDraft || dueM.isPending} onClick={() => dueM.mutate()}>
                  {dueM.isPending ? "Saving…" : "Save due date"}
                </button>
                <span style={{ paddingBottom: 9 }}>
                  <Help label="About the due date">The reminder clock moves with it.</Help>
                </span>
              </div>
            )}
          </div>
        )}
      </>
    ),
  };

  const promiseForm = (
    <>
      <div style={row}>
        <div className="field" style={{ ...fieldTight, width: 250 }}>
          <label>When will the guest pay?</label>
          <select value={pKind} onChange={(e) => setPKind(e.target.value as "NOW" | "BY_DATE")}>
            <option value="BY_DATE">By a promised date &amp; time</option>
            <option value="NOW">Now — paying at the desk</option>
          </select>
        </div>
        {pKind === "BY_DATE" && (
          <div className="field" style={fieldTight}>
            <label>Promised by</label>
            <DateTimeInput className="dinput" value={pWhen} onChange={(e) => setPWhen(e.target.value)} />
          </div>
        )}
      </div>
      <div style={row}>
        <div className="field" style={{ ...fieldTight, flex: 1, minWidth: 240 }}>
          <label>Note (optional — what they actually said)</label>
          <input value={pNote} onChange={(e) => setPNote(e.target.value)} placeholder="e.g. will transfer after lunch on Friday" />
        </div>
        <button type="button" className="btn btn-primary btn-sm" disabled={promiseM.isPending || (pKind === "BY_DATE" && !pWhen)} onClick={() => promiseM.mutate()}>
          {promiseM.isPending ? "Saving…" : "Record the promise"}
        </button>
        {promiseEdit && promiseKind && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPromiseEdit(false)}>
            Cancel
          </button>
        )}
      </div>
      <Help label="About the promise">
        A dated promise moves the reminder clock to that moment and the bill prints it. &ldquo;Paying at the desk&rdquo; keeps the default reminder
        {dueBy ? ` (${fmtWhen(dueBy)})` : ""} in case it slips.
      </Help>
    </>
  );
  const promiseStep: StepItem = paid
    ? { key: "promise", label: "Guest's promise", state: "done", summary: promiseText ? `${promiseText}${promiseNote ? ` · “${promiseNote}”` : ""}` : "not recorded" }
    : promiseEdit
      ? { key: "promise", label: "When will the guest pay?", state: "cur", body: promiseForm }
      : promiseKind
        ? {
            key: "promise",
            label: "Guest's promise recorded",
            state: "done",
            summary: (
              <>
                {promiseText}
                {promiseNote ? ` · “${promiseNote}”` : ""}
                <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 6, padding: "1px 8px", fontSize: 11 }} onClick={openPromiseForm}>
                  Change
                </button>
              </>
            ),
          }
        : dispatched
          ? {
              key: "promise",
              label: "Guest's promise",
              state: "todo",
              summary: (
                <>
                  not recorded — the bill went out without one
                  <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 6, padding: "1px 8px", fontSize: 11 }} onClick={openPromiseForm}>
                    Record it
                  </button>
                </>
              ),
            }
          : { key: "promise", label: "When will the guest pay?", state: "cur", summary: "ask before the bill goes out — the bill prints it", body: promiseForm };

  const sendStep: StepItem = dispatched
    ? {
        key: "send",
        label: "Bill sent to the guest",
        state: "done",
        summary: `${request.invoice?.dispatchedTo ? `to ${request.invoice.dispatchedTo} · ` : ""}${fmtWhen(request.invoice?.dispatchedAt)}`,
      }
    : !promiseKind
      ? { key: "send", label: "Send the bill to the guest", state: "todo", summary: "after you note when the guest will pay" }
      : {
        key: "send",
        label: "Send the bill to the guest",
        state: "cur",
        body: (
          <>
            <div style={row}>
              <div className="field" style={{ ...fieldTight, flex: 1, minWidth: 220 }}>
                <label>Send to</label>
                <input value={sendTo} onChange={(e) => setSendTo(e.target.value)} placeholder={recipient.party ? `${recipient.party}'s email` : "guest@example.com"} />
                {recipientHint(recipient, sendTo) ? <span className="hint">{recipientHint(recipient, sendTo)}</span> : null}
              </div>
              <button type="button" className="btn btn-primary btn-sm" disabled={sendM.isPending || !request.invoiceId} onClick={() => sendM.mutate()}>
                {sendM.isPending ? "Sending…" : "Send interim invoice"}
              </button>
              <Help label="About sending">
                Emails the bill with the PDF attached. Money is taken only against a bill the guest received, so {hideAnswer ? "the payment comes" : "the answer and the payment come"}{" "}
                after this.
              </Help>
            </div>
          </>
        ),
      };

  const answerStep: StepItem = answered
    ? {
        key: "answer",
        label: "Guest's answer recorded",
        state: "done",
        summary: `accepted · ${fmtWhen(answeredComm?.acknowledgementReceivedAt ?? answeredComm?.createdAt)}`,
      }
    : dispatched
      ? {
          key: "answer",
          label: "Record the guest's answer",
          state: "cur",
          body: <CommunicationAcceptanceBlock entryId={entryId} commType="INTERIM_INVOICE" title="Interim invoice" sinceIso={request.requestedAt} />,
        }
      : { key: "answer", label: "Record the guest's answer", state: "todo", summary: "after the bill is sent" };

  const paymentCount = request.payments?.length ?? 0;
  const payStep: StepItem = paid
    ? {
        key: "pay",
        label: "Payment received",
        state: "done",
        summary: `${money(request.receivedAgainstAsk, currency)}${paymentCount > 0 ? ` in ${plural(paymentCount, "payment")}` : ""}${request.paidAt ? ` · ${fmtWhen(request.paidAt)}` : ""}`,
      }
    : answered
      ? {
          key: "pay",
          label: "Log the payment received",
          state: "cur",
          summary: request.receivedAgainstAsk > 0 ? `${money(request.receivedAgainstAsk, currency)} received · ${money(remaining, currency)} still to come` : undefined,
          body: (
            <div style={row}>
              <div className="field" style={{ ...fieldTight, width: 150 }}>
                <label>Amount received</label>
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => {
                    setAmountTouched(true);
                    setAmount(e.target.value);
                  }}
                />
              </div>
              <div className="field" style={{ ...fieldTight, width: 140 }}>
                <label>Method</label>
                <select value={method} onChange={(e) => setMethod(e.target.value)}>
                  <option value="CASH">Cash</option>
                  <option value="CARD">Card</option>
                  <option value="MOBILE_PAYMENT">QR (BoB merchant)</option>
                  <option value="BANK_TRANSFER">Bank transfer</option>
                </select>
              </div>
              <BankFields entry={bank} method={method} />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={payM.isPending || !(Number(amount) > 0) || !!bank.missing(method)}
                title={bank.missing(method) ?? undefined}
                onClick={() => payM.mutate()}
              >
                {payM.isPending ? "Recording…" : "Log payment received"}
              </button>
            </div>
          ),
        }
      : { key: "pay", label: "Log the payment received", state: "todo", summary: dispatched ? "after the guest's answer is recorded" : hideAnswer ? "after the bill is sent" : "after the bill is sent and answered" };

  return (
    <div style={{ border: "1px solid var(--line-2)", borderRadius: "var(--r-sm)", padding: "4px 12px 8px", background: "var(--paper)" }}>
      <StepList steps={[...leadSteps, billStep, promiseStep, sendStep, ...(hideAnswer ? [] : [answerStep]), payStep, ...tailSteps]} />
      {canWithdraw && !paid && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
          <button type="button" className="btn btn-ghost btn-sm" disabled={withdrawM.isPending} onClick={() => withdrawM.mutate()} title="Drops this bill — its invoice is superseded; nothing was taken">
            Withdraw this bill
          </button>
        </div>
      )}
    </div>
  );
}

// ── Interim payment (long stay) ─────────────────────────────────────────────────────────────

export function InterimPaymentBlock({
  entry,
  onChanged,
  unfolded = false,
}: {
  entry: EntryDetail;
  onChanged?: () => void;
  /** Shown open with no fold of its own — Stay's payment sub-tab (2026-10-29). */
  unfolded?: boolean;
}) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const entryId = entry.id;
  const recipient = useInvoiceRecipient(entry);
  const q = useQuery({
    queryKey: ["interim-payments", entryId],
    queryFn: () => listInterimPayments(session!, entryId),
    enabled: !!session,
  });
  const figures = q.data?.figures ?? null;
  const currency = figures?.currency ?? "BTN";
  const requests = q.data?.requests ?? [];
  const open = requests.find((r) => r.kind === "LONG_STAY" && (r.state === "SUGGESTED" || r.state === "REQUESTED" || r.state === "BILLED"));
  const openExtension = requests.find((r) => r.kind === "EXTENSION" && (r.state === "REQUESTED" || r.state === "BILLED"));
  // The extension's own bills live under "Extend the stay" — listing them here too read as duplicates.
  const history = requests.filter((r) => r !== open && r.kind === "LONG_STAY" && r.state !== "SUGGESTED");
  const [mode, setMode] = useState<"PERCENT" | "AMOUNT">("PERCENT");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  // Collapsed until opened (2026-08-24, operator request) — the header tags carry the live state.
  const [expandedState, setExpanded] = useState(false);
  const expanded = unfolded || expandedState;

  const createM = useMutation({
    mutationFn: () => createInterimPayment(session!, entryId, { askMode: mode, askValue: Number(value), note: note.trim() || undefined }),
    onSuccess: (out) => {
      toast.success(`Interim invoice ${out.invoice.id} generated for ${money(out.request.dueNow ?? 0, currency)} — next, send it to the guest`);
      setValue("");
      setNote("");
      for (const key of ["interim-payments", "entry", "billing-summary", "entry-trace"]) void queryClient.invalidateQueries({ queryKey: [key, entryId] });
      onChanged?.();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not generate the interim bill"),
  });

  const suggested = open?.state === "SUGGESTED";
  const showAskForm = !open || suggested;
  const inHouse = entry.currentStage === "S7" && entry.folio?.state === "LIVE";

  return (
    <div className="block">
      <BlockH expanded={expanded} onToggle={unfolded ? undefined : () => setExpanded((v) => !v)}>
        <Receipt style={{ width: 13, height: 13 }} />
        Interim payment
        <Help label="About interim payments">
          A part payment during a long stay: ask for a share of the projected total, send the bill, record the guest&rsquo;s answer if it is asked for, then log the
          money. The night audit raises a prompt here every few nights on its own.
        </Help>
        {suggested && <span className="tag warn">Due</span>}
        {open && !suggested && <span className={STATE_TAG[open.state]?.cls ?? "tag"}>{STATE_TAG[open.state]?.label ?? open.state}</span>}
        {open && !suggested && open.reminder?.overdue && <span className="tag stop">Payment overdue</span>}
      </BlockH>
      {expanded && (
      <>
      {figures && (
        <Ledger
          rows={[
            {
              key: "proj",
              label: (
                <>
                  Projected total at checkout{" "}
                  <span style={{ color: "var(--ink-3)" }}>
                    ({figures.nightsSlept} {figures.nightsSlept === 1 ? "night" : "nights"} slept + {figures.nightsToCome} to come
                    {figures.otherChargesSoFar > 0 ? ` + ${money(figures.otherChargesSoFar, currency)} other charges` : ""})
                  </span>
                </>
              ),
              value: money(figures.projectedTotal, currency),
            },
            { key: "recv", label: "Received so far", value: money(figures.receivedSoFar, currency), kind: "minus" },
            { key: "out", label: "Outstanding on the folio now", value: money(figures.outstandingNow, currency), kind: "total" },
          ]}
        />
      )}
      {suggested && open && (
        <div className="fact" style={{ padding: "7px 11px", fontSize: 12, width: "100%", marginTop: 8, border: "1px solid var(--warn)", background: "var(--warn-t)" }}>
          <b>Interim payment due</b> — raised by the night audit after {plural(open.nightsSleptAtPrompt ?? 2, "night")}. Put a figure on it below to generate the bill.
        </div>
      )}
      {openExtension && (
        <p className="fact b-transit" style={{ padding: "7px 11px", fontSize: 12, width: "100%", marginTop: 8 }}>
          A stay extension is in progress with its own bill — see <b>Extend the stay</b> below.
        </p>
      )}
      {showAskForm && inHouse && !openExtension && (
        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          <div style={{ ...row, alignItems: "center", fontSize: 12.5 }}>
            <span>Ask the guest now for</span>
            <AskInline
              mode={mode}
              value={value}
              onChange={(p) => {
                if (p.mode) setMode(p.mode);
                if (p.value !== undefined) setValue(p.value);
              }}
              disabled={createM.isPending}
            />
            <span>of the projected total{mode === "PERCENT" && figures ? ` (${money(figures.projectedTotal, currency)})` : ""}</span>
          </div>
          <div style={row}>
            <div className="field" style={{ ...fieldTight, flex: 1, minWidth: 200 }}>
              <label>Note (optional)</label>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. week-1 payment as agreed" />
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={createM.isPending || !(Number(value) > 0) || (mode === "PERCENT" && Number(value) > 100)}
              onClick={() => createM.mutate()}
              title="Generates the interim invoice with the server's figures — nothing is sent yet"
            >
              {createM.isPending ? "Generating…" : "Generate interim bill"}
            </button>
            <Help label="About the bill">
              Money already received is netted off the ask — the bill states what is due now. Next you note when the guest will pay, then send
              the bill.
            </Help>
          </div>
        </div>
      )}
      {open && !suggested && (
        <div style={{ marginTop: 8 }}>
          <InterimRequestPanel entryId={entryId} request={open} recipient={recipient} onChanged={() => onChanged?.()} />
        </div>
      )}
      {history.length > 0 && (
        <div style={{ marginTop: 10, display: "grid", gap: 2 }}>
          <div style={miniHeading}>Earlier interim bills</div>
          {history.map((r) => (
            <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, padding: "4px 0", borderTop: "1px dashed var(--line)" }}>
              <span className={STATE_TAG[r.state]?.cls ?? "tag"}>{STATE_TAG[r.state]?.label ?? r.state}</span>
              <span>
                {r.figures?.askLabel ?? ""} · due {money(r.dueNow ?? 0, currency)}
                {r.state === "PAID" ? ` · received ${money(r.receivedAgainstAsk, currency)}` : ""}
              </span>
              <span style={{ color: "var(--ink-3)", marginLeft: "auto" }}>{r.requestedAt.slice(0, 10)}</span>
            </div>
          ))}
        </div>
      )}
      </>
      )}
    </div>
  );
}

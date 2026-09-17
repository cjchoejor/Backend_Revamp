"use client";

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, CalendarPlus, Check, Eye, EyeOff, Receipt } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { dispatchInvoice } from "@/lib/api/reservation-setup";
import { openInvoicePdf } from "@/lib/api/documents";
import {
  commitStayExtension,
  createInterimPayment,
  listInterimPayments,
  listStayExtensions,
  previewStayExtension,
  recordInterimPayment,
  requestStayExtension,
  recordInterimPromise,
  setInterimDueBy,
  withdrawInterimPayment,
  withdrawStayExtension,
  type InterimPaymentRow,
  type StayExtensionPreview,
} from "@/lib/api/stay-money";
import { listEntryCommunications } from "@/lib/api/entries";
import { money } from "@/lib/desk/workspace";
import { countdownTo } from "@/lib/desk/timers";
import type { RoomCompositionInput } from "@/lib/api/quotations";
import type { EntryDetail } from "@/types/api";
import { CommunicationAcceptanceBlock } from "./communication-acceptance";
import { DeskConfirmModal } from "./confirm-modal";
import { PdfButton } from "./pdf-button";
import { ProformaPreview } from "./quotation-preview";
import { RoomCompositionPlanner } from "./room-compositions-board";

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
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};
const fmtWhen = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};
const addDaysIso = (iso: string, n: number) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Calendar nights between two YYYY-MM-DD dates (date arithmetic, not money). */
const nightsBetween = (from: string, to: string) => {
  const a = new Date(`${from.slice(0, 10)}T00:00:00Z`).getTime();
  const b = new Date(`${to.slice(0, 10)}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "in 23h 59m" → "23h 59m left"; the engine's "due now" → "expiring". */
const heldLeft = (cd: { text: string }) => (cd.text === "due now" ? "expiring" : `${cd.text.replace(/^in /, "")} left`);
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
  REQUESTED: { label: "Bill ready to send", cls: "tag" },
  BILLED: { label: "Bill sent — awaiting payment", cls: "tag warn" },
  PAID: { label: "Paid", cls: "tag ok" },
  WITHDRAWN: { label: "Withdrawn", cls: "tag" },
  LAPSED: { label: "Lapsed", cls: "tag" },
};
/** Extension states — "Paid" alone would read as finished, but the commit is still ahead. */
const EXT_TAG: Record<string, { label: string; cls: string }> = {
  REQUESTED: { label: "Nights held — bill ready to send", cls: "tag" },
  BILLED: { label: "Bill sent — awaiting payment", cls: "tag warn" },
  PAID: { label: "Paid — ready to commit", cls: "tag ok" },
  COMMITTED: { label: "Extended", cls: "tag ok" },
  WITHDRAWN: { label: "Withdrawn", cls: "tag" },
  LAPSED: { label: "Lapsed — unpaid", cls: "tag" },
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
  guestEmail,
  onChanged,
  canWithdraw = true,
  leadSteps = [],
  tailSteps = [],
}: {
  entryId: string;
  request: InterimPaymentRow;
  guestEmail: string | null;
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
  const [sendTo, setSendTo] = useState(guestEmail ?? "");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("CASH");
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
      (c) => c.commType === "INTERIM_INVOICE" && c.sendStatus === "DISPATCHED" && (c.createdAt ?? "") >= request.requestedAt && c.acknowledgementStatus === "RECEIVED",
    ) ?? null;
  const answered = !!answeredComm;
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
      toast.success("Interim invoice sent — next, record the guest's answer");
      invalidateAll();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not send the interim invoice"),
  });
  const payM = useMutation({
    mutationFn: () => recordInterimPayment(session!, request.id, { amount: Number(amount), paymentMethod: method }),
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

  const billStateLabel = !dispatched ? "Ready to send" : paid ? "Paid" : "Sent";
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
                <span className={`tag${paid ? " ok" : ""}`}>{billStateLabel}</span>
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
                  <input type="datetime-local" value={dueDraft} onChange={(e) => setDueDraft(e.target.value)} />
                </div>
                <button type="button" className="btn btn-primary btn-sm" disabled={!dueDraft || dueM.isPending} onClick={() => dueM.mutate()}>
                  {dueM.isPending ? "Saving…" : "Save due date"}
                </button>
                <span style={{ ...hint, paddingBottom: 9 }}>The reminder clock moves with it.</span>
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
            <input type="datetime-local" value={pWhen} onChange={(e) => setPWhen(e.target.value)} />
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
      <p style={hint}>
        A dated promise moves the reminder clock to that moment and the bill prints it. &ldquo;Paying at the desk&rdquo; keeps the default reminder
        {dueBy ? ` (${fmtWhen(dueBy)})` : ""} in case it slips.
      </p>
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
                <input value={sendTo} onChange={(e) => setSendTo(e.target.value)} placeholder="guest@example.com" />
              </div>
              <button type="button" className="btn btn-primary btn-sm" disabled={sendM.isPending || !request.invoiceId} onClick={() => sendM.mutate()}>
                {sendM.isPending ? "Sending…" : "Send interim invoice"}
              </button>
            </div>
            <p style={hint}>Emails the bill with the PDF attached. Money is taken only against a bill the guest received, so the answer and the payment come after this.</p>
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
                  <option value="BANK_TRANSFER">Bank transfer</option>
                  <option value="MBOB">mBoB</option>
                </select>
              </div>
              <button type="button" className="btn btn-primary btn-sm" disabled={payM.isPending || !(Number(amount) > 0)} onClick={() => payM.mutate()}>
                {payM.isPending ? "Recording…" : "Log payment received"}
              </button>
            </div>
          ),
        }
      : { key: "pay", label: "Log the payment received", state: "todo", summary: dispatched ? "after the guest's answer is recorded" : "after the bill is sent and answered" };

  return (
    <div style={{ border: "1px solid var(--line-2)", borderRadius: "var(--r-sm)", padding: "4px 12px 8px", background: "var(--paper)" }}>
      <StepList steps={[...leadSteps, billStep, promiseStep, sendStep, answerStep, payStep, ...tailSteps]} />
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

export function InterimPaymentBlock({ entry, onChanged }: { entry: EntryDetail; onChanged?: () => void }) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const entryId = entry.id;
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
  const [expanded, setExpanded] = useState(false);

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
      <BlockH expanded={expanded} onToggle={() => setExpanded((v) => !v)}>
        <Receipt style={{ width: 13, height: 13 }} />
        Interim payment
        {suggested && <span className="tag warn">Due</span>}
        {open && !suggested && <span className={STATE_TAG[open.state]?.cls ?? "tag"}>{STATE_TAG[open.state]?.label ?? open.state}</span>}
        {open && !suggested && open.reminder?.overdue && <span className="tag stop">Payment overdue</span>}
      </BlockH>
      {expanded && (
      <>
      <p style={{ ...hint, fontSize: 12, color: "var(--ink-2)", marginBottom: 8 }}>
        A part payment during a long stay: ask for a share of the <b>projected total</b>, send the bill, record the guest&rsquo;s
        answer, then log the money. The night audit raises a prompt here every few nights on its own.
      </p>
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
          </div>
          <p style={hint}>Money already received is netted off the ask — the bill states what is due now. Next you note when the guest will pay, then send the bill.</p>
        </div>
      )}
      {open && !suggested && (
        <div style={{ marginTop: 8 }}>
          <InterimRequestPanel entryId={entryId} request={open} guestEmail={entry.guestProfile?.email ?? null} onChanged={() => onChanged?.()} />
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

// ── Extend the stay ─────────────────────────────────────────────────────────────────────────

export function StayExtensionBlock({ entry, onChanged }: { entry: EntryDetail; onChanged?: () => void }) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const entryId = entry.id;
  const isFom = (LEVEL_RANK[session?.actorLevel ?? "L1"] ?? 0) >= 2;
  const currentCheckOut = (entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate ?? "").slice(0, 10);

  const q = useQuery({
    queryKey: ["stay-extensions", entryId],
    queryFn: () => listStayExtensions(session!, entryId),
    enabled: !!session,
  });
  const requests = q.data?.requests ?? [];
  const active = requests.find((r) => r.state === "REQUESTED" || r.state === "BILLED" || r.state === "PAID") ?? null;
  const history = requests.filter((r) => r !== active);

  // ── New request form ──
  const [newDate, setNewDate] = useState(currentCheckOut ? addDaysIso(currentCheckOut, 1) : "");
  const [mode, setMode] = useState<"PERCENT" | "AMOUNT">("PERCENT");
  const [value, setValue] = useState("50");
  const [reason, setReason] = useState("");
  const [moveTo, setMoveTo] = useState<string>("");
  const [negotiate, setNegotiate] = useState(false);
  const [tableComps, setTableComps] = useState<RoomCompositionInput[]>([]);
  const [preview, setPreview] = useState<StayExtensionPreview | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  // Collapsed until opened (2026-08-24, operator request) — the header tags carry the live state.
  const [expanded, setExpanded] = useState(false);

  // A move-to pick applies one room to every extra night, and names WHICH current room it
  // replaces — on a multi-room booking the backend must not guess that from the room list.
  const perNightFor = (to: string) => (preview && to ? preview.extraNights.map((date) => ({ date, roomId: to })) : undefined);
  const replaceRoomIdFor = (to: string) => (preview && to ? (preview.currentRooms.find((r) => !r.extendableInPlace)?.roomId ?? undefined) : undefined);
  const previewM = useMutation({
    mutationFn: (args: { to?: string; comps?: RoomCompositionInput[] }) =>
      previewStayExtension(session!, entryId, {
        newCheckOutDate: newDate,
        perNight: perNightFor(args.to ?? moveTo),
        replaceRoomId: replaceRoomIdFor(args.to ?? moveTo),
        roomCompositions: args.comps?.length ? args.comps : undefined,
        askMode: mode,
        askValue: Number(value) > 0 ? Number(value) : undefined,
      }),
    onSuccess: (p) => setPreview(p),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not check the extension"),
  });
  // Re-project when the ask or the rate table changes (debounced), once a preview exists.
  useEffect(() => {
    if (!preview) return;
    const t = setTimeout(() => previewM.mutate({ comps: negotiate ? tableComps : undefined }), 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, value, tableComps, negotiate]);

  const invalidateAll = () => {
    for (const key of ["stay-extensions", "interim-payments", "entry", "entry-communications", "billing-summary", "entry-timers", "entry-trace", "room-plan-history", "room-change-candidates"]) {
      void queryClient.invalidateQueries({ queryKey: [key, entryId] });
    }
    onChanged?.();
  };
  const requestM = useMutation({
    mutationFn: () =>
      requestStayExtension(session!, entryId, {
        newCheckOutDate: newDate,
        perNight: perNightFor(moveTo),
        replaceRoomId: replaceRoomIdFor(moveTo),
        roomCompositions: negotiate && tableComps.length ? tableComps : undefined,
        reason: reason.trim(),
        askMode: mode,
        askValue: Number(value),
      }),
    onSuccess: (out) => {
      toast.success(
        `Extension to ${fmtDay(out.request.newCheckOutDate)} requested — the extra nights are held until ${fmtWhen(out.request.holdExpiresAt)}. Next: send the bill for ${money(out.interim.dueNow ?? 0, out.preview.currency)}.`,
        { duration: 12000 },
      );
      setConfirmOpen(false);
      setPreview(null);
      setReason("");
      setMoveTo("");
      setNegotiate(false);
      invalidateAll();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "The extension was refused"),
  });
  const commitM = useMutation({
    mutationFn: () => commitStayExtension(session!, entryId, active!.id),
    onSuccess: (out) => {
      setCommitOpen(false);
      const o = out.outcome;
      if (o.walk.blocked) {
        toast.warning(`Extension recorded but the booking is at ${o.walk.reachedStage}, not back at the Stay step yet: ${o.walk.blocked.message}`, { duration: 14000 });
      } else {
        const delta =
          o.pricing.delta != null && Math.abs(o.pricing.delta) >= 0.01
            ? ` · stay total now ${money(o.pricing.newTotal, o.pricing.currency ?? "BTN")} (${o.pricing.delta > 0 ? "+" : "−"}${money(Math.abs(o.pricing.delta), o.pricing.currency ?? "BTN")})`
            : "";
        toast.success(`Stay extended to ${fmtDay(o.extension?.newCheckOutDate)}${delta}. Nothing was sent to the guest — the re-issued voucher carries the new dates.`, { duration: 14000 });
      }
      invalidateAll();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "The extension could not be committed"),
  });
  const withdrawM = useMutation({
    mutationFn: () => withdrawStayExtension(session!, entryId, active!.id),
    onSuccess: () => {
      toast.info("Extension withdrawn — the extra nights are released");
      invalidateAll();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not withdraw the extension"),
  });

  const replacedRoom = preview?.currentRooms.find((r) => !r.extendableInPlace) ?? null;
  const alternatives = useMemo(
    () => (preview ? preview.candidates.filter((c) => c.selectable && !preview.currentRooms.some((r) => r.roomId === c.roomId)) : []),
    [preview],
  );
  const extensionRoomIds = useMemo(() => Array.from(new Set((preview?.plan ?? []).map((p) => p.roomId))), [preview]);
  const currency = preview?.currency ?? active?.pricingPreview?.figures?.currency ?? "BTN";
  const dueNow = preview?.figures.dueNow ?? null;
  const canRequest = !!preview && !preview.blockedReason && reason.trim().length > 0 && Number(value) > 0 && (dueNow ?? 0) > 0;

  // ── The four setup steps ──
  const previewFresh = !!preview && preview.newCheckOut.slice(0, 10) === newDate;
  const extraNights = previewFresh ? preview!.extraNights.length : currentCheckOut && newDate ? Math.max(0, nightsBetween(currentCheckOut, newDate)) : 0;
  const roomsSettled = previewFresh && !preview!.blockedReason;
  const moneySettled = roomsSettled && (dueNow ?? 0) > 0;
  const movesText = (moves: StayExtensionPreview["moves"] | undefined, from: string) =>
    moves && moves.length > 0
      ? `From ${fmtDay(from)}: ${moves.map((m) => `Room ${m.fromRoomNumber} → ${m.toRoomNumber}${m.crossType ? " (different type)" : ""}`).join(", ")}`
      : null;

  const dateStep: StepItem = {
    key: "date",
    label: "New checkout",
    state: previewFresh ? "done" : "cur",
    summary: previewFresh ? `${fmtDay(currentCheckOut)} → ${fmtDay(newDate)} · ${plural(extraNights, "more night")}` : `currently ${fmtDay(currentCheckOut)}`,
    body: (
      <div style={{ ...row, gap: 10 }}>
        <div className="field" style={fieldTight}>
          <label>New checkout date</label>
          <input
            type="date"
            value={newDate}
            min={currentCheckOut ? addDaysIso(currentCheckOut, 1) : undefined}
            onChange={(e) => {
              setNewDate(e.target.value);
              setPreview(null);
              setMoveTo("");
            }}
          />
        </div>
        <span style={{ fontSize: 12.5, color: "var(--ink-2)", paddingBottom: 9 }}>
          = <b>{plural(extraNights, "more night")}</b>
        </span>
        <button
          type="button"
          className={`btn btn-sm ${previewFresh ? "btn-ghost" : "btn-primary"}`}
          disabled={!newDate || extraNights < 1 || previewM.isPending}
          onClick={() => previewM.mutate({})}
        >
          {previewM.isPending && !preview ? "Checking…" : previewFresh ? "Check again" : "Check availability & price"}
        </button>
      </div>
    ),
  };

  const roomsStep: StepItem = !previewFresh
    ? { key: "rooms", label: "Rooms for the extra nights", state: "todo", summary: "after the check — each room is looked up night by night" }
    : {
        key: "rooms",
        label: "Rooms for the extra nights",
        state: roomsSettled ? "done" : "cur",
        summary: roomsSettled
          ? (movesText(preview!.moves, preview!.currentCheckOut) ??
            `${preview!.currentRooms.map((r) => `Room ${r.roomNumber}`).join(", ")} ${preview!.currentRooms.length === 1 ? "stays" : "stay"} on`)
          : "a room is taken — pick where the guest moves",
        body: (
          <>
            <div style={{ display: "grid", gap: 4 }}>
              {preview!.currentRooms.map((r) => (
                <div key={r.roomId} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
                  <b style={{ minWidth: 70 }}>Room {r.roomNumber}</b>
                  <span style={{ color: "var(--ink-3)", minWidth: 110 }}>{r.roomTypeName}</span>
                  {r.perNight.map((n) => (
                    <span key={n.date} className={`tag ${n.status === "FREE" ? "" : "warn"}`} title={n.claimedBy?.guestName ?? n.claimedBy?.bookingRef ?? undefined}>
                      {fmtDay(n.date)} · {n.status === "FREE" ? "free" : n.status.toLowerCase()}
                      {n.claimedBy?.guestName ? ` (${n.claimedBy.guestName})` : ""}
                    </span>
                  ))}
                  {r.extendableInPlace ? (
                    <span style={{ color: "var(--ok)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <Check style={{ width: 12, height: 12 }} /> stays on
                    </span>
                  ) : (
                    <span style={{ color: "var(--warn)" }}>taken — the guest moves out of it on {fmtDay(preview!.currentCheckOut)}</span>
                  )}
                </div>
              ))}
            </div>
            {replacedRoom && (
              <div style={row}>
                <div className="field" style={{ ...fieldTight, minWidth: 300 }}>
                  <label>
                    Move Room {replacedRoom.roomNumber} to, from {fmtDay(preview!.currentCheckOut)}
                  </label>
                  <select
                    value={moveTo}
                    onChange={(e) => {
                      setMoveTo(e.target.value);
                      previewM.mutate({ to: e.target.value });
                    }}
                  >
                    <option value="">— pick a free room —</option>
                    {alternatives.map((c) => (
                      <option key={c.roomId} value={c.roomId}>
                        {c.roomNumber} · {c.roomTypeName}
                        {c.sameType ? " (same type — rate carries)" : " (different type — published rate)"}
                      </option>
                    ))}
                  </select>
                </div>
                {preview!.moves.length > 0 && (
                  <span style={{ fontSize: 12, color: "var(--ink-2)", paddingBottom: 9 }}>
                    {preview!.moves.some((m) => m.crossType)
                      ? "Different type — the extra nights start at its published rate; adjust it in step 3 if needed."
                      : "Same type — the negotiated rate carries to the extra nights."}
                  </span>
                )}
              </div>
            )}
            {preview!.blockedReason && <p style={{ ...hint, color: "var(--warn)" }}>{preview!.blockedReason}</p>}
          </>
        ),
      };

  const pf = preview?.figures ?? null;
  const moneyStep: StepItem = !roomsSettled
    ? { key: "money", label: "Price & the payment to take now", state: "todo", summary: previewFresh ? "once the rooms are settled" : "after the check" }
    : {
        key: "money",
        label: "Price & the payment to take now",
        state: moneySettled ? "done" : "cur",
        summary: moneySettled ? `due now ${money(dueNow ?? 0, currency)}` : "nothing would be due now — ask for a larger share",
        body: (
          <>
            <Ledger
              rows={[
                {
                  key: "stay",
                  label: (
                    <>
                      Stay total <span style={{ color: "var(--ink-3)" }}>(room nights · {plural(extraNights, "night")} added)</span>
                    </>
                  ),
                  value: (
                    <>
                      {preview!.pricing.priorStayTotal != null ? money(preview!.pricing.priorStayTotal, currency) : "—"} → <b>{money(preview!.pricing.projectedStayTotal, currency)}</b>
                      {preview!.pricing.delta != null && (
                        <span style={{ color: "var(--ink-3)" }}>
                          {" "}
                          ({preview!.pricing.delta >= 0 ? "+" : "−"}
                          {money(Math.abs(preview!.pricing.delta), currency)})
                        </span>
                      )}
                    </>
                  ),
                },
                pf && pf.otherChargesSoFar > 0 && { key: "other", label: "Other charges on the folio so far", value: money(pf.otherChargesSoFar, currency) },
                pf && { key: "proj", label: "Projected total at checkout", value: money(pf.projectedTotal, currency), kind: "total" as const },
                {
                  key: "ask",
                  kind: "ask" as const,
                  label: (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      Ask the guest now for
                      <AskInline
                        mode={mode}
                        value={value}
                        onChange={(p) => {
                          if (p.mode) setMode(p.mode);
                          if (p.value !== undefined) setValue(p.value);
                        }}
                      />
                      {mode === "PERCENT" ? "of the projected total" : ""}
                    </span>
                  ),
                  value: pf?.askAmount != null ? money(pf.askAmount, currency) : "—",
                },
                pf && pf.receivedSoFar > 0 && { key: "recv", label: "Already received", value: money(pf.receivedSoFar, currency), kind: "minus" as const },
                { key: "due", label: "Due now", value: money(dueNow ?? 0, currency), kind: "total" as const },
                pf && pf.balanceAtCheckout != null && { key: "bal", label: "Left to pay at checkout", value: money(pf.balanceAtCheckout, currency), kind: "muted" as const },
              ]}
            />
            {(dueNow ?? 0) <= 0 && Number(value) > 0 && (
              <p style={{ ...hint, color: "var(--warn)" }}>What the guest already paid covers this share — raise the ask to bill anything now.</p>
            )}
            {preview!.pricing.discount && <p style={hint}>The booking&rsquo;s {preview!.pricing.discount.effectivePercent}% discount is carried onto the extra nights.</p>}
            <div style={{ ...row, alignItems: "center" }}>
              <button type="button" className={`btn btn-ghost btn-sm${negotiate ? " on" : ""}`} onClick={() => setNegotiate((v) => !v)}>
                {negotiate ? "Hide the rate table" : "Negotiate the extra nights' rates"}
              </button>
              <span style={hint}>Optional · same room keeps its negotiated rate, a different room type starts at its published rate.</span>
            </div>
            {negotiate && extensionRoomIds.length > 0 && (
              <RoomCompositionPlanner
                sealedRoomIds={extensionRoomIds}
                entryCheckIn={entry.checkInDate ?? null}
                entryCheckOut={preview!.newCheckOut}
                entryAdults={entry.adultCount ?? entry.guestCount ?? null}
                entryChildAges={entry.childAges ?? null}
                entryId={entry.id}
                lockCommercial={false}
                initialCompositions={preview!.compositions.filter((c) => extensionRoomIds.includes(c.roomId))}
                onChange={setTableComps}
              />
            )}
          </>
        ),
      };

  const holdHours = preview ? Math.round(preview.holdTtlSeconds / 3600) : null;
  const requestStep: StepItem = {
    key: "request",
    label: "Hold the nights & generate the bill",
    state: moneySettled ? "cur" : "todo",
    summary: moneySettled ? undefined : "after the steps above",
    body: moneySettled ? (
      <>
        <div style={row}>
          <div className="field" style={{ ...fieldTight, flex: 1, minWidth: 240 }}>
            <label>Reason (goes on the audit trail)</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. guest's flight moved to the 28th" />
          </div>
          <button type="button" className="btn btn-primary btn-sm" disabled={!canRequest || requestM.isPending} onClick={() => setConfirmOpen(true)}>
            Hold the nights &amp; generate the bill
          </button>
        </div>
        <p style={hint}>
          {reason.trim().length === 0 ? "Type the reason to continue. " : ""}
          Holds the extra nights for the guest{holdHours ? ` for ${holdHours} h` : ""} and generates the interim bill. Nothing on the booking changes until the bill is paid and
          you commit the extension.
        </p>
      </>
    ) : undefined,
  };

  // ── The open request's checklist ──
  const cd = active && active.state !== "PAID" ? countdownTo(active.holdExpiresAt) : null;
  const activeDueBy = active?.interimPayment?.dueBy ?? null;
  const activeOverdue = !!active && active.state !== "PAID" && !!activeDueBy && new Date(activeDueBy).getTime() < Date.now();
  const heldStep: StepItem | null = active
    ? {
        key: "held",
        label: "Extra nights held for the guest",
        state: "done",
        summary: active.state === "PAID" ? "held until the extension commits" : `until ${fmtWhen(active.holdExpiresAt)} (${cd ? heldLeft(cd) : ""}) — released if unpaid by then`,
      }
    : null;
  const commitStep: StepItem | null = active
    ? active.state === "PAID"
      ? {
          key: "commit",
          label: "Commit the extension",
          state: "cur",
          body: (
            <div style={{ ...row, alignItems: "center" }}>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!isFom || commitM.isPending}
                onClick={() => setCommitOpen(true)}
                title="New segment, re-freeze with the new checkout, back here"
              >
                {commitM.isPending ? "Committing…" : "Commit extension"}
              </button>
              <span style={hint}>{isFom ? "Re-freezes the booking with the new checkout and brings it back to the Stay step. Nothing is sent to the guest." : "Needs FOM (L2+)."}</span>
            </div>
          ),
        }
      : { key: "commit", label: "Commit the extension", state: "todo", summary: "after the payment is in — the booking keeps its current checkout until then" }
    : null;

  return (
    <div className="block">
      <BlockH expanded={expanded} onToggle={() => setExpanded((v) => !v)}>
        <CalendarPlus style={{ width: 13, height: 13 }} />
        Extend the stay
        {active && <span className={EXT_TAG[active.state]?.cls ?? "tag"}>{EXT_TAG[active.state]?.label ?? active.state}</span>}
        {activeOverdue && <span className="tag stop">Payment overdue</span>}
      </BlockH>
      {expanded && (
      <>
      <p style={{ ...hint, fontSize: 12, color: "var(--ink-2)", marginBottom: 8 }}>
        More nights for an in-house guest. Check the rooms, bill the guest for a share of the stay, take that payment, then commit —
        the checkout moves only at the commit. FOM (L2+).
      </p>

      {active ? (
        <div style={{ display: "grid", gap: 8 }}>
          <div className="fact b-transit" style={{ padding: "7px 11px", fontSize: 12.5, width: "100%", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <span>
              Checkout <b>{fmtDay(active.priorCheckOutDate)}</b> → <b>{fmtDay(active.newCheckOutDate)}</b> ({plural(active.extraNights.length, "more night")})
            </span>
            <span>{movesText(active.pricingPreview?.moves, active.priorCheckOutDate) ?? `Same room${active.extraNights.length > 1 ? "s" : ""} — the guest stays put`}</span>
            {active.pricingPreview?.pricing && (
              <span>
                Stay total {money(active.pricingPreview.pricing.priorStayTotal ?? 0, currency)} → <b>{money(active.pricingPreview.pricing.projectedStayTotal, currency)}</b>
              </span>
            )}
            {cd && (
              <span className={`tag ${cd.level}`} title="The extra nights are held for the guest until this runs out unpaid">
                Held · {heldLeft(cd)}
              </span>
            )}
            <span style={{ color: "var(--ink-3)" }}>Reason: {active.reason}</span>
          </div>
          {active.interimPayment ? (
            <InterimRequestPanel
              entryId={entryId}
              request={{ ...(active.interimPayment as unknown as InterimPaymentRow), payments: [] }}
              guestEmail={entry.guestProfile?.email ?? null}
              onChanged={() => onChanged?.()}
              canWithdraw={false}
              leadSteps={heldStep ? [heldStep] : []}
              tailSteps={commitStep ? [commitStep] : []}
            />
          ) : (
            <StepList steps={[heldStep!, commitStep!]} />
          )}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!isFom || withdrawM.isPending}
              onClick={() => withdrawM.mutate()}
              title={isFom ? "Drops the request: the extra nights are released and the bill is superseded" : "Needs FOM (L2+)"}
            >
              Withdraw extension
            </button>
          </div>
          <DeskConfirmModal
            open={commitOpen}
            title="Commit the stay extension"
            subtitle={`Checkout ${fmtDay(active.priorCheckOutDate)} → ${fmtDay(active.newCheckOutDate)}`}
            why="The interim payment is in. Committing runs the governed journey — a new segment, a silent re-quote over the extended stay, a re-freeze with the new checkout — and brings the booking back to the Stay step."
            consequences={[
              "The reservation is re-frozen with the new checkout date (a new immutable record); the extra nights get their night-audit clocks.",
              active.pricingPreview?.moves?.length
                ? `On ${fmtDay(active.priorCheckOutDate)} the guest moves room — execute it that day from the Rooms block (key swap).`
                : "Nobody moves rooms; the current room runs on to the new checkout.",
              "Nothing is sent to the guest — the re-issued voucher states the new dates; the request itself is the guest's answer.",
            ]}
            confirmLabel="Commit extension"
            pending={commitM.isPending}
            onConfirm={() => commitM.mutate()}
            onClose={() => setCommitOpen(false)}
          />
        </div>
      ) : !isFom ? (
        <p style={hint}>Extending a stay needs FOM (L2+).</p>
      ) : entry.currentStage !== "S7" ? (
        <p style={hint}>A stay is extended from the Stay step.</p>
      ) : (
        <>
          <StepList steps={[dateStep, roomsStep, moneyStep, requestStep]} />
          {preview && (
            <DeskConfirmModal
              open={confirmOpen}
              title="Hold the nights & generate the bill"
              subtitle={`Checkout ${fmtDay(preview.currentCheckOut)} → ${fmtDay(preview.newCheckOut)}`}
              why="The extra nights are held for the guest while the bill goes out and the payment comes in. Nothing about the booking changes until you commit — after the money."
              consequences={[
                `The extra nights are claimed for this guest for ${Math.round(preview.holdTtlSeconds / 3600)} hours — other bookings see them as held; they release if unpaid by then.`,
                `An interim invoice for ${money(preview.figures.dueNow ?? 0, currency)} (${preview.figures.askLabel}) is generated — send it, record the answer, log the payment.`,
                "Commit the extension once paid; the booking re-freezes with the new checkout and comes back here.",
              ]}
              confirmLabel="Hold the nights & generate the bill"
              pending={requestM.isPending}
              onConfirm={() => requestM.mutate()}
              onClose={() => setConfirmOpen(false)}
            />
          )}
        </>
      )}

      {history.length > 0 && (
        <div style={{ marginTop: 10, display: "grid", gap: 2 }}>
          <div style={miniHeading}>Earlier extensions</div>
          {history.map((r) => (
            <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, padding: "4px 0", borderTop: "1px dashed var(--line)" }}>
              <span className={EXT_TAG[r.state]?.cls ?? "tag"}>{EXT_TAG[r.state]?.label ?? r.state}</span>
              <span>
                {fmtDay(r.priorCheckOutDate)} → {fmtDay(r.newCheckOutDate)} · {r.reason}
              </span>
              <span style={{ color: "var(--ink-3)", marginLeft: "auto" }}>{(r.committedAt ?? r.closedAt ?? r.requestedAt).slice(0, 10)}</span>
            </div>
          ))}
        </div>
      )}
      </>
      )}
    </div>
  );
}

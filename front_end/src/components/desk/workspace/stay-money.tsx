"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Receipt } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { dispatchInvoice } from "@/lib/api/reservation-setup";
import {
  commitStayExtension,
  createInterimPayment,
  listInterimPayments,
  listStayExtensions,
  previewStayExtension,
  recordInterimPayment,
  requestStayExtension,
  withdrawInterimPayment,
  withdrawStayExtension,
  type InterimFigures,
  type InterimPaymentRow,
  type StayExtensionPreview,
  type StayExtensionRow,
} from "@/lib/api/stay-money";
import { listEntryCommunications } from "@/lib/api/entries";
import { money } from "@/lib/desk/workspace";
import { countdownTo } from "@/lib/desk/timers";
import type { RoomCompositionInput } from "@/lib/api/quotations";
import type { EntryDetail } from "@/types/api";
import { CommunicationAcceptanceBlock } from "./communication-acceptance";
import { DeskConfirmModal } from "./confirm-modal";
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
 * Every figure shown here is read from the API.
 */

const LEVEL_RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };
const fmtDay = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};
const addDaysIso = (iso: string, n: number) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function BlockH({ children }: { children: React.ReactNode }) {
  return (
    <div className="block-h">
      {children}
      <span className="ln" />
    </div>
  );
}

const STATE_TAG: Record<string, { label: string; cls: string }> = {
  SUGGESTED: { label: "Due — set the amount", cls: "tag warn" },
  REQUESTED: { label: "Bill ready to send", cls: "tag" },
  BILLED: { label: "Bill sent — awaiting payment", cls: "tag warn" },
  PAID: { label: "Paid", cls: "tag ok" },
  WITHDRAWN: { label: "Withdrawn", cls: "tag" },
  LAPSED: { label: "Lapsed", cls: "tag" },
  COMMITTED: { label: "Extended", cls: "tag ok" },
};

/** The projected-total facts shared by both blocks. */
function FiguresStrip({ f, currency }: { f: InterimFigures; currency: string }) {
  return (
    <div className="fact b-transit" style={{ padding: "7px 11px", fontSize: 12, width: "100%", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 6 }}>
      <span>
        Nights <b>{f.nightsSlept}</b> slept · <b>{f.nightsToCome}</b> to come
      </span>
      <span>
        Projected total <b>{money(f.projectedTotal, currency)}</b>
        {f.otherChargesSoFar > 0 && <span style={{ color: "var(--ink-3)" }}> (incl. {money(f.otherChargesSoFar, currency)} other charges)</span>}
      </span>
      <span>
        Received so far <b>{money(f.receivedSoFar, currency)}</b>
      </span>
      <span>
        Outstanding now <b>{money(f.outstandingNow, currency)}</b>
      </span>
    </div>
  );
}

/** The ask — % or Nu of the projected total. */
function AskFields({
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
  return (
    <div className="frow" style={{ alignItems: "flex-end", gap: 8 }}>
      <div className="field" style={{ width: 150 }}>
        <label>Ask for</label>
        <input
          inputMode="decimal"
          value={value}
          disabled={disabled}
          placeholder={mode === "PERCENT" ? "e.g. 50" : "e.g. 20000"}
          onChange={(e) => onChange({ value: e.target.value })}
        />
      </div>
      <div className="seg" style={{ alignSelf: "flex-end" }}>
        <button type="button" className={mode === "PERCENT" ? "on" : ""} disabled={disabled} onClick={() => onChange({ mode: "PERCENT" })}>
          % of total
        </button>
        <button type="button" className={mode === "AMOUNT" ? "on" : ""} disabled={disabled} onClick={() => onChange({ mode: "AMOUNT" })}>
          Nu
        </button>
      </div>
    </div>
  );
}

/**
 * One interim request's working row: the bill (view / send), the guest's answer, the money —
 * locked in that order, with the reason shown. Shared by the long-stay block and the
 * extension block (the extension's payment is just an interim request of kind EXTENSION).
 */
function InterimRequestPanel({
  entryId,
  request,
  guestEmail,
  onChanged,
  canWithdraw = true,
}: {
  entryId: string;
  request: InterimPaymentRow;
  guestEmail: string | null;
  onChanged: () => void;
  canWithdraw?: boolean;
}) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const currency = request.figures?.currency ?? "BTN";
  const [previewOpen, setPreviewOpen] = useState(false);
  const [sendTo, setSendTo] = useState(guestEmail ?? "");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("CASH");
  const [amountTouched, setAmountTouched] = useState(false);
  const remaining = Math.max(0, Number(((request.dueNow ?? 0) - request.receivedAgainstAsk).toFixed(2)));
  useEffect(() => {
    if (!amountTouched) setAmount(remaining > 0 ? String(remaining) : "");
  }, [remaining, amountTouched]);

  const commsQuery = useQuery({
    queryKey: ["entry-communications", entryId],
    queryFn: () => listEntryCommunications(session!, entryId),
    enabled: !!session,
  });
  const dispatched = !!request.invoice?.dispatchedAt && request.invoice.state !== "SUPERSEDED";
  const answered = (commsQuery.data?.items ?? []).some(
    (c) => c.commType === "INTERIM_INVOICE" && c.sendStatus === "DISPATCHED" && (c.createdAt ?? "") >= request.requestedAt && c.acknowledgementStatus === "RECEIVED",
  );
  const invalidateAll = () => {
    for (const key of ["interim-payments", "stay-extensions", "entry", "entry-communications", "billing-summary", "entry-timers", "entry-trace", "invoice-preview"]) {
      void queryClient.invalidateQueries({ queryKey: [key, entryId] });
    }
    void queryClient.invalidateQueries({ queryKey: ["invoice-preview", request.invoiceId] });
    onChanged();
  };

  const sendM = useMutation({
    mutationFn: () => dispatchInvoice(session!, request.invoiceId!, { dispatchedTo: sendTo.trim() || undefined }),
    onSuccess: () => {
      toast.success("Interim invoice sent — record the guest's answer, then the money");
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
          : `${money(Number(amount), currency)} received — ${money(out.remaining, currency)} still to come on this ask`,
      );
      setAmountTouched(false);
      invalidateAll();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not record the payment"),
  });
  const withdrawM = useMutation({
    mutationFn: () => withdrawInterimPayment(session!, request.id),
    onSuccess: () => {
      toast.info("Interim request withdrawn — its bill is superseded");
      invalidateAll();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not withdraw"),
  });

  const paid = request.state === "PAID";
  const lockReason = !dispatched
    ? "Send the interim invoice to the guest first — money is taken against the bill they received."
    : !answered
      ? "Record the guest's answer to the interim invoice below first, then log the money."
      : null;

  return (
    <div style={{ border: "1px solid var(--line-2)", borderRadius: "var(--r-sm)", padding: "8px 10px", display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12.5 }}>
        <Receipt style={{ width: 13, height: 13 }} />
        <b>Interim invoice {request.invoiceId ?? ""}</b>
        <span className={STATE_TAG[request.state]?.cls ?? "tag"}>{STATE_TAG[request.state]?.label ?? request.state}</span>
        <span style={{ color: "var(--ink-3)" }}>
          {request.figures?.askLabel ?? (request.askMode === "PERCENT" ? `${request.askValue}% of the projected total` : money(request.askValue ?? 0, currency))}
        </span>
        <span className="ln" />
        <span>
          Due now <b>{money(request.dueNow ?? 0, currency)}</b>
          {request.receivedAgainstAsk > 0 && <span style={{ color: "var(--ink-3)" }}> · received {money(request.receivedAgainstAsk, currency)}</span>}
        </span>
        {request.invoiceId && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPreviewOpen((o) => !o)}>
            {previewOpen ? "Hide" : "View"}
          </button>
        )}
      </div>
      {request.figures && (
        <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
          Projected total {money(request.figures.projectedTotal, currency)} ({request.figures.nightsSlept} nights slept + {request.figures.nightsToCome} to come
          {request.figures.otherChargesSoFar > 0 ? ` + ${money(request.figures.otherChargesSoFar, currency)} other charges` : ""}) · received{" "}
          {money(request.figures.receivedSoFar, currency)} before this ask · balance at checkout after it {money(request.figures.balanceAtCheckout ?? 0, currency)}.
        </p>
      )}
      {previewOpen && request.invoiceId && <ProformaPreview invoiceId={request.invoiceId} title="Interim invoice document" />}

      {!paid && !dispatched && request.invoiceId && (
        <div className="frow" style={{ alignItems: "flex-end", gap: 8 }}>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label>Send to</label>
            <input value={sendTo} onChange={(e) => setSendTo(e.target.value)} placeholder="guest@example.com" />
          </div>
          <div className="field">
            <button type="button" className="btn btn-primary btn-sm" disabled={sendM.isPending} onClick={() => sendM.mutate()}>
              {sendM.isPending ? "Sending…" : "Send interim invoice"}
            </button>
          </div>
          {canWithdraw && (
            <div className="field">
              <button type="button" className="btn btn-ghost btn-sm" disabled={withdrawM.isPending} onClick={() => withdrawM.mutate()}>
                Withdraw
              </button>
            </div>
          )}
        </div>
      )}

      {dispatched && !paid && (
        <CommunicationAcceptanceBlock entryId={entryId} commType="INTERIM_INVOICE" title="Guest's answer to the interim invoice" sinceIso={request.requestedAt} />
      )}

      {!paid && (
        <div
          style={{ opacity: lockReason ? 0.6 : 1 }}
          title={lockReason ?? undefined}
          onClick={() => lockReason && toast.info(lockReason)}
        >
          <div className="frow" style={{ alignItems: "flex-end", gap: 8 }}>
            <div className="field" style={{ width: 150 }}>
              <label>Amount received</label>
              <input
                inputMode="decimal"
                value={amount}
                disabled={!!lockReason}
                onChange={(e) => {
                  setAmountTouched(true);
                  setAmount(e.target.value);
                }}
              />
            </div>
            <div className="field" style={{ width: 130 }}>
              <label>Method</label>
              <select value={method} disabled={!!lockReason} onChange={(e) => setMethod(e.target.value)}>
                <option value="CASH">Cash</option>
                <option value="CARD">Card</option>
                <option value="BANK_TRANSFER">Bank transfer</option>
                <option value="MBOB">mBoB</option>
              </select>
            </div>
            <div className="field">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!!lockReason || payM.isPending || !(Number(amount) > 0)}
                onClick={() => payM.mutate()}
              >
                {payM.isPending ? "Recording…" : "Log payment received"}
              </button>
            </div>
            {canWithdraw && dispatched && (
              <div className="field">
                <button type="button" className="btn btn-ghost btn-sm" disabled={withdrawM.isPending} onClick={() => withdrawM.mutate()}>
                  Withdraw
                </button>
              </div>
            )}
          </div>
          {lockReason && <p style={{ fontSize: 11.5, color: "var(--warn)", margin: "4px 0 0" }}>{lockReason}</p>}
        </div>
      )}
      {paid && (
        <p style={{ fontSize: 11.5, color: "var(--ok)", margin: 0 }}>
          Paid in full{request.paidAt ? ` on ${request.paidAt.slice(0, 16).replace("T", " ")}` : ""} ·{" "}
          {request.payments.length} payment{request.payments.length === 1 ? "" : "s"}.
        </p>
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
  const history = requests.filter((r) => r !== open && r.state !== "SUGGESTED");
  const [mode, setMode] = useState<"PERCENT" | "AMOUNT">("PERCENT");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");

  const createM = useMutation({
    mutationFn: () => createInterimPayment(session!, entryId, { askMode: mode, askValue: Number(value), note: note.trim() || undefined }),
    onSuccess: (out) => {
      toast.success(`Interim invoice ${out.invoice.id} generated for ${money(out.request.dueNow ?? 0, currency)} — send it to the guest`);
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
      <BlockH>
        <Receipt style={{ width: 13, height: 13 }} />
        Interim payment
        {suggested && <span className="tag warn">Due</span>}
      </BlockH>
      <p style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 0, lineHeight: 1.5 }}>
        A part payment during a long stay. Ask for a share of the <b>projected total</b> — nights slept and to come
        plus every charge already on the folio — as a percentage or a figure; the bill goes out, the guest answers,
        then the money is logged. The night audit raises a prompt here every few nights on its own.
      </p>
      {figures && <FiguresStrip f={figures} currency={currency} />}
      {suggested && open && (
        <div className="fact" style={{ padding: "7px 11px", fontSize: 12, width: "100%", marginTop: 8, border: "1px solid var(--warn)", background: "var(--warn-t)" }}>
          <b>Interim payment due</b> — raised by the night audit after {open.nightsSleptAtPrompt ?? "several"} night
          {(open.nightsSleptAtPrompt ?? 2) === 1 ? "" : "s"}. Put a figure on it below to generate the bill.
        </div>
      )}
      {openExtension && (
        <p className="fact b-transit" style={{ padding: "7px 11px", fontSize: 12, width: "100%", marginTop: 8 }}>
          A stay extension is in progress with its own interim bill — see <b>Extend the stay</b> below.
        </p>
      )}
      {showAskForm && inHouse && !openExtension && (
        <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
          <AskFields mode={mode} value={value} onChange={(p) => { if (p.mode) setMode(p.mode); if (p.value !== undefined) setValue(p.value); }} disabled={createM.isPending} />
          <div className="frow" style={{ alignItems: "flex-end", gap: 8 }}>
            <div className="field" style={{ flex: 1, minWidth: 200 }}>
              <label>Note (optional)</label>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. week-1 payment as agreed" />
            </div>
            <div className="field">
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
          </div>
        </div>
      )}
      {open && !suggested && (
        <div style={{ marginTop: 8 }}>
          <InterimRequestPanel entryId={entryId} request={open} guestEmail={entry.guestProfile?.email ?? null} onChanged={() => onChanged?.()} />
        </div>
      )}
      {history.length > 0 && (
        <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
          {history.map((r) => (
            <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, padding: "4px 0", borderTop: "1px dashed var(--line)" }}>
              <span className={STATE_TAG[r.state]?.cls ?? "tag"}>{STATE_TAG[r.state]?.label ?? r.state}</span>
              <span>
                {r.kind === "EXTENSION" ? "Extension" : "Interim"} · {r.figures?.askLabel ?? ""} · due {money(r.dueNow ?? 0, currency)}
                {r.state === "PAID" ? ` · received ${money(r.receivedAgainstAsk, currency)}` : ""}
              </span>
              <span style={{ color: "var(--ink-3)", marginLeft: "auto" }}>{r.requestedAt.slice(0, 10)}</span>
            </div>
          ))}
        </div>
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

  const perNightFor = (to: string) => (preview && to ? preview.extraNights.map((date) => ({ date, roomId: to })) : undefined);
  const previewM = useMutation({
    mutationFn: (args: { to?: string; comps?: RoomCompositionInput[] }) =>
      previewStayExtension(session!, entryId, {
        newCheckOutDate: newDate,
        perNight: perNightFor(args.to ?? moveTo),
        roomCompositions: args.comps?.length ? args.comps : undefined,
        askMode: mode,
        askValue: Number(value) > 0 ? Number(value) : undefined,
      }),
    onSuccess: (p) => setPreview(p),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not check the extension"),
  });
  // Re-project when the ask changes (debounced), once a preview exists.
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
        roomCompositions: negotiate && tableComps.length ? tableComps : undefined,
        reason: reason.trim(),
        askMode: mode,
        askValue: Number(value),
      }),
    onSuccess: (out) => {
      toast.success(
        `Extension to ${fmtDay(out.request.newCheckOutDate)} requested — the extra nights are held until ${out.request.holdExpiresAt.slice(0, 16).replace("T", " ")}. Send the interim invoice (${money(out.interim.dueNow ?? 0, out.preview.currency)}), record the answer, take the payment, then commit.`,
        { duration: 14000 },
      );
      setConfirmOpen(false);
      setPreview(null);
      setReason("");
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
        const delta = o.pricing.delta != null && Math.abs(o.pricing.delta) >= 0.01 ? ` · stay total now ${money(o.pricing.newTotal, o.pricing.currency ?? "BTN")} (${o.pricing.delta > 0 ? "+" : "−"}${money(Math.abs(o.pricing.delta), o.pricing.currency ?? "BTN")})` : "";
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
  const canRequest = !!preview && !preview.blockedReason && reason.trim().length > 0 && Number(value) > 0 && (preview.figures.dueNow ?? 0) > 0;

  return (
    <div className="block">
      <BlockH>
        <CalendarPlus style={{ width: 13, height: 13 }} />
        Extend the stay
        {active && <span className={STATE_TAG[active.state]?.cls ?? "tag"}>{STATE_TAG[active.state]?.label ?? active.state}</span>}
      </BlockH>
      <p style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 0, lineHeight: 1.5 }}>
        The guest wants more nights. The room is checked for the extra nights (a taken room becomes a move from the
        current checkout), the stay is re-projected, an interim bill goes out for the share you ask, and the extension{" "}
        <b>commits only once that payment is in</b> — then the booking re-freezes with the new checkout and comes back here.
        FOM authority.
      </p>

      {active ? (
        <div style={{ display: "grid", gap: 8 }}>
          <div className="fact b-transit" style={{ padding: "7px 11px", fontSize: 12.5, width: "100%", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <span>
              Checkout <b>{fmtDay(active.priorCheckOutDate)}</b> → <b>{fmtDay(active.newCheckOutDate)}</b> ({active.extraNights.length} more night
              {active.extraNights.length === 1 ? "" : "s"})
            </span>
            {active.pricingPreview?.moves?.length ? (
              <span>
                From {fmtDay(active.priorCheckOutDate)}: {active.pricingPreview.moves.map((m) => `Room ${m.fromRoomNumber} → ${m.toRoomNumber}${m.crossType ? " (different type)" : ""}`).join(", ")}
              </span>
            ) : (
              <span>Same room{active.extraNights.length > 1 ? "s" : ""}</span>
            )}
            {active.pricingPreview?.pricing && (
              <span>
                Stay total {money(active.pricingPreview.pricing.priorStayTotal ?? 0, currency)} → <b>{money(active.pricingPreview.pricing.projectedStayTotal, currency)}</b>
              </span>
            )}
            {active.state !== "PAID" && (
              <span className={`tag ${countdownTo(active.holdExpiresAt).level}`} title="The extra nights are held for the guest until this runs out unpaid">
                Held {countdownTo(active.holdExpiresAt).text}
              </span>
            )}
            <span style={{ color: "var(--ink-3)" }}>Reason: {active.reason}</span>
          </div>
          {active.interimPayment && (
            <InterimRequestPanel
              entryId={entryId}
              request={{ ...(active.interimPayment as unknown as InterimPaymentRow), payments: [] }}
              guestEmail={entry.guestProfile?.email ?? null}
              onChanged={() => onChanged?.()}
              canWithdraw={false}
            />
          )}
          <div className="frow" style={{ gap: 8, alignItems: "center" }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!isFom || active.state !== "PAID" || commitM.isPending}
              onClick={() => setCommitOpen(true)}
              title={active.state !== "PAID" ? "Take the interim payment first — the extension commits only once it is in" : "Commit: new segment, re-freeze with the new checkout, back here"}
            >
              {commitM.isPending ? "Committing…" : "Commit extension"}
            </button>
            {active.state !== "PAID" && <span style={{ fontSize: 11.5, color: "var(--warn)" }}>Locked until the interim payment is recorded.</span>}
            <span className="ln" />
            <button type="button" className="btn btn-ghost btn-sm" disabled={!isFom || withdrawM.isPending} onClick={() => withdrawM.mutate()}>
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
        <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: 0 }}>Extending a stay needs FOM (L2+).</p>
      ) : entry.currentStage !== "S7" ? (
        <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: 0 }}>A stay is extended from the Stay step.</p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          <div className="frow" style={{ alignItems: "flex-end", gap: 8 }}>
            <div className="field">
              <label>New checkout (currently {fmtDay(currentCheckOut)})</label>
              <input type="date" value={newDate} min={currentCheckOut ? addDaysIso(currentCheckOut, 1) : undefined} onChange={(e) => { setNewDate(e.target.value); setPreview(null); setMoveTo(""); }} />
            </div>
            <div className="field">
              <button type="button" className="btn btn-ghost btn-sm" disabled={!newDate || previewM.isPending} onClick={() => previewM.mutate({})}>
                {previewM.isPending && !preview ? "Checking…" : "Check availability & price"}
              </button>
            </div>
          </div>
          {preview && (
            <>
              <div style={{ display: "grid", gap: 4 }}>
                {preview.currentRooms.map((r) => (
                  <div key={r.roomId} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
                    <b>Room {r.roomNumber}</b>
                    <span style={{ color: "var(--ink-3)" }}>{r.roomTypeName}</span>
                    {r.perNight.map((n) => (
                      <span key={n.date} className={`tag ${n.status === "FREE" ? "ok" : "warn"}`} title={n.claimedBy?.guestName ?? n.claimedBy?.bookingRef ?? undefined}>
                        {fmtDay(n.date)} · {n.status === "FREE" ? "free" : n.status.toLowerCase()}
                        {n.claimedBy?.guestName ? ` (${n.claimedBy.guestName})` : ""}
                      </span>
                    ))}
                    {r.extendableInPlace ? <span style={{ color: "var(--ok)" }}>can stay on</span> : <span style={{ color: "var(--warn)" }}>taken — move from {fmtDay(preview.currentCheckOut)}</span>}
                  </div>
                ))}
              </div>
              {replacedRoom && (
                <div className="frow" style={{ alignItems: "flex-end", gap: 8 }}>
                  <div className="field" style={{ minWidth: 260 }}>
                    <label>From {fmtDay(preview.currentCheckOut)}, move Room {replacedRoom.roomNumber} to</label>
                    <select value={moveTo} onChange={(e) => { setMoveTo(e.target.value); previewM.mutate({ to: e.target.value }); }}>
                      <option value="">— pick a free room —</option>
                      {alternatives.map((c) => (
                        <option key={c.roomId} value={c.roomId}>
                          {c.roomNumber} · {c.roomTypeName}{c.sameType ? "" : " (different type — published rate)"}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
              {preview.blockedReason && <p style={{ fontSize: 12, color: "var(--warn)", margin: 0 }}>{preview.blockedReason}</p>}
              {preview.moves.length > 0 && (
                <p className="fact b-transit" style={{ padding: "7px 11px", fontSize: 12, width: "100%" }}>
                  {preview.moves.map((m) => `Room ${m.fromRoomNumber} → ${m.toRoomNumber}${m.crossType ? " (different type: starts at its published rate — negotiate below if needed)" : " (same type: the negotiated rate carries)"}`).join(" · ")}
                </p>
              )}
              <div className="fact b-transit" style={{ padding: "7px 11px", fontSize: 12.5, width: "100%", display: "flex", gap: 12, flexWrap: "wrap" }}>
                <span>
                  Stay total {preview.pricing.priorStayTotal != null ? money(preview.pricing.priorStayTotal, currency) : "—"} → <b>{money(preview.pricing.projectedStayTotal, currency)}</b>
                  {preview.pricing.delta != null && ` (${preview.pricing.delta >= 0 ? "+" : "−"}${money(Math.abs(preview.pricing.delta), currency)})`}
                </span>
                {preview.pricing.discount && <span style={{ color: "var(--ink-3)" }}>discount {preview.pricing.discount.effectivePercent}% carried</span>}
              </div>
              <FiguresStrip f={preview.figures} currency={currency} />
              <AskFields mode={mode} value={value} onChange={(p) => { if (p.mode) setMode(p.mode); if (p.value !== undefined) setValue(p.value); }} />
              {preview.figures.dueNow != null && (
                <p style={{ fontSize: 12, margin: 0 }}>
                  Ask {preview.figures.askLabel} = <b>{money(preview.figures.askAmount ?? 0, currency)}</b> · already received {money(preview.figures.receivedSoFar, currency)} →{" "}
                  <b>due now {money(preview.figures.dueNow, currency)}</b> · balance at checkout {money(preview.figures.balanceAtCheckout ?? 0, currency)}
                </p>
              )}
              <label className="checkline" style={{ cursor: "pointer" }}>
                <input type="checkbox" checked={negotiate} onChange={(e) => setNegotiate(e.target.checked)} /> Negotiate the extension&rsquo;s rates (the S2 table)
              </label>
              {negotiate && extensionRoomIds.length > 0 && (
                <RoomCompositionPlanner
                  sealedRoomIds={extensionRoomIds}
                  entryCheckIn={entry.checkInDate ?? null}
                  entryCheckOut={preview.newCheckOut}
                  entryAdults={entry.adultCount ?? entry.guestCount ?? null}
                  entryChildAges={entry.childAges ?? null}
                  entryId={entry.id}
                  lockCommercial={false}
                  initialCompositions={preview.compositions.filter((c) => extensionRoomIds.includes(c.roomId))}
                  onChange={setTableComps}
                />
              )}
              <div className="frow" style={{ alignItems: "flex-end", gap: 8 }}>
                <div className="field" style={{ flex: 1, minWidth: 220 }}>
                  <label>Reason (recorded on the audit trail)</label>
                  <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. guest's flight moved to the 28th" />
                </div>
                <div className="field">
                  <button type="button" className="btn btn-primary btn-sm" disabled={!canRequest || requestM.isPending} onClick={() => setConfirmOpen(true)}>
                    Request extension
                  </button>
                </div>
              </div>
              <DeskConfirmModal
                open={confirmOpen}
                title="Request the stay extension"
                subtitle={`Checkout ${fmtDay(preview.currentCheckOut)} → ${fmtDay(preview.newCheckOut)}`}
                why="The extra nights are held for the guest while the interim bill goes out and the payment comes in. Nothing about the booking changes until you commit — after the money."
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
            </>
          )}
        </div>
      )}

      {history.length > 0 && (
        <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
          {history.map((r) => (
            <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, padding: "4px 0", borderTop: "1px dashed var(--line)" }}>
              <span className={STATE_TAG[r.state]?.cls ?? "tag"}>{STATE_TAG[r.state]?.label ?? r.state}</span>
              <span>
                {fmtDay(r.priorCheckOutDate)} → {fmtDay(r.newCheckOutDate)} · {r.reason}
              </span>
              <span style={{ color: "var(--ink-3)", marginLeft: "auto" }}>{(r.committedAt ?? r.closedAt ?? r.requestedAt).slice(0, 10)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

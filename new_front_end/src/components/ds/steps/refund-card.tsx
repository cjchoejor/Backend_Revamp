"use client";

/**
 * Money paid above the bill, and giving it back (2026-09-18; by payer since 2026-11-26).
 *
 * The bill's balance floors at zero, so a guest who prepaid the stay and left on the first day
 * read "received 4,851 · still owed 0" — and nothing said the hotel held 2,425.50 of theirs. Since
 * a charge can be corrected after the bill is settled (2026-11-26), one payer can be paid over
 * while another is not: the guest's dinner corrected down leaves the guest Nu 1,039.50 over, the
 * agency's share untouched. So each payer's money above their own share is its own line, and the
 * refund is recorded from that share (`billingModel` on the refund). Figures are the backend's
 * (`billing-summary` → `folio.overpaidByPayer`, `folio.overpaid`); recording is the FOM's.
 */
import { BankFields, useBankEntry } from "@/components/ds/bank-fields";
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { recordFolioRefund } from "@/lib/api/checkout";
import { money } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { DsDialog, Live, StepCard, atLeast, toastRefusal, useRefreshEntry } from "./kit";
import { useBilling, useBookedBy } from "./s8-parts";

const REFUND_METHODS = [
  ["CASH", "Cash"],
  ["CARD", "Back to the card (POS)"],
  ["MOBILE_PAYMENT", "Mobile payment (QR)"],
  ["BANK_TRANSFER", "Bank transfer"],
  ["INWARD_REMITTANCE", "Inward remittance"],
] as const;
type RefundMethod = (typeof REFUND_METHODS)[number][0];
const isMethod = (m: string | null | undefined): m is RefundMethod => REFUND_METHODS.some(([v]) => v === m);

/** Whom the money goes back to, how much at most, and how it came in. */
export type RefundTarget = {
  /** The payer's share — null for the bill as a whole (an older bill with one payer). */
  billingModel: string | null;
  amount: number;
  payerName: string;
  wayItCame?: string | null;
  /** The reason filled in (the correction's own words). */
  why?: string;
};

/** Record a refund to one payer, in a pop-up. Used by the card below and by a correction after settlement. */
export function RefundDialog({
  entry,
  open,
  onClose,
  target,
  lead,
}: {
  entry: EntryDetail;
  open: boolean;
  onClose: () => void;
  target: RefundTarget | null;
  /** A line above the fields — what just happened. */
  lead?: React.ReactNode;
}) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const billing = useBilling(entry);
  const cur = billing.data?.currency ?? "BTN";
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<RefundMethod>("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [why, setWhy] = useState("");
  const bank = useBankEntry();
  useEffect(() => {
    if (!open || !target) return;
    setAmount(String(target.amount));
    setMethod(isMethod(target.wayItCame) ? target.wayItCame : "BANK_TRANSFER");
    setReference("");
    setWhy(target.why ?? "");
  }, [open, target]);

  const run = useMutation({
    mutationFn: () =>
      recordFolioRefund(session!, entry.folio!.id, {
        amount: Number(amount),
        paymentMethod: method,
        reference: bank.needs(method) ? undefined : reference.trim() || undefined,
        reason: why.trim(),
        ...(target?.billingModel ? { billingModel: target.billingModel } : {}),
        ...bank.body(method),
      }),
    onSuccess: () => {
      toast.success(`${money(Number(amount), cur)} refunded to ${target?.payerName ?? "the guest"} — recorded against the bill`);
      onClose();
      refresh([["billing-summary"], ["refunds-made"]]);
    },
    onError: (e) => toastRefusal(e, "The refund could not be recorded"),
  });

  if (!target) return null;
  const n = Number.parseFloat(amount);
  const amountOk = amount.trim() !== "" && Number.isFinite(n) && n > 0 && n <= target.amount + 0.004;
  const lock = !amountOk ? `put in up to ${money(target.amount, cur)}` : !why.trim() ? "say why the money goes back" : (bank.missing(method) ?? undefined);
  const way = REFUND_METHODS.find(([v]) => v === target.wayItCame)?.[1];

  return (
    <DsDialog
      open={open}
      onClose={onClose}
      title={`Record the refund to ${target.payerName}`}
      caseLines={[entry.id, `${money(target.amount, cur)} paid above ${target.billingModel ? "their share" : "the bill"}`]}
      busy={run.isPending}
      footer={
        <>
          <Button kind="quiet" state={run.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button className={lock ? undefined : "go"} state={run.isPending ? "working" : lock ? "inert" : "default"} reason={lock} workingLabel="Recording…" onClick={() => run.mutate()}>
            Record the refund
          </Button>
        </>
      }
    >
      {lead ? <div style={{ marginBottom: 10 }}>{lead}</div> : null}
      <div className="form2">
        <div className="field">
          <label>Refunded · Nu.</label>
          <input className="input money" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <span className="hint">up to {money(target.amount, cur)}</span>
        </div>
        <div className="field">
          <label>How it went back</label>
          <select className="input" value={method} onChange={(e) => setMethod(e.target.value as RefundMethod)}>
            {REFUND_METHODS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          {way ? <span className="hint">it came in by {way.toLowerCase()}</span> : null}
        </div>
        {bank.needs(method) ? null : (
          <div className="field">
            <label>Reference · optional</label>
            <input className="input" value={reference} placeholder="the slip reference" onChange={(e) => setReference(e.target.value)} />
          </div>
        )}
        <div className="wide">
          <BankFields entry={bank} method={method} what="refund" />
        </div>
        <div className="wide field">
          <label>Why</label>
          <input className="input" value={why} placeholder="left on the first day — the prepaid second night" onChange={(e) => setWhy(e.target.value)} />
        </div>
      </div>
    </DsDialog>
  );
}

export function OverpaidCard({ entry, live }: { entry: EntryDetail; live: boolean }) {
  const { session } = useSession();
  const billing = useBilling(entry);
  const booked = useBookedBy(entry);
  const fom = atLeast(session?.actorLevel, "L2");
  const overpaid = billing.data?.folio?.overpaid ?? null;
  const byPayer = billing.data?.folio?.overpaidByPayer ?? [];
  const cur = billing.data?.currency ?? "BTN";
  const [target, setTarget] = useState<RefundTarget | null>(null);

  const payerName = (billingModel: string) => (billingModel === "GUEST_PAY" ? "the guest" : (booked.party ?? "the account"));
  // Each payer above their own share; an older bill with one payer reads as the bill as a whole.
  const rows: RefundTarget[] = byPayer.length
    ? byPayer.map((p) => ({ billingModel: p.billingModel, amount: p.amount, payerName: payerName(p.billingModel), wayItCame: p.wayItCame }))
    : overpaid != null && overpaid > 0
      ? [{ billingModel: null, amount: overpaid, payerName: "the guest" }]
      : [];
  if (!entry.folio || rows.length === 0) return null;

  return (
    <StepCard title="Paid above the bill" icon="alert" meta="The balance cannot go below zero, so this is the only place it shows.">
      {rows.map((r) => (
        <div key={r.billingModel ?? "all"} className="row-acts" style={{ marginTop: 6 }} data-paid-over={r.billingModel ?? "ALL"}>
          <span className="sm" style={{ flex: 1 }}>
            {r.payerName === "the guest" ? "The guest" : r.payerName} paid <b className="money">{money(r.amount, cur)}</b> more than {r.billingModel ? "their share" : "the bill"}. It is
            theirs — give it back, and record how it went.
          </span>
          <Live>
            <Button kind="secondary" state={fom && live ? "default" : "inert"} unlockRole={fom ? undefined : "FOM"} onClick={() => setTarget(r)}>
              Record the refund
            </Button>
          </Live>
        </div>
      ))}
      <RefundDialog entry={entry} open={!!target} onClose={() => setTarget(null)} target={target} />
    </StepCard>
  );
}

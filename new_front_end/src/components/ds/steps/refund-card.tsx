"use client";

/**
 * Money paid above the bill, and giving it back (2026-09-18).
 *
 * The bill's balance floors at zero, so a guest who prepaid the stay and left on the first day
 * read "received 4,851 · still owed 0" — and nothing said the hotel held 2,425.50 of theirs. The
 * figure is the backend's (`billing-summary` → `folio.overpaid`); recording the refund is the
 * FOM's, never more than was overpaid. Refunds are not made automatically — the desk records one
 * it has made.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { recordFolioRefund } from "@/lib/api/checkout";
import { money } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { DsDialog, Live, StepCard, atLeast, toastRefusal, useRefreshEntry } from "./kit";
import { useBilling } from "./s8-parts";

const REFUND_METHODS = [
  ["CASH", "Cash"],
  ["CARD", "Back to the card (POS)"],
  ["MOBILE_PAYMENT", "Mobile payment (QR)"],
  ["BANK_TRANSFER", "Bank transfer"],
] as const;

export function OverpaidCard({ entry, live }: { entry: EntryDetail; live: boolean }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const billing = useBilling(entry);
  const fom = atLeast(session?.actorLevel, "L2");
  const overpaid = billing.data?.folio?.overpaid ?? null;
  const cur = billing.data?.currency ?? "BTN";
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<(typeof REFUND_METHODS)[number][0]>("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [why, setWhy] = useState("");

  const run = useMutation({
    mutationFn: () =>
      recordFolioRefund(session!, entry.folio!.id, {
        amount: Number(amount),
        paymentMethod: method,
        reference: reference.trim() || undefined,
        reason: why.trim(),
      }),
    onSuccess: () => {
      toast.success(`${money(Number(amount), cur)} refunded — recorded against the bill`);
      setOpen(false);
      refresh([["billing-summary"]]);
    },
    onError: (e) => toastRefusal(e, "The refund could not be recorded"),
  });

  if (!entry.folio || overpaid == null || overpaid <= 0) return null;
  const n = Number.parseFloat(amount);
  const amountOk = amount.trim() !== "" && Number.isFinite(n) && n > 0 && n <= overpaid;
  const lock = !amountOk ? `put in up to ${money(overpaid, cur)}` : !why.trim() ? "say why the money goes back" : undefined;

  return (
    <StepCard title="Paid above the bill" icon="alert" meta="The balance cannot go below zero, so this is the only place it shows.">
      <p className="sm" style={{ margin: 0 }}>
        The guest has paid <b className="money">{money(overpaid, cur)}</b> more than the bill. It is theirs — give it back, and record how it went.
      </p>
      <Live>
        <div className="row-acts" style={{ marginTop: 10 }}>
          <Button
            kind="secondary"
            state={fom ? "default" : "inert"}
            unlockRole={fom ? undefined : "FOM"}
            onClick={() => {
              setAmount(String(overpaid));
              setReference("");
              setWhy("");
              setOpen(true);
            }}
          >
            Record the refund…
          </Button>
        </div>
      </Live>
      <DsDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Record the refund"
        caseLines={[entry.id, `${money(overpaid, cur)} paid above the bill`]}
        busy={run.isPending}
        footer={
          <>
            <Button kind="quiet" state={run.isPending ? "inert" : "default"} onClick={() => setOpen(false)}>
              Not now
            </Button>
            <Button state={run.isPending ? "working" : lock ? "inert" : "default"} reason={lock} workingLabel="Recording…" onClick={() => run.mutate()}>
              Record the refund
            </Button>
          </>
        }
      >
        <div className="form2">
          <div className="field">
            <label>Refunded · Nu.</label>
            <input className="input money" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <span className="hint">up to {money(overpaid, cur)}</span>
          </div>
          <div className="field">
            <label>How it went back</label>
            <select className="input" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
              {REFUND_METHODS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Reference · optional</label>
            <input className="input" value={reference} placeholder="the transfer or slip reference" onChange={(e) => setReference(e.target.value)} />
          </div>
          <div className="wide field">
            <label>Why</label>
            <input className="input" value={why} placeholder="left on the first day — the prepaid second night" onChange={(e) => setWhy(e.target.value)} />
          </div>
        </div>
      </DsDialog>
    </StepCard>
  );
}

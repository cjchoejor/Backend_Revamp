"use client";

/**
 * Step 8 · settling the bill payer by payer (2026-09-18).
 *
 * A booking an agency or a company made splits its folio by payer: the stay as sold — the room,
 * the meal plan — belongs to the agency's package or the company's account, and what the guest
 * orders at the desk belongs to the guest (the folio's per-line billing model). One settlement
 * for the whole bill put the guest's extras on the agency's invoice, or the package on the
 * guest's cash. When more than one payer still owes, the desk settles each share on its own —
 * the backend's bucket-scoped settlement — and the rooms are released when the last share at the
 * desk is settled. Every figure is the backend's (`GET /folios/:id/settlement-buckets`).
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip, Refusal } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import { initiateSettlement, listSettlementBuckets, type SettlementBucket } from "@/lib/api/checkout";
import { money } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { DsDialog, Live, atLeast, toastRefusal, useRefreshEntry, words } from "./kit";
import { SendToField, useBookedBy, useSendTo } from "./s8-parts";

export const SETTLE_METHODS = [
  ["CASH", "Cash"],
  ["MOBILE_PAYMENT", "Mobile payment (QR)"],
  ["BANK_TRANSFER", "Bank transfer"],
  ["DIRECT_BILL", "Charge to the company (direct bill)"],
  ["VOUCHER", "The agent's voucher"],
] as const;
export type SettleMethod = (typeof SETTLE_METHODS)[number][0];

/**
 * The ways of settling a billing model allows (2026-09-18). The backend refuses anything but a
 * direct bill on a direct-bill folio; a voucher needs an agency that issued it; a direct bill a
 * company or agency to invoice (a government stay is invoiced the same way).
 */
export function settleMethodsFor(model: string | null, agentBooked: boolean, partyBooked: boolean) {
  if (model === "DIRECT_BILL") return SETTLE_METHODS.filter(([v]) => v === "DIRECT_BILL");
  return SETTLE_METHODS.filter(([v]) =>
    v === "VOUCHER" ? agentBooked || model === "TOUR_OPERATOR_VOUCHER" : v === "DIRECT_BILL" ? partyBooked || model === "GOVERNMENT" : true,
  );
}

/** What "How they pay" starts at — the billing model's own way, not cash at the desk. */
export function defaultSettleMethod(model: string | null): SettleMethod {
  if (model === "DIRECT_BILL" || model === "GOVERNMENT") return "DIRECT_BILL";
  if (model === "TOUR_OPERATOR_VOUCHER") return "VOUCHER";
  return "CASH";
}

/** The ways ONE payer's share can be settled: the guest's own share is money at the desk. */
function shareMethods(model: string) {
  if (model === "GUEST_PAY") return SETTLE_METHODS.filter(([v]) => v !== "DIRECT_BILL" && v !== "VOUCHER");
  if (model === "DIRECT_BILL") return SETTLE_METHODS.filter(([v]) => v === "DIRECT_BILL");
  if (model === "TOUR_OPERATOR_VOUCHER") return SETTLE_METHODS;
  return SETTLE_METHODS.filter(([v]) => v !== "VOUCHER");
}

export function useSettlementShares(entry: EntryDetail, enabled: boolean) {
  const { session } = useSession();
  const folioId = entry.folio?.id ?? null;
  return useQuery({
    queryKey: ["settlement-buckets", folioId, entry.updatedAt],
    queryFn: () => listSettlementBuckets(session!, folioId!),
    enabled: !!session && !!folioId && enabled,
  });
}

/**
 * The shares to settle one by one — or null when the bill settles in one go. Payer by payer when
 * two payers still owe at the desk, or when one has settled and another is still open (the bill
 * then reads OUTSTANDING, which the single form treats as settled).
 */
export function sharesToSettle(buckets: SettlementBucket[] | undefined, folioState: string | null | undefined): SettlementBucket[] | null {
  const shares = buckets ?? [];
  if (shares.length < 2) return null;
  const open = shares.filter((b) => b.outstanding > 0 && !b.invoiceId);
  if (open.length === 0) return null;
  if (open.length > 1 || folioState === "OUTSTANDING") return shares;
  return null;
}

function shareTitle(model: string, booked: ReturnType<typeof useBookedBy>) {
  if (model === "GUEST_PAY") return `The guest's own charges · ${booked.guest}`;
  if (model === "TOUR_OPERATOR_VOUCHER") return `The package · ${booked.party ?? "the agency"}`;
  if (model === "DIRECT_BILL") return `The account · ${booked.party ?? "the company"}`;
  if (model === "GOVERNMENT") return "The government's account";
  return words(model);
}

export function PayerShares({ entry, shares, live, currency }: { entry: EntryDetail; shares: SettlementBucket[]; live: boolean; currency: string }) {
  const booked = useBookedBy(entry);
  return (
    <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
      <p className="sm" style={{ margin: 0 }}>
        This bill has more than one payer. Each settles their own share — the guest their own charges at the desk,{" "}
        {booked.party ?? "the account"} the stay it booked. The rooms are released when the last share is settled; what a share leaves owing is collected
        after the stay.
      </p>
      {shares.map((s) => (
        <ShareRow key={s.billingModel} entry={entry} share={s} live={live} currency={currency} />
      ))}
    </div>
  );
}

function ShareRow({ entry, share, live, currency }: { entry: EntryDetail; share: SettlementBucket; live: boolean; currency: string }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const booked = useBookedBy(entry);
  const fom = atLeast(session?.actorLevel, "L2");
  const pay = usePaymentStatus(entry.id, { enabled: !!entry.folio });
  const ps = pay.data;
  const folio = entry.folio ?? null;
  const title = shareTitle(share.billingModel, booked);
  const payer = share.billingModel === "GUEST_PAY" ? booked.guest : booked.party ?? booked.payer;
  const methods = shareMethods(share.billingModel);
  const owes = share.outstanding;

  const [method, setMethod] = useState<SettleMethod>(defaultSettleMethod(share.billingModel));
  const [ref, setRef] = useState("");
  const [paidNow, setPaidNow] = useState("");
  const paidTouched = useRef(false);
  const [voucherCovers, setVoucherCovers] = useState("");
  const voucherTouched = useRef(false);
  useEffect(() => {
    if (owes <= 0) return;
    if (!paidTouched.current) setPaidNow(String(owes));
    if (!voucherTouched.current) setVoucherCovers(String(owes));
  }, [owes]);
  const [invoiceTo, setInvoiceTo] = useSendTo(entry);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // The backend's rules, said before the click (it enforces them regardless). Comparisons with
  // the server's figure only — nothing derived here is shown as money.
  const guestPays = method !== "DIRECT_BILL" && method !== "VOUCHER";
  const typed = paidNow.trim() === "" ? Number.NaN : Number.parseFloat(paidNow);
  const partial = guestPays && Number.isFinite(typed) && typed >= 0 && typed < owes;
  const creditCovers = partial && !!ps?.creditExtensionActive && ps?.ceilingAmount != null && ps.ceilingAmount >= owes - typed;
  const partialLocked = partial && !fom && !creditCovers;
  const voucherTyped = voucherCovers.trim() === "" ? Number.NaN : Number.parseFloat(voucherCovers);
  const voucherValid = Number.isFinite(voucherTyped) && voucherTyped >= 0;
  const takesMoney = guestPays && (!Number.isFinite(typed) || typed > 0);
  const needsRef = (method === "CASH" || method === "MOBILE_PAYMENT") && takesMoney && !ref.trim();

  const reason = !live
    ? "only while the booking is at Check-out"
    : partialLocked
      ? "a part-payment needs the FOM or a credit extension"
      : method === "VOUCHER" && !voucherValid
        ? "put in what the voucher covers"
        : needsRef
          ? "cash and QR need a payment reference"
          : undefined;

  const settle = useMutation({
    mutationFn: () => {
      if (!folio?.id) throw new Error("There is no bill on this booking");
      const body: Parameters<typeof initiateSettlement>[2] = {
        settlementMethod: method,
        billingModelConfirmation: share.billingModel,
        billingModel: share.billingModel,
      };
      if (ref.trim() && method !== "DIRECT_BILL") body.paymentVerificationRef = ref.trim();
      if (method === "VOUCHER") {
        if (voucherValid) body.voucherAmount = voucherTyped;
      } else if (guestPays && paidNow.trim() !== "" && Number.isFinite(typed) && typed >= 0) {
        body.partialAmount = typed;
      }
      if ((method === "DIRECT_BILL" || method === "VOUCHER") && invoiceTo.trim()) body.invoiceDispatchedTo = invoiceTo.trim();
      return initiateSettlement(session!, folio.id, body);
    },
    onSuccess: () => {
      setConfirmOpen(false);
      toast.success(
        method === "DIRECT_BILL"
          ? `${title} — invoiced to ${payer}`
          : method === "VOUCHER"
            ? `${title} — the voucher is recorded; anything it leaves is invoiced to ${payer}`
            : partial
              ? `${title} — settled in part; the rest stays owed`
              : `${title} — settled`,
      );
      refresh([["settlement-targets"], ["settlement-buckets"], ["folio-documents"]]);
    },
    onError: (e) => toastRefusal(e, "The share did not settle"),
  });

  const done = owes <= 0 || !!share.invoiceId;
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12 }}>
      <div className="row-acts" style={{ justifyContent: "space-between" }}>
        <b className="sm">{title}</b>
        {share.invoiceId ? (
          <Chip tone={owes > 0 ? "warning" : "success"}>
            {owes > 0 ? `invoiced · ${money(owes, currency)} owed` : "invoiced · paid"} · {share.invoiceId}
          </Chip>
        ) : owes <= 0 ? (
          <Chip tone="success" icon="check">
            settled
          </Chip>
        ) : (
          <Chip tone="accent">owes {money(owes, currency)}</Chip>
        )}
      </div>
      <div className="meta">
        charges {money(share.charges, currency)} · still owed {money(owes, currency)}
      </div>

      {done ? null : (
        <Live>
          <div className="form2" style={{ marginTop: 10 }}>
            <div className="field">
              <label>How they pay</label>
              <select className="input" value={method} onChange={(e) => setMethod(e.target.value as SettleMethod)}>
                {methods.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            {method === "DIRECT_BILL" ? null : (
              <div className="field">
                <label>{method === "VOUCHER" ? "Voucher number" : "Payment reference"}</label>
                <input
                  className="input"
                  value={ref}
                  placeholder={method === "VOUCHER" ? "the agency's voucher number" : "the transaction reference"}
                  onChange={(e) => setRef(e.target.value)}
                />
              </div>
            )}
            {method === "VOUCHER" ? (
              <div className="field">
                <label>The voucher covers · Nu.</label>
                <input
                  className="input money"
                  inputMode="decimal"
                  value={voucherCovers}
                  onChange={(e) => {
                    voucherTouched.current = true;
                    setVoucherCovers(e.target.value);
                  }}
                />
                <span className="hint">anything it leaves of this share is invoiced to {payer}</span>
              </div>
            ) : method === "DIRECT_BILL" ? null : (
              <div className="field">
                <label>Paid now · Nu.</label>
                <input
                  className="input money"
                  inputMode="decimal"
                  value={paidNow}
                  placeholder="empty = the whole share"
                  onChange={(e) => {
                    paidTouched.current = true;
                    setPaidNow(e.target.value);
                  }}
                />
                <span className={`hint${partial ? " warn-ink" : ""}`}>
                  {partial ? `less than the ${money(owes, currency)} share — the rest stays owed, collected after the stay` : "the whole share, unless you type less"}
                </span>
              </div>
            )}
            {method === "DIRECT_BILL" || method === "VOUCHER" ? (
              <SendToField entry={entry} value={invoiceTo} onChange={setInvoiceTo} label="Send the invoice to" />
            ) : null}
          </div>
          {partialLocked ? (
            <div style={{ marginTop: 10 }}>
              <Refusal
                kind="authority"
                message={`Leaving part of the ${money(owes, currency)} share unpaid needs the FOM.`}
                guidance="The FOM settles it, or records a credit extension that covers what is left."
              />
            </div>
          ) : null}
          <div className="row-acts" style={{ marginTop: 10 }}>
            <Button icon="lock" state={reason ? "inert" : "default"} reason={reason} onClick={() => setConfirmOpen(true)}>
              Settle this share
            </Button>
          </div>
        </Live>
      )}

      <DsDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={`Settle ${title}`}
        caseLines={[<b key="p">{payer}</b>, `${money(owes, currency)} on this share`]}
        busy={settle.isPending}
        footer={
          <>
            <Button kind="quiet" state={settle.isPending ? "inert" : "default"} onClick={() => setConfirmOpen(false)}>
              Not yet
            </Button>
            <Button icon="lock" state={settle.isPending ? "working" : "default"} workingLabel="Settling…" onClick={() => settle.mutate()}>
              Settle this share
            </Button>
          </>
        }
      >
        <p className="sm">This cannot be undone. What becomes binding:</p>
        <ul className="plain-list sm" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
          <li>
            {method === "DIRECT_BILL" ? (
              <>
                The <b className="money">{money(owes, currency)}</b> share is invoiced to {payer}
                {invoiceTo.trim() ? `, emailed to ${invoiceTo.trim()}` : " — no email address, so the invoice is handed over"}.
              </>
            ) : method === "VOUCHER" ? (
              <>
                The voucher covers <b className="money">{money(voucherValid ? voucherTyped : null, currency)}</b> of the{" "}
                <b className="money">{money(owes, currency)}</b> share — anything it leaves is invoiced to {payer}.
              </>
            ) : partial ? (
              <>
                {payer} pays <b className="money">{money(typed, currency)}</b> now — the rest of the {money(owes, currency)} share stays owed.
              </>
            ) : (
              <>
                {payer} pays the <b className="money">{money(owes, currency)}</b> share now.
              </>
            )}
          </li>
          <li>When this is the last share still open, the rooms are released to housekeeping.</li>
        </ul>
      </DsDialog>
    </div>
  );
}

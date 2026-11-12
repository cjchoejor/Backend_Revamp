"use client";

/**
 * What a cancellation would charge and refund, shown in the cancel dialog before the click that
 * cannot be undone (2026-09-18). The dialogs used to promise "the disclosed charge, if any, is
 * posted and the rest refunded" without a figure. Every number is the backend's preview — the same
 * computation the cancellation itself runs — so what the desk reads out is what happens.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { previewCancellation } from "@/lib/api/reservation-setup";
import { BankFields, useBankEntry } from "@/components/ds/bank-fields";
import { money } from "@/lib/ds/format";

export function CancellationFiguresLine({ entryId, waive = false, currency }: { entryId: string; waive?: boolean; currency?: string }) {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ["cancellation-preview", entryId, waive],
    queryFn: () => previewCancellation(session!, entryId, waive),
    enabled: !!session,
    staleTime: 0,
  });
  if (q.isLoading) return <p className="meta">Reading what the cancellation would charge…</p>;
  if (!q.data) return <p className="meta warn-ink">The charge could not be read — the cancellation still applies the disclosed terms.</p>;
  const f = q.data;
  const cur = currency ?? "Nu.";
  // Which line of the policy decides the charge, in the policy's words (2026-11-10).
  const rule = f.rule
    ? f.rule.from === "BOOKING_TERMS"
      ? `By the policy this booking keeps: ${f.rule.label}`
      : f.rule.from === "SETTING"
        ? `By the hotel's policy: ${f.rule.label}`
        : f.rule.label
    : null;
  return (
    <div className="notice inert" style={{ margin: "8px 0" }}>
      <span className="sm">
        {rule ? (
          <span style={{ display: "block", marginBottom: 4 }} data-cancel-rule>
            {rule}
          </span>
        ) : null}
        Received <b className="money">{money(f.advanceReceived, cur)}</b> · charged{" "}
        <b className="money">{money(f.charge, cur)}</b>
        {f.waived && f.chargeCapped > 0 ? ` (the ${money(f.chargeCapped, cur)} charge waived)` : ""}
        {!f.waived && f.chargeBeforeCap > f.chargeCapped ? ` (the terms ask ${money(f.chargeBeforeCap, cur)} — never more than was received)` : ""} ·
        refunded <b className="money">{money(f.refund, cur)}</b>
        {f.tripMoves?.length ? (
          <span style={{ display: "block", marginTop: 4 }} data-trip-moves>
            Money paid for the trip counts as one:{" "}
            {f.tripMoves.map((m) => `${money(m.amount, cur)} moves from Stay ${m.fromStayNo}'s bill to Stay ${m.toStayNo}'s`).join(" · ")}
          </span>
        ) : null}
      </span>
    </div>
  );
}

// How the money owed back leaves the hotel (2026-09-19). Left alone it goes back the way it came —
// the backend reads the payments; it used to be recorded as cash whatever the guest had paid by.
const REFUND_HOW = [
  ["", "The way it came in"],
  ["CASH", "Cash"],
  ["CARD", "Back to the card (POS)"],
  ["MOBILE_PAYMENT", "Mobile payment (QR)"],
  ["BANK_TRANSFER", "Bank transfer"],
] as const;

const WAY_WORD: Record<string, string> = {
  CASH: "cash",
  CARD: "the card (POS)",
  MOBILE_PAYMENT: "a QR payment",
  BANK_TRANSFER: "a bank transfer",
  INWARD_REMITTANCE: "a remittance",
};

/**
 * How a cancellation's refund goes back, and — when it goes through a bank — its bank and journal
 * number (2026-11-12). "The way it came in" is read off the preview (the server resolves it), so the
 * bank is asked whenever the refund will go through one. A single booking reads its own preview
 * (`entryId`, shared with the figures line); a trip passes what its own preview says.
 */
export function useRefundHow(source: { entryId?: string; waive?: boolean; trip?: { refundDue: boolean; ways: string[] } } = {}) {
  const { session } = useSession();
  const [method, setMethod] = useState("");
  const [reference, setReference] = useState("");
  const bank = useBankEntry();
  const q = useQuery({
    queryKey: ["cancellation-preview", source.entryId, !!source.waive],
    queryFn: () => previewCancellation(session!, source.entryId!, !!source.waive),
    enabled: !!session && !!source.entryId,
    staleTime: 0,
  });
  const refundDue = source.trip ? source.trip.refundDue : (q.data?.refund ?? 0) > 0;
  const ways = method ? [method] : source.trip ? source.trip.ways : q.data?.refundWayItCame ? [q.data.refundWayItCame] : [];
  const bankWay = ways.find((w) => bank.needs(w)) ?? null;
  const asksBank = refundDue && !!bankWay;
  const missing = asksBank ? bank.missing(bankWay) : null;
  const body = {
    ...(method ? { refundMethod: method } : {}),
    ...(!asksBank && reference.trim() ? { refundReference: reference.trim() } : {}),
    ...(asksBank ? { refundBank: bank.bank, refundJournal: bank.journal.trim() } : {}),
  };
  const fields = (
    <>
      <div className="form2" style={{ marginTop: 8 }}>
        <div className="field">
          <label>How any refund goes back</label>
          <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
            {REFUND_HOW.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          {!method && refundDue && ways.length === 1 ? <span className="hint">By {WAY_WORD[ways[0]] ?? ways[0].toLowerCase()}, the way it came in</span> : null}
        </div>
        {asksBank ? null : (
          <div className="field">
            <label>Refund reference · optional</label>
            <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="the slip number" />
          </div>
        )}
      </div>
      {asksBank ? <BankFields entry={bank} method={bankWay} what="refund" /> : null}
    </>
  );
  return { body, fields, missing };
}

export function WaiverTick({ checked, onChange, gm }: { checked: boolean; onChange: (v: boolean) => void; gm: boolean }) {
  if (!gm) return <p className="meta">Only the GM can waive the cancellation charge.</p>;
  return (
    <label className="sm" style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      Waive the cancellation charge — your authority as GM
    </label>
  );
}

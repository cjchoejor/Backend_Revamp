"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Split } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { getSettlementTargets, recordTargetPayment, type SettlementTargetRow } from "@/lib/api/split-settlement";
import { money } from "@/lib/desk/workspace";
import type { EntryDetail } from "@/types/api";

/**
 * "Who's paying for what" — one row per room and space, and what each still owes (PMS-237,
 * 2026-09-09, operator request: "sometimes guest pays differently — say there are two rooms …
 * while settling can there be an option like which part of the folio they want to settle").
 *
 * Renders on Stay, Check-out and Closed, because that is where the operator said the money
 * arrives: in-house, at the desk on the way out, and chasing it afterwards. Taking money here
 * is deliberately NOT settlement — settlement closes the stay. This just records who paid for
 * which part, so a guest can pay for their room and leave while the other room keeps running.
 *
 * No arithmetic happens in this file. Every figure is read from
 * `GET /api/folios/:id/settlement-targets`.
 */
export function SplitSettlementBlock({
  entry,
  folioId,
  /** Collapsed by default everywhere except S8, where settling is the job at hand. */
  defaultOpen = false,
}: {
  entry: EntryDetail;
  folioId: string;
  defaultOpen?: boolean;
}) {
  const { session } = useSession();
  const qc = useQueryClient();
  const [open, setOpen] = useState(defaultOpen);
  /** Which row's collect form is showing — only one at a time; a stray amount can't be misfiled. */
  const [collecting, setCollecting] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("CASH");
  const [ref, setRef] = useState("");

  const q = useQuery({
    queryKey: ["settlement-targets", folioId, entry.updatedAt],
    queryFn: () => getSettlementTargets(session!, folioId),
    enabled: !!session && !!folioId,
    refetchInterval: 30_000,
  });

  const data = q.data;
  const rows = data?.targets ?? [];
  const cur = data?.currency;
  /** A single-room booking with everything on the room has nothing to split — stay quiet. */
  const worthShowing = rows.length > 1 || rows.some((r) => r.kind !== "UNASSIGNED");

  const rowKey = (r: SettlementTargetRow) => `${r.kind}:${r.roomId ?? r.spaceId ?? "none"}`;
  const rowName = (r: SettlementTargetRow) =>
    r.kind === "ROOM" ? `Room ${r.label ?? "?"}` : r.kind === "SPACE" ? r.label ?? "Space" : "No room / space";

  const activeRow = rows.find((r) => rowKey(r) === collecting) ?? null;
  // Prefill with what the row can actually take, so the common case is one click and Enter.
  useEffect(() => {
    if (activeRow) setAmount(activeRow.collectable > 0 ? activeRow.collectable.toFixed(2) : "");
  }, [collecting]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["settlement-targets"] });
    void qc.invalidateQueries({ queryKey: ["billing-summary"] });
    void qc.invalidateQueries({ queryKey: ["entry"] });
    void qc.invalidateQueries({ queryKey: ["payment-status"] });
  };

  const payM = useMutation({
    mutationFn: async () => {
      if (!activeRow) throw new Error("Pick a part of the bill first");
      const amt = Number.parseFloat(amount);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error("Enter the amount received");
      return recordTargetPayment(session!, folioId, {
        entryId: entry.id,
        ...(activeRow.roomId ? { roomId: activeRow.roomId } : {}),
        ...(activeRow.spaceId ? { spaceId: activeRow.spaceId } : {}),
        amount: amt,
        paymentMethod: method,
        ...(ref.trim() ? { paymentVerificationRef: ref.trim() } : {}),
      });
    },
    onSuccess: (out) => {
      const name = activeRow ? rowName(activeRow) : "this part of the bill";
      toast.success(
        out.targetSettledInFull
          ? `${name} is paid in full — ${money(out.amount, cur)} received`
          : `${money(out.amount, cur)} received for ${name} · ${money(out.targetOutstandingAfter, cur)} still owing`,
      );
      setCollecting(null);
      setAmount("");
      setRef("");
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : (e as Error)?.message ?? "Couldn't record that payment"),
  });

  const needsRef = method === "CASH" || method === "MOBILE_PAYMENT";
  const settled = data?.folioState === "SETTLED" || data?.folioState === "CLOSED";

  const tally = useMemo(() => {
    const owing = rows.filter((r) => r.outstanding > 0).length;
    return owing === 0 ? "all parts paid" : `${owing} of ${rows.length} still owing`;
  }, [rows]);

  if (!folioId || (!q.isLoading && !worthShowing)) return null;

  return (
    <div className="block">
      <div
        className="block-h"
        onClick={() => setOpen((v) => !v)}
        role="button"
        style={{ cursor: "pointer", userSelect: "none" }}
        title={open ? "Hide this section" : "Show this section"}
      >
        <Split style={{ width: 13, height: 13 }} />
        Who&apos;s paying for what
        {data && (
          <span style={{ fontWeight: 500, color: "var(--ink-3)", fontSize: 11 }}>
            · {tally}
          </span>
        )}
        <span className="ln" />
        <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--ink-3)", whiteSpace: "nowrap", letterSpacing: 0.3 }}>
          {open ? "Hide ▴" : "Show ▾"}
        </span>
      </div>

      {open && (
        <>
          <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "0 0 8px" }}>
            Each room and space carries its own share of the bill. Taking money here records{" "}
            <b>who paid for which part</b> — it does not check the guest out or close the folio.
          </p>

          {q.isLoading && <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Reading the bill…</div>}

          {data && (
            <div style={{ border: "1px solid var(--line-2)", borderRadius: "var(--r-sm)", overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr>
                    {["Part of the bill", "Charges", "Paid", "Still owes", ""].map((h, i) => (
                      <th
                        key={h || i}
                        style={{
                          textAlign: i === 0 || i === 4 ? "left" : "right",
                          padding: "6px 10px",
                          background: "var(--cream-2)",
                          borderBottom: "1px solid var(--line-2)",
                          fontSize: 9.5,
                          fontWeight: 700,
                          letterSpacing: "0.05em",
                          textTransform: "uppercase",
                          color: "var(--ink-3)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const key = rowKey(r);
                    const done = r.outstanding <= 0;
                    return (
                      <tr key={key} style={{ borderBottom: "1px solid var(--line-2)" }}>
                        <td style={{ padding: "6px 10px" }}>
                          <b>{rowName(r)}</b>
                          <span style={{ marginLeft: 6, fontSize: 10.5, color: "var(--ink-4)" }}>
                            {r.lineCount} line{r.lineCount === 1 ? "" : "s"}
                          </span>
                        </td>
                        <td style={{ padding: "6px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {money(r.charges, cur)}
                        </td>
                        <td style={{ padding: "6px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--ink-3)" }}>
                          {r.paid > 0 ? money(r.paid, cur) : "—"}
                        </td>
                        <td
                          style={{
                            padding: "6px 10px",
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                            fontWeight: done ? 500 : 700,
                            color: done ? "var(--go)" : undefined,
                          }}
                        >
                          {done ? "paid" : money(r.outstanding, cur)}
                        </td>
                        <td style={{ padding: "6px 10px" }}>
                          {!done && !settled && (
                            <button
                              type="button"
                              className="btn btn-ghost"
                              style={{ fontSize: 11, padding: "3px 9px" }}
                              onClick={() => setCollecting(collecting === key ? null : key)}
                            >
                              {collecting === key ? "Cancel" : "Take payment"}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Money the hotel holds that names no room. Stated, never netted off a slice —
                  it is exactly why the rows can add up to more than the balance below. */}
              {data.unappliedPayments > 0 && (
                <div
                  style={{
                    padding: "7px 10px",
                    background: "var(--warn-t)",
                    borderTop: "1px solid var(--line-2)",
                    fontSize: 11.5,
                  }}
                >
                  <b>{money(data.unappliedPayments, cur)}</b> was received against the booking as a whole (the advance),
                  so it is not counted against any one part above. The booking&apos;s balance is already{" "}
                  <b>{money(data.folioOutstanding, cur)}</b> — that is the most that can still be collected in total.
                </div>
              )}

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "7px 10px",
                  background: "var(--paper)",
                  borderTop: "1px solid var(--line-2)",
                  fontSize: 11.5,
                }}
              >
                <span style={{ color: "var(--ink-3)" }}>Balance on the booking</span>
                <b style={{ fontVariantNumeric: "tabular-nums" }}>{money(data.folioOutstanding, cur)}</b>
              </div>
            </div>
          )}

          {activeRow && !settled && (
            <div
              style={{
                marginTop: 10,
                padding: 10,
                border: "1px solid var(--line-2)",
                borderRadius: "var(--r-sm)",
                background: "var(--cream)",
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                Money received for {rowName(activeRow)}
              </div>
              <div className="frow">
                <div className="field">
                  <label>Amount received</label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="field">
                  <label>Method</label>
                  <select value={method} onChange={(e) => setMethod(e.target.value)}>
                    <option value="CASH">Cash</option>
                    <option value="CARD">Card</option>
                    <option value="MOBILE_PAYMENT">Mobile payment</option>
                    <option value="BANK_TRANSFER">Bank transfer</option>
                  </select>
                </div>
                <div className="field">
                  <label>Reference{needsRef ? "" : " (optional)"}</label>
                  <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="receipt / txn no." />
                </div>
              </div>
              <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "2px 0 8px" }}>
                {activeRow.collectable < activeRow.outstanding ? (
                  <>
                    This part owes {money(activeRow.outstanding, cur)}, but only{" "}
                    <b>{money(activeRow.collectable, cur)}</b> of that is still uncovered — the rest is already
                    paid for by money received against the booking.
                  </>
                ) : (
                  <>Up to {money(activeRow.collectable, cur)} can be taken for this part.</>
                )}
              </p>
              <button
                type="button"
                className="btn btn-primary"
                disabled={payM.isPending || !amount.trim() || (needsRef && !ref.trim())}
                onClick={() => payM.mutate()}
                title={needsRef && !ref.trim() ? "Cash and mobile payments need a reference" : undefined}
              >
                {payM.isPending ? "Recording…" : "Record payment"}
              </button>
            </div>
          )}

          {settled && (
            <p style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 8 }}>
              The folio is {data?.folioState.toLowerCase()} — money taken after this is recorded against the invoice,
              not against a part of the bill.
            </p>
          )}
        </>
      )}
    </div>
  );
}

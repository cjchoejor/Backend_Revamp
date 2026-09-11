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
  // Is this room's guest still here? (2026-09-09, operator ruling.) Deliberately starts unset:
  // paying for a room says nothing about whether anyone is still in it, and a payment must
  // never release a room by accident.
  const [roomStatus, setRoomStatus] = useState<"" | "STILL_STAYING" | "LEFT">("");
  const [departureReason, setDepartureReason] = useState("");
  // Draw on the advance for this slice (2026-09-11, operator request — "if there is advance
  // paid, have an option where that guest can choose to use all or a percentage or some of it,
  // and note how much was deducted and what is left"). Starts unset: the advance is the
  // booking's money and must never land on a room because a form defaulted it there.
  const [advMode, setAdvMode] = useState<"" | "ALL" | "PERCENT" | "AMOUNT">("");
  const [advValue, setAdvValue] = useState("");

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
    setRoomStatus("");
    setDepartureReason("");
    setAdvMode("");
    setAdvValue("");
  }, [collecting]); // eslint-disable-line react-hooks/exhaustive-deps

  // Choosing to use the advance zeroes the cash box, because the case that prompted this is the
  // guest who hands over nothing — the advance covers their room. It is a DEFAULT, not a
  // calculation: whatever cash is actually taken is typed, and the server decides if it fits.
  useEffect(() => {
    if (advMode) setAmount("0");
    else if (activeRow) setAmount(activeRow.collectable > 0 ? activeRow.collectable.toFixed(2) : "");
  }, [advMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["settlement-targets"] });
    void qc.invalidateQueries({ queryKey: ["billing-summary"] });
    void qc.invalidateQueries({ queryKey: ["entry"] });
    void qc.invalidateQueries({ queryKey: ["payment-status"] });
  };

  const payM = useMutation({
    mutationFn: async () => {
      if (!activeRow) throw new Error("Pick a part of the bill first");
      const amt = amount.trim() === "" ? 0 : Number.parseFloat(amount);
      if (!Number.isFinite(amt) || amt < 0) throw new Error("Enter the amount received");
      if (amt <= 0 && !advMode) throw new Error("Enter the amount received, or choose how much of the advance to use");
      const advValueNum = Number.parseFloat(advValue);
      if (advMode && advMode !== "ALL" && (!Number.isFinite(advValueNum) || advValueNum <= 0)) {
        throw new Error(advMode === "PERCENT" ? "Enter the percentage of the advance to use" : "Enter how much of the advance to use");
      }
      return recordTargetPayment(session!, folioId, {
        entryId: entry.id,
        ...(activeRow.roomId ? { roomId: activeRow.roomId } : {}),
        ...(activeRow.spaceId ? { spaceId: activeRow.spaceId } : {}),
        amount: amt,
        paymentMethod: method,
        ...(ref.trim() ? { paymentVerificationRef: ref.trim() } : {}),
        ...(roomStatus ? { roomStatus } : {}),
        ...(roomStatus === "LEFT" && departureReason.trim() ? { departureReason: departureReason.trim() } : {}),
        ...(advMode
          ? { advanceApplication: { mode: advMode, ...(advMode === "ALL" ? {} : { value: advValueNum }) } }
          : {}),
      });
    },
    onSuccess: (out) => {
      const name = activeRow ? rowName(activeRow) : "this part of the bill";
      // What was taken and where it came from, said separately — cash the hotel now holds is
      // not the same event as advance it already held being pointed at this room.
      const took =
        out.advanceApplied > 0 && out.amount > 0
          ? `${money(out.amount, cur)} received and ${money(out.advanceApplied, cur)} taken from the advance`
          : out.advanceApplied > 0
            ? `${money(out.advanceApplied, cur)} taken from the advance`
            : `${money(out.amount, cur)} received`;
      toast.success(
        out.targetSettledInFull
          ? `${name} is paid in full — ${took}`
          : `${took} for ${name} · ${money(out.targetOutstandingAfter, cur)} still owing`,
      );
      if (out.advanceApplied > 0) {
        toast.info(
          `Advance left on the booking: ${money(out.advanceRemaining, cur)}` +
            (out.advanceCappedBy === "SLICE_OWES"
              ? ` — only what ${name} still owed was used`
              : out.advanceCappedBy === "ADVANCE_AVAILABLE"
                ? " — that was all the advance still had"
                : ""),
          { duration: 9_000 },
        );
      }
      // The money and the room are two outcomes, and the refusal of one must never read as
      // the failure of the other — the operator has already taken the cash.
      if (out.departure) {
        toast.success(
          out.departure.nothingForgone
            ? `${name} released — the room is ready for housekeeping`
            : `${name} released · ${out.departure.unstayedNights} unstayed night${out.departure.unstayedNights === 1 ? "" : "s"} given up`,
        );
      } else if (out.departureRefused) {
        toast.warning(`The money is recorded, but the room was NOT released — ${out.departureRefused}`, { duration: 12_000 });
      }
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
                          {/* Where that money came from matters: advance already held reads
                              differently from cash taken at the desk for this room. */}
                          {r.advanceApplied > 0 && (
                            <div style={{ fontSize: 10, color: "var(--ink-3)" }}>
                              incl. {money(r.advanceApplied, cur)} advance
                            </div>
                          )}
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
              {/* Use the advance for this slice (2026-09-11). Offered only when the booking
                  actually holds unapplied money and this part still owes something — there is
                  nothing to decide otherwise. No money moves: this records which slice the
                  advance answers for, so the booking's own balance does not change. */}
              {activeRow.kind !== "UNASSIGNED" && (data?.unappliedPayments ?? 0) > 0 && activeRow.outstanding > 0 && (
                <div className="field" style={{ marginTop: 2 }}>
                  <label>Use the advance for this part?</label>
                  <select value={advMode} onChange={(e) => setAdvMode(e.target.value as typeof advMode)}>
                    <option value="">No — money received now</option>
                    <option value="ALL">All of the advance it can absorb</option>
                    <option value="PERCENT">A percentage of the advance</option>
                    <option value="AMOUNT">A set amount of the advance</option>
                  </select>
                  {(advMode === "PERCENT" || advMode === "AMOUNT") && (
                    <input
                      style={{ marginTop: 6 }}
                      type="number"
                      min={0}
                      step={advMode === "PERCENT" ? "1" : "0.01"}
                      max={advMode === "PERCENT" ? 100 : undefined}
                      value={advValue}
                      onChange={(e) => setAdvValue(e.target.value)}
                      placeholder={advMode === "PERCENT" ? "% of the advance (1–100)" : "amount of the advance to use"}
                    />
                  )}
                  {advMode && (
                    <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "4px 0 0" }}>
                      {money(data?.unappliedPayments ?? 0, cur)} of advance is unapplied. Using it moves no money —
                      it records that this part of the bill is answered by what the guest already paid, so the
                      booking&apos;s balance stays as it is. You will be told how much was used and how much is left.
                    </p>
                  )}
                </div>
              )}

              {/* Still staying, or gone? (2026-09-09, operator ruling — "if someone pays for
                  the room, there can be an option like flag the room as guest is still staying
                  … or left if he only paid for 2 nights"). Only a ROOM can be flagged, and the
                  default is neither: paying says nothing about whether anyone is still in it. */}
              {activeRow.kind === "ROOM" && (
                <div className="field" style={{ marginTop: 2 }}>
                  <label>Is the guest of this room still here?</label>
                  <select value={roomStatus} onChange={(e) => setRoomStatus(e.target.value as typeof roomStatus)}>
                    <option value="">Don&apos;t change the room</option>
                    <option value="STILL_STAYING">Still staying — paying ahead</option>
                    <option value="LEFT">Left — release the room</option>
                  </select>
                  {roomStatus === "LEFT" && (
                    <>
                      <input
                        style={{ marginTop: 6 }}
                        value={departureReason}
                        onChange={(e) => setDepartureReason(e.target.value)}
                        placeholder="Why is the room being released?"
                      />
                      <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "4px 0 0" }}>
                        The room&apos;s nights stop being billed from today and it goes to housekeeping. The rest of
                        the booking carries on. Giving up nights still booked needs the GM — if it is refused, the
                        money is still recorded.
                      </p>
                    </>
                  )}
                </div>
              )}
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
                disabled={
                  payM.isPending ||
                  // Something must actually be happening: cash, or advance being applied.
                  (!(Number.parseFloat(amount) > 0) && !advMode) ||
                  // A reference belongs to money changing hands — an advance-only entry takes none.
                  (Number.parseFloat(amount) > 0 && needsRef && !ref.trim()) ||
                  (advMode !== "" && advMode !== "ALL" && !advValue.trim())
                }
                onClick={() => payM.mutate()}
                title={
                  Number.parseFloat(amount) > 0 && needsRef && !ref.trim()
                    ? "Cash and mobile payments need a reference"
                    : undefined
                }
              >
                {payM.isPending
                  ? "Recording…"
                  : advMode && !(Number.parseFloat(amount) > 0)
                    ? "Use the advance"
                    : "Record payment"}
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

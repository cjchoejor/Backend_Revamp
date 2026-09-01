"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getRateReference } from "@/lib/api/entries";
import { moneyOrDash } from "@/lib/desk/workspace";

/**
 * Reference rates under the S2 composition editors (2026-08-01, operator request): typing a
 * negotiated rate needs an anchor — what would this room cost WITHOUT one? Reads
 * GET /api/entries/:id/rate-reference, which returns exactly the defaults the backend pricing
 * uses (agent/corporate card incl. per-type override, else the standard rate plan, plus the
 * card's extra-bed/meal add-ons and the standard rate + MSR floor). Display only — every
 * figure verbatim from the API, nothing computed here.
 */

const TH: React.CSSProperties = { padding: "3px 16px 4px 0", fontWeight: 600, whiteSpace: "nowrap", textAlign: "left" };
const TD: React.CSSProperties = { padding: "4px 16px 4px 0", whiteSpace: "nowrap" };

/** The add-on rate columns. Rendered only when at least one type carries a value — without a
 *  rate card they are ALL null, and four columns of dashes were most of the strip's noise. */
const ADD_ON_COLS = [
  ["extraBedRate", "Extra bed"],
  ["breakfastRate", "B'fast"],
  ["lunchRate", "Lunch"],
  ["dinnerRate", "Dinner"],
] as const;

export function RateReferenceStrip({ entryId, compact }: { entryId: string; compact?: boolean }) {
  const { session } = useSession();
  const query = useQuery({
    queryKey: ["rate-reference", entryId],
    queryFn: () => getRateReference(session!, entryId),
    enabled: !!session,
    staleTime: 5 * 60_000,
  });

  const ref = query.data;
  if (!ref || ref.roomTypes.length === 0) return null;

  const pct = (rate: number) => `${(rate * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  const visibleAddOns = ADD_ON_COLS.filter(([key]) => ref.roomTypes.some((t) => t[key] != null));

  return (
    // Boxed (2026-08-06, operator request) — the same bordered-strip language as the discount
    // bar below it, so the reference reads as its own card instead of loose rows on the panel.
    <div
      style={{
        marginTop: compact ? 0 : 12,
        fontSize: 11.5,
        color: "var(--ink-3, #7a6a52)",
        border: "1px solid var(--line-2, #d9cdb8)",
        borderRadius: "var(--r-md, 10px)",
        background: "var(--cream, #faf6ee)",
        padding: "8px 12px",
      }}
    >
      <div style={{ marginBottom: compact ? 3 : 6, display: "flex", alignItems: "baseline", gap: 6 }}>
        <span className="rce-lbl">Reference rates</span>
        <span style={{ fontSize: 11 }}>
          per night · SC {pct(ref.serviceChargeRate)} + GST {pct(ref.gstRate)} on top
          {ref.party && <> · {ref.party.type === "TRAVEL_AGENT" ? "agent" : "corporate"} card: {ref.party.name}</>}
        </span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11.5 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--ink-3, #7a6a52)" }}>
              {["Room type", "Rooms", "Room", ...visibleAddOns.map(([, label]) => label), "Basis"].map((h) => (
                <th key={h} style={TH}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ref.roomTypes.map((t) => (
              <tr key={t.roomTypeId} style={{ borderTop: "1px dashed var(--line, #e3d9c8)" }}>
                <td style={TD}>
                  <b>{t.code ?? t.name}</b>
                  {t.code && <span style={{ marginLeft: 6 }}>{t.name}</span>}
                </td>
                <td style={TD}>{t.roomNumbers.join(", ")}</td>
                <td className="mono" style={TD}>
                  {moneyOrDash(t.roomRate, ref.currency)}
                </td>
                {visibleAddOns.map(([key]) => (
                  <td key={key} className="mono" style={TD}>
                    {moneyOrDash(t[key], ref.currency)}
                  </td>
                ))}
                <td style={{ ...TD, paddingRight: 0 }}>
                  {t.roomRateSource === "AGENT_RATE_PACKAGE" ? (
                    <>
                      {t.packageName ?? "rate package"}
                      {t.standardRate != null && <> · standard {moneyOrDash(t.standardRate, ref.currency)}</>}
                    </>
                  ) : t.roomRateSource === "STANDARD_RATE_PLAN" ? (
                    <>
                      standard plan
                      {t.msrValue != null && <> · MSR floor {moneyOrDash(t.msrValue, ref.currency)}</>}
                    </>
                  ) : (
                    "no rate on file"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ margin: "6px 0 0", lineHeight: 1.6, display: compact ? "none" : undefined }}>
        These are what the draft prices with when a negotiated cell is left empty
        {ref.nights != null ? ` · ${ref.nights} night${ref.nights === 1 ? "" : "s"}` : ""}.
        {visibleAddOns.length === 0
          ? " No extra-bed or meal rates on file — those lines price at zero unless negotiated in the grid."
          : ref.roomTypes.some((t) => visibleAddOns.some(([key]) => t[key] == null)) &&
            " Dashes mean no rate on file — those lines price at zero unless negotiated."}
      </p>
    </div>
  );
}

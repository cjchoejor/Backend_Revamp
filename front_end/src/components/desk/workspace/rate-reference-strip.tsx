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

// Generous column/row spacing — the strip reads as an airy reference table, not a data grid.
const TH: React.CSSProperties = { padding: "4px 26px 6px 0", fontWeight: 600, whiteSpace: "nowrap", textAlign: "left" };
const TD: React.CSSProperties = { padding: "6px 26px 6px 0", whiteSpace: "nowrap" };

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

  return (
    <div style={{ marginTop: compact ? 0 : 12, fontSize: 11.5, color: "var(--ink-3, #7a6a52)" }}>
      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: compact ? 3 : 6 }}>
        REFERENCE RATES · per night
        {ref.party && (
          <span style={{ fontWeight: 400 }}>
            {" "}
            — {ref.party.type === "TRAVEL_AGENT" ? "agent" : "corporate"} card: {ref.party.name}
          </span>
        )}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11.5 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--ink-3, #7a6a52)" }}>
              {["Room type", "Rooms", "Room", "Extra bed", "B'fast", "Lunch", "Dinner", "Basis"].map((h) => (
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
                <td className="mono" style={TD}>
                  {moneyOrDash(t.extraBedRate, ref.currency)}
                </td>
                <td className="mono" style={TD}>
                  {moneyOrDash(t.breakfastRate, ref.currency)}
                </td>
                <td className="mono" style={TD}>
                  {moneyOrDash(t.lunchRate, ref.currency)}
                </td>
                <td className="mono" style={TD}>
                  {moneyOrDash(t.dinnerRate, ref.currency)}
                </td>
                <td style={{ ...TD, paddingRight: 0 }}>
                  {t.roomRateSource === "AGENT_RATE_CARD" ? (
                    <>
                      rate card
                      {t.standardRate != null && <> · standard {moneyOrDash(t.standardRate, ref.currency)}</>}
                    </>
                  ) : t.roomRateSource === "STANDARD_RATE_PLAN" ? (
                    <>
                      standard plan
                      {t.msrValue != null && <> · floor (MSR) {moneyOrDash(t.msrValue, ref.currency)}</>}
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
        These are what the draft prices with when a negotiated cell is left empty. Service charge {pct(ref.serviceChargeRate)}{" "}
        and GST {pct(ref.gstRate)} are added on top{ref.nights != null ? ` · ${ref.nights} night${ref.nights === 1 ? "" : "s"}` : ""}.
        {ref.roomTypes.some((t) => t.breakfastRate == null) &&
          " Meal/extra-bed dashes mean no rate card carries them — those lines price at zero unless negotiated."}
      </p>
    </div>
  );
}

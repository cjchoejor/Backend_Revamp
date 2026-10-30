"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getRateReference } from "@/lib/api/entries";
import { moneyOrDash } from "@/lib/desk/workspace";
import { Help } from "@/components/ds/help";

/**
 * Reference rates under the S2 composition editors (2026-08-01, operator request): typing a
 * negotiated rate needs an anchor — what would this room cost WITHOUT one? Reads
 * GET /api/entries/:id/rate-reference, which returns exactly the defaults the backend pricing
 * uses (agent/corporate card incl. per-type override, else the standard rate plan, plus the
 * card's extra-bed/meal add-ons and the standard rate + MSR floor). Display only — every
 * figure verbatim from the API, nothing computed here.
 */

/**
 * A rate on this strip is the anchor every negotiated figure below it is typed against, so it is
 * read, not squinted at ("UIappeal", 2026-09-29): the money in full ink and bold while the labels
 * around it stay quiet.
 */
const RATE: React.CSSProperties = { fontSize: 13.5, fontWeight: 700, color: "var(--ink, #1e1c19)", whiteSpace: "nowrap" };
/**
 * The MSR floor is a LIMIT, not a footnote: the house's minimum sellable rate for the type, and a
 * booking priced under it needs the GM's waiver (p19). It is drawn as a bounded chip so the eye
 * catches it, and the grid turns a room's rate red when it is typed below this figure.
 */
const FLOOR: React.CSSProperties = {
  display: "inline-block",
  padding: "1px 7px",
  borderRadius: 999,
  border: "1px solid var(--stop, #b3261e)",
  background: "var(--stop-t, #fbecea)",
  color: "var(--stop, #b3261e)",
  fontWeight: 700,
  fontSize: 12,
};

/** The add-on rate columns. Rendered only when at least one type carries a value — without a
 *  rate card they are ALL null, and four columns of dashes were most of the strip's noise. */
const ADD_ON_COLS = [
  ["extraBedRate", "Extra bed"],
  ["breakfastRate", "B'fast"],
  ["lunchRate", "Lunch"],
  ["dinnerRate", "Dinner"],
] as const;

/**
 * One line per room type (2026-10-29, operator: "is there a way this can be displayed differently
 * which takes less space"; and the room numbers it listed "shouldn't [show] unless a specified room
 * was picked"). The type, how many rooms of it the booking has — a room the guest asked for by
 * number named by its number, the system's rooms only counted — then each rate with its label, the
 * basis, and the MSR floor as a chip.
 */
export function RateReferenceStrip({
  entryId,
  compact,
  roomIds,
  quietNumbers,
}: {
  entryId: string;
  compact?: boolean;
  roomIds?: string[];
  /** Numbers of the rooms the system chose (they read "Standard Double · room 1" until Arrival) — counted, never named. */
  quietNumbers?: Set<string>;
}) {
  const { session } = useSession();
  const roomsKey = (roomIds ?? []).join(",");
  const query = useQuery({
    queryKey: roomsKey ? ["rate-reference", entryId, roomsKey] : ["rate-reference", entryId],
    queryFn: () => getRateReference(session!, entryId, roomIds),
    enabled: !!session,
    staleTime: 5 * 60_000,
  });

  const ref = query.data;
  if (!ref || ref.roomTypes.length === 0) return null;

  const pct = (rate: number) => `${(rate * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  const visibleAddOns = ADD_ON_COLS.filter(([key]) => ref.roomTypes.some((t) => t[key] != null));
  const roomsWord = (numbers: string[]) => {
    const named = numbers.filter((n) => !quietNumbers?.has(n));
    const counted = numbers.length - named.length;
    const parts = [
      ...(counted > 0 ? [`${counted} room${counted === 1 ? "" : "s"}`] : []),
      ...(named.length ? [`Room${named.length === 1 ? "" : "s"} ${named.join(", ")}`] : []),
    ];
    return parts.join(" · ") || "not on the booking";
  };

  return (
    <div
      style={{
        marginTop: compact ? 0 : 12,
        fontSize: 12,
        color: "var(--ink-3, #7a6a52)",
        border: "1px solid var(--line-2, #d9cdb8)",
        borderRadius: "var(--r-md, 10px)",
        background: "var(--cream, #faf6ee)",
        padding: "6px 12px",
      }}
    >
      {ref.roomTypes.map((t, i) => (
        <div
          key={t.roomTypeId}
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "baseline",
            gap: "2px 12px",
            padding: "4px 0",
            borderTop: i ? "1px dashed var(--line, #e3d9c8)" : undefined,
          }}
        >
          {i === 0 ? (
            <span style={{ display: "inline-flex", alignItems: "baseline", gap: 4, minWidth: 92 }}>
              <span className="rce-lbl">Rates a night</span>
              <Help label="About the reference rates">
                <p>What each room type sells at per night when no rate is negotiated — the figure a rate typed in the table is set against.</p>
                <p>
                  Service charge ({pct(ref.serviceChargeRate)}) and GST ({pct(ref.gstRate)}) are added on top.
                  {ref.party ? ` The rates are ${ref.party.name}'s ${ref.party.type === "TRAVEL_AGENT" ? "agency" : "company"} rates.` : ""}
                </p>
                <p>The rates are the house&rsquo;s published rates unless a rate package is named beside them.</p>
                <p>MSR is the lowest rate the house sells at — a room priced below it needs the GM&rsquo;s waiver.</p>
                {visibleAddOns.length === 0 ? <p>No extra-bed or meal rates are on file — those price at nothing unless negotiated in the table.</p> : null}
              </Help>
            </span>
          ) : (
            <span style={{ minWidth: 92 }} />
          )}
          <span style={{ minWidth: 150 }}>
            <b style={{ color: "var(--ink, #1e1c19)", fontSize: 13 }}>{t.name}</b>
            <span> · {roomsWord(t.roomNumbers)}</span>
          </span>
          <span>
            Room <b className="mono" style={RATE}>{moneyOrDash(t.roomRate, ref.currency)}</b>
          </span>
          {visibleAddOns.map(([key, label]) => (
            <span key={key}>
              {label} <b className="mono" style={RATE}>{moneyOrDash(t[key], ref.currency)}</b>
            </span>
          ))}
          {/* The basis only when it is not the house's own rates — a package's name, or no rate at all. */}
          {t.roomRateSource === "AGENT_RATE_PACKAGE" ? (
            <span>
              {t.packageName ?? "rate package"}
              {t.standardRate != null && <> · standard {moneyOrDash(t.standardRate, ref.currency)}</>}
            </span>
          ) : t.roomRateSource !== "STANDARD_RATE_PLAN" ? (
            <span>no rate on file</span>
          ) : null}
          {t.roomRateSource === "STANDARD_RATE_PLAN" && t.msrValue != null ? (
            <span
              className="mono"
              style={FLOOR}
              title="Minimum sellable rate — the house's floor for this room type. A booking priced below it needs the GM's waiver."
            >
              MSR {moneyOrDash(t.msrValue, ref.currency)}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

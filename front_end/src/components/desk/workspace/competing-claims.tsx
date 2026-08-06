"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { getCompetingClaims, type CompetingClaimItem } from "@/lib/api/entries";

/**
 * "Someone else is selling these rooms too" (2026-08-06, operator request).
 *
 * Two operators can work the same rooms for the same nights simultaneously — both can quote,
 * both can reach Set up and mint a proforma. The first COMMITTED HOLD wins the inventory
 * (Policy 26 enforces it); everything before that is paper. This banner surfaces the paper
 * early — on the Quote step before going to Set up, and on Set up itself — so the slower
 * booking learns about the race before taking the guest's money, not at the hold refusal.
 *
 * Advisory only: renders nothing when there is no competition. Auto-refreshes while mounted —
 * a race is precisely the situation where the picture changes under you.
 */

const KIND_LABEL: Record<CompetingClaimItem["kind"], string> = {
  RESERVED: "confirmed reservation",
  COMMITTED_HOLD: "committed hold",
  SPECULATIVE_HOLD: "speculative hold",
  PROFORMA_INVOICE: "proforma invoice",
  QUOTATION: "quotation",
};

/** Hard claims mean the race is effectively lost — these rooms are already taken. */
const HARD: CompetingClaimItem["kind"][] = ["RESERVED", "COMMITTED_HOLD"];

export function CompetingClaimsBanner({ entryId }: { entryId: string }) {
  const { session } = useSession();
  const query = useQuery({
    queryKey: ["competing-claims", entryId],
    queryFn: () => getCompetingClaims(session!, entryId),
    enabled: !!session,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const items = query.data?.items ?? [];
  if (items.length === 0) return null;

  const anyHard = items.some((i) => HARD.includes(i.kind));

  return (
    <div
      className="block"
      style={{
        borderColor: "var(--warn-t2, #e8c07a)",
        background: "var(--warn-t, #fdf6e3)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
        <AlertTriangle style={{ width: 14, height: 14, color: "var(--warn)" }} />
        <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>
          Another booking is working {items.length === 1 ? "this room" : "these rooms"} for the same dates
        </span>
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        {items.map((i) => (
          <div key={`${i.entryId}:${i.kind}`} style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.5 }}>
            <b>Room {i.roomNumbers.join(", ")}</b> · {KIND_LABEL[i.kind]}
            {i.documentId && <span className="mono"> {i.documentId}</span>}
            {i.dispatched && " (sent to the guest)"} · <span className="mono">{i.reference ?? i.entryId}</span>
            {i.guestName && <> — {i.guestName}</>}
            {i.currentStage && <span style={{ color: "var(--ink-3)" }}> · at {i.currentStage}</span>}
          </div>
        ))}
      </div>
      <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "7px 0 0", lineHeight: 1.5 }}>
        {anyHard ? (
          <>
            A hold or reservation already stands on {items.length === 1 ? "that room" : "those rooms"} — this
            booking will be refused at the committed hold. Change the room selection, or have a GM release
            theirs.
          </>
        ) : (
          <>
            Paper only so far, on both sides — <b>the first committed hold wins the rooms</b>. Coordinate
            before taking money: whoever places the hold at Set up first keeps them, and the other booking
            must re-select.
          </>
        )}
      </p>
    </div>
  );
}

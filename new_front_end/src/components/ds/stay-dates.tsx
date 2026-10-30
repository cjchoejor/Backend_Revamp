"use client";

import { fmtDmy } from "@/lib/ds/format";

/**
 * The stay's two dates as the hotel says them — "Check-in 27/10/2026 · Check-out 30/10/2026"
 * (2026-10-27, operator: "hotel people prefer check in and check out words better, make them
 * distinguishable"). Each date sits in its own box behind its own label, the check-in's label green
 * and the check-out's dark, so the two are told apart at a glance. Stay dates are calendar days, so
 * no time zone is involved.
 */
export function StayDates({ checkIn, checkOut }: { checkIn?: string | null; checkOut?: string | null }) {
  return (
    <span className="staydates">
      <span className="sd in">
        <span className="lbl">Check-in</span>
        <b>{fmtDmy(checkIn)}</b>
      </span>
      <span className="sd out">
        <span className="lbl">Check-out</span>
        <b>{fmtDmy(checkOut)}</b>
      </span>
    </span>
  );
}

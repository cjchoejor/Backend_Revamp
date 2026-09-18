"use client";

/**
 * What a cancellation would charge and refund, shown in the cancel dialog before the click that
 * cannot be undone (2026-09-18). The dialogs used to promise "the disclosed charge, if any, is
 * posted and the rest refunded" without a figure. Every number is the backend's preview — the same
 * computation the cancellation itself runs — so what the desk reads out is what happens.
 */
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { previewCancellation } from "@/lib/api/reservation-setup";
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
  return (
    <div className="notice inert" style={{ margin: "8px 0" }}>
      <span className="sm">
        Received <b className="money">{money(f.advanceReceived, cur)}</b> · charged{" "}
        <b className="money">{money(f.charge, cur)}</b>
        {f.waived && f.chargeCapped > 0 ? ` (the ${money(f.chargeCapped, cur)} charge waived)` : ""}
        {!f.waived && f.chargeBeforeCap > f.chargeCapped ? ` (the terms ask ${money(f.chargeBeforeCap, cur)} — never more than was received)` : ""} ·
        refunded <b className="money">{money(f.refund, cur)}</b>
      </span>
    </div>
  );
}

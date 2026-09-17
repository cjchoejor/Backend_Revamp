import { NotAvailableYet } from "@/design-system";

/** Handoffs across the hotel. Today a handoff is reached through its booking (Arrival, Stay). */
export default function HandoffsPage() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Handoffs</h2>
          <div className="meta">housekeeping, F&amp;B and the front desk · work passed between departments</div>
        </div>
      </div>
      <NotAvailableYet what="The hotel-wide board of open handoffs" />
      <p className="meta">Until then, a handoff is worked from its booking — Arrival for the room, Stay for the pre-checkout.</p>
    </div>
  );
}

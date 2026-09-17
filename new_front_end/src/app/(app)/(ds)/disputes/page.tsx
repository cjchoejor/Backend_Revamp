import { NotAvailableYet } from "@/design-system";

/** Disputes across the hotel. Today a dispute is opened and reviewed on its booking (Stay, Check-out). */
export default function DisputesPage() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Disputes</h2>
          <div className="meta">a charge a guest questions · open, in review, settled</div>
        </div>
      </div>
      <NotAvailableYet what="The list of open disputes across the hotel" />
      <p className="meta">Until then, a dispute is opened and reviewed on its booking — Stay and Check-out.</p>
    </div>
  );
}

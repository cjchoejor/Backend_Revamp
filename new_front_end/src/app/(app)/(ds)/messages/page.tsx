import { NotAvailableYet } from "@/design-system";

/** The hotel's inbox. Today what went to a guest, and their answer, is on each booking's side panel. */
export default function MessagesPage() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Messages</h2>
          <div className="meta">what came in from guests and agents, and what went out</div>
        </div>
      </div>
      <NotAvailableYet what="The hotel's inbox of guest and agent messages" />
      <p className="meta">Until then, every paper sent and the answer to it is listed on the booking, under “Papers sent”.</p>
    </div>
  );
}

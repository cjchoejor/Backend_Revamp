import { BackendView } from "@/components/desk/workspace/backend-view";

/** "Under the hood" — every policy, state machine, worker and timer behind one booking. */
export default async function BookingBackendPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="page">
      <div className="desk-root">
        <BackendView entryId={decodeURIComponent(id)} />
      </div>
    </div>
  );
}

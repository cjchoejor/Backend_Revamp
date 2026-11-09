import { BillPage } from "@/components/ds/bill-view";

export default async function BillRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BillPage entryId={decodeURIComponent(id)} />;
}

import { RefundsPage } from "@/components/ds/refunds-page";

export default async function RefundsRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RefundsPage entryId={decodeURIComponent(id)} />;
}

import { BackendView } from "@/components/desk/workspace/backend-view";

export default async function DeskBookingBackendPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <BackendView entryId={id} />;
}

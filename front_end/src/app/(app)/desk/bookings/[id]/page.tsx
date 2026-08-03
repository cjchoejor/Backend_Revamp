import { BookingWorkspace } from "@/components/desk/workspace/booking-workspace";

export default async function DeskBookingWorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <BookingWorkspace entryId={id} />;
}

import { Suspense } from "react";
import { DsWorkspace } from "@/components/ds/workspace/ds-workspace";

export default async function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The workspace reads ?step= and ?view= from the address, which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <DsWorkspace entryId={decodeURIComponent(id)} />
    </Suspense>
  );
}

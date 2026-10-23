import { Suspense } from "react";
import { redirect } from "next/navigation";
import { NewInquiryCanvas } from "@/components/ds/steps/new-inquiry";

/**
 * New booking — the intake in the redesigned frame (SS03 step 1, "looking is recording").
 * The old intake form (components/desk/inquiry/new-inquiry-form.tsx) is no longer mounted.
 *
 * `?edit=<entryId>` was a separate screen for changing a saved inquiry. It is gone (2026-10-12,
 * operator: "keep showing the stages even when editing") — the booking's Inquiry step edits the
 * caller, who is asking and the stay in place — so an old link lands there instead.
 */
export default async function NewBookingPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const { edit } = await searchParams;
  if (edit) redirect(`/bookings/${encodeURIComponent(edit)}?step=1`);
  return (
    <Suspense fallback={null}>
      <NewInquiryCanvas />
    </Suspense>
  );
}

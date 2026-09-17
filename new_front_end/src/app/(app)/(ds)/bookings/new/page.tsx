import { Suspense } from "react";
import { NewInquiryCanvas } from "@/components/ds/steps/new-inquiry";

/**
 * New booking — the intake in the redesigned frame (SS03 step 1, "looking is recording").
 * The old intake form (components/desk/inquiry/new-inquiry-form.tsx) is no longer mounted.
 */
export default function NewBookingPage() {
  // The canvas reads `?edit=` via useSearchParams, which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <NewInquiryCanvas />
    </Suspense>
  );
}

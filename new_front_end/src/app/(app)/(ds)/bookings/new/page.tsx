import { Suspense } from "react";
import { DeskNewInquiryForm } from "@/components/desk/inquiry/new-inquiry-form";

/**
 * New booking — the intake. Until its redesigned canvas lands (SS03 step 1, "looking is
 * recording"), the working intake form is used as it is, inside the new frame.
 */
export default function NewBookingPage() {
  // The form reads `?edit=` via useSearchParams, which needs a Suspense boundary.
  return (
    <div className="page">
      <div className="desk-root">
        <Suspense fallback={null}>
          <DeskNewInquiryForm />
        </Suspense>
      </div>
    </div>
  );
}

import { Suspense } from "react";
import { DeskNewInquiryForm } from "@/components/desk/inquiry/new-inquiry-form";

export default function DeskNewInquiryPage() {
  // DeskNewInquiryForm reads `?edit=` via useSearchParams, which requires a Suspense boundary
  // (otherwise `next build` fails prerendering this route).
  return (
    <Suspense fallback={null}>
      <DeskNewInquiryForm />
    </Suspense>
  );
}

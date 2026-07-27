"use client";

import { useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";

/**
 * Small "View PDF" button for the desk workspace. Given an async opener (from
 * `lib/api/documents`) it shows a spinner while the PDF is fetched + opened, and toasts on
 * failure. Used by the Quote (S2), Set-up/Proforma (S3), Confirm/Voucher (S4), Check-out and
 * Closed (S8/S9 invoice) steps.
 */
export function PdfButton({
  label = "View PDF",
  open,
  disabled,
}: {
  label?: string;
  open: () => Promise<void>;
  disabled?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      disabled={loading || disabled}
      onClick={async () => {
        setLoading(true);
        try {
          await open();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Could not open the PDF");
        } finally {
          setLoading(false);
        }
      }}
      title="Open the generated PDF in a new tab"
    >
      {loading ? <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> : <FileText style={{ width: 14, height: 14 }} />}
      {loading ? "Opening…" : label}
    </button>
  );
}

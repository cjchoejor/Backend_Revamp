"use client";

/**
 * How long this proforma stands (2026-11-05, operator: "proforma validity to function same as quote
 * where its validity will be till the check in time and same way for other cases like quotation").
 * The rule is the server's, the quote's own: to check-in in days, in hours when check-in is today, set
 * shorter but never longer. The paper prints it, so changing it on one already opened or sent makes a
 * new version, and the desk is told.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { Help } from "@/components/ds/help";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useSession } from "@/hooks/use-session";
import { getQuoteValidityWindow } from "@/lib/api/quotations";
import { setProformaValidity } from "@/lib/api/reservation-setup";
import { fmtDateTime } from "@/lib/ds/format";
import type { EntryDetail, InvoiceSummary, PaymentStatusSummary } from "@/types/api";
import { toastRefusal } from "./kit";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function ProformaValidity({
  entry,
  inv,
  status,
  editable,
  tz,
  onChanged,
}: {
  entry: EntryDetail;
  inv: InvoiceSummary;
  status: PaymentStatusSummary | undefined;
  editable: boolean;
  tz: string;
  onChanged: () => void;
}) {
  const { session } = useSession();
  const clock = useHotelClock(30_000);
  const windowQuery = useQuery({
    queryKey: ["quote-validity", entry.id, entry.checkInDate],
    queryFn: () => getQuoteValidityWindow(session!, entry.id),
    enabled: !!session && editable,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const win = windowQuery.data ?? null;
  const inHours = win?.mode === "HOURS";
  const unitMs = inHours ? HOUR_MS : DAY_MS;
  const unit = inHours ? "hour" : "day";
  const max = win?.max ?? 0;
  const left = inv.validUntil ? Math.ceil((new Date(inv.validUntil).getTime() - clock.now) / unitMs) : 0;
  const onFile = win ? (left >= 1 ? Math.min(left, max) : max) : null;

  const [count, setCount] = useState("");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched && onFile != null) setCount(String(onFile));
  }, [onFile, touched]);
  // A new version of the paper comes in with its own time.
  useEffect(() => setTouched(false), [inv.id]);

  const n = (() => {
    const v = Number(count);
    return win && count !== "" && Number.isInteger(v) && v >= 1 ? Math.min(v, max) : null;
  })();
  const changed = n != null && (n !== onFile || !inv.validUntil);
  const printed = !!inv.pdfStorageKey || !!inv.dispatchedAt;

  const save = useMutation({
    mutationFn: () => setProformaValidity(session!, inv.id, inHours ? { validHours: n! } : { validDays: n! }),
    onSuccess: (r) => {
      toast.success(r.madeAgain ? "A new version is made with this time, not sent" : "The proforma's time is set");
      setTouched(false);
      onChanged();
    },
    onError: (e) => toastRefusal(e, "The proforma's time could not be set"),
  });

  // The advance asked is in: nothing is left for the guest to answer, so it no longer runs out.
  if (status && status.requiredAmount > 0 && status.paidInFull) {
    return <div className="sm pf-valid-line">The advance is paid, so this proforma no longer runs out.</div>;
  }
  if (!editable) {
    return inv.validUntil ? <div className="sm pf-valid-line">Valid until {fmtDateTime(inv.validUntil, tz)}</div> : null;
  }
  const until = changed ? clock.now + n! * unitMs : inv.validUntil ? new Date(inv.validUntil).getTime() : null;

  return (
    <div className="pf-valid">
      <span className="lbl">Proforma valid for</span>
      <span className={`stepper${win && n == null ? " bad" : ""}`}>
        <button
          type="button"
          aria-label={`One ${unit} less`}
          disabled={n == null || n <= 1}
          onClick={() => {
            setCount(String(Math.max(1, (n ?? 2) - 1)));
            setTouched(true);
          }}
        >
          −
        </button>
        <input
          inputMode="numeric"
          aria-label={`Proforma valid for, in ${unit}s`}
          value={count}
          readOnly={!win}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, "");
            setCount(v !== "" && Number(v) > max ? String(max) : v);
            setTouched(true);
          }}
        />
        <span className="unit">{n === 1 ? unit : `${unit}s`}</span>
        <button
          type="button"
          aria-label={`One ${unit} more`}
          disabled={(n ?? max) >= max}
          onClick={() => {
            setCount(String(Math.min(max, (n ?? 0) + 1)));
            setTouched(true);
          }}
        >
          +
        </button>
      </span>
      <span className={`until${win && n == null ? " stop-ink" : ""}`}>
        {!win ? null : n == null ? (
          `Enter 1 to ${max}`
        ) : until != null ? (
          <>
            until <b>{fmtDateTime(new Date(until).toISOString(), tz)}</b>
          </>
        ) : null}
      </span>
      <Help label="About how long the proforma is valid">
        A proforma stands until check-in at the latest, or for the rest of today when check-in is today. It can be set shorter, not longer. When its time ends the booking stays as it is: make it again, then it can go out and the booking can move on.
      </Help>
      {changed ? (
        <Button className="go" compact state={save.isPending ? "working" : "default"} workingLabel="Setting…" onClick={() => save.mutate()}>
          Set this time
        </Button>
      ) : null}
      {changed && printed ? <span className="sm warn-ink pf-valid-line">The paper prints it, so a new version is made, to send again.</span> : null}
    </div>
  );
}

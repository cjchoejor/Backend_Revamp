"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/design-system";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import { money } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { StageActs, WorkPopup } from "./kit";

/** The section the step's list names for the advance; picking it opens Payments instead. */
export const PAYMENTS_CARD = "advance";

/**
 * Open the step's Payments (2026-11-07). The step line's list and any line that points at the
 * advance send this; the button below answers it. The workspace's own `goToCard` sends it first
 * and scrolls only when nothing answered.
 */
export function openPayments(): boolean {
  if (typeof window === "undefined") return false;
  return !window.dispatchEvent(new CustomEvent("desk:go-to-card", { detail: PAYMENTS_CARD, cancelable: true }));
}

/**
 * PAYMENTS on the step line, beside Change booking (2026-11-07, operator: "the advance section here
 * in s4 to be moved to menu buttons, maybe with a name as payments"; the same at Arrival). The
 * advance opens in a pop-up over the work, the booking file clear beside it.
 *
 * The button says what is still to do, in the server's own figures: the money still to come, even
 * while credit covers it (amber, red once the check-in it was due by has come); at a step that needs
 * the advance signed off (`signOffHere`), "to sign off" until it is; then whatever the step adds
 * (`alsoDue`).
 */
export function PaymentsButton({
  entry,
  signOffHere = false,
  alsoDue = null,
  children,
}: {
  entry: EntryDetail;
  signOffHere?: boolean;
  alsoDue?: string | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const payment = usePaymentStatus(entry.id, { enabled: !!entry.folio });
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== PAYMENTS_CARD) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("desk:go-to-card", on);
    return () => window.removeEventListener("desk:go-to-card", on);
  }, []);
  if (!entry.folio) return null;
  const st = payment.data;
  // What is still to come, even while the FOM's credit covers it — the money is still owed.
  const toCome = st && Number(st.shortfall) > 0 ? st.shortfall : null;
  const late = toCome != null && !!st?.advanceWindow?.overdue;
  const signOff = signOffHere && entry.folio.advancePaymentReconciliationComplete !== true;
  const due = toCome != null ? `${money(toCome)} to come` : signOff ? "to sign off" : alsoDue;
  const title =
    toCome != null
      ? `${money(toCome)} of the advance is still to come${st?.satisfied ? " — the FOM's credit covers it for now" : ""}${late ? " — it was due by check-in" : ""}`
      : signOff
        ? "The advance is not signed off yet — check-in waits for it"
        : alsoDue ?? undefined;
  return (
    <>
      <StageActs>
        <Button kind="secondary" className={due ? `stage-pay${late ? " late" : ""}` : undefined} onClick={() => setOpen(true)} title={title}>
          Payments
          {due ? <span className="pay-n">{due}</span> : null}
        </Button>
      </StageActs>
      <WorkPopup open={open} title="Payments" onClose={() => setOpen(false)}>
        {children}
      </WorkPopup>
    </>
  );
}

/**
 * Why a re-entry that would strand an in-house guest is refused (2026-10-26).
 *
 * Once the guest is checked in the folio is LIVE, and a LIVE folio can never go back to
 * PROVISIONAL. The way forward from Inquiry, Negotiation or Reserve needs a provisional folio at
 * Arrival → Check-in and again at check-in, so a booking sent back from Stay or Check-out could
 * never return to where the guest is. Every route that would do it refuses with these words.
 *
 * `instead` says what to do; it defaults to putting a price right on the bill.
 */
export function strandedInHouse(step: "Stay" | "Check-out", what: string, instead?: string): string {
  const doing = step === "Stay" ? "staying" : "checking out";
  const fix =
    instead ??
    (step === "Stay"
      ? "A credit note or a charge correction on the bill puts a price right in the meantime."
      : "A credit note or a charge correction on the bill puts a price right, and a dispute records what the guest disagrees with.");
  return `While the guest is ${doing}, ${what} can't send the booking back to an earlier step — it would leave the guest with no way back to ${step}. ${fix}`;
}

"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getPaymentStatus } from "@/lib/api/reservation-setup";

/**
 * The backend's authoritative advance-payment position for one booking
 * (`GET /api/entries/:id/payment-status`).
 *
 * This is the ONLY source of "how much has the guest paid" on the desk. The figure is summed
 * server-side in Decimal — summing the folio's payment rows in the browser drifts (three partial
 * payments of exactly 5000 once totalled 4999.999999999999 and blocked a check-in), and it also
 * misses the FOM credit-extension path that the server counts as satisfying the advance.
 *
 * Shares the `["payment-status", entryId]` query key with the Set-up step and the workspace gate,
 * so all three read one cached response and a payment recorded anywhere refreshes every consumer.
 */
export function usePaymentStatus(entryId: string | null | undefined, opts?: { enabled?: boolean }) {
  const { session, isLoading } = useSession();
  return useQuery({
    queryKey: ["payment-status", entryId],
    queryFn: () => getPaymentStatus(session!, entryId!),
    enabled: !!session && !isLoading && !!entryId && opts?.enabled !== false,
    // A booking with no folio yet 404s — that's an expected state, not a fault worth retrying.
    retry: false,
  });
}

import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * SIG-S4 §1.5 slice — W4 must not advance an entry to S5 without a committed **Reservation** snapshot from S4.
 */
export function enforceReservationSnapshotPresentForS5Activation(input: { reservation: { id: string } | null | undefined }) {
  if (input.reservation?.id) return;
  throw new StageGateBlockedError("Reservation snapshot required before pre-arrival activation (S4→S5)", "MISSING_RESERVATION");
}

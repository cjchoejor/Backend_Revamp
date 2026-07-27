import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 52 — Communication / acknowledgement tracking (SIG-S6 VIP slice).
 * VIP-tier check-in completion requires a persisted `VIPArrivalNotificationEvent` for the entry.
 */
export function enforceVipArrivalNotificationRecordedForCheckInCompletion(input: {
  vipTier: string | null | undefined;
  hasVipArrivalNotification: boolean;
}) {
  const tier = input.vipTier?.trim();
  if (!tier) return;
  if (input.hasVipArrivalNotification) return;
  throw new StageGateBlockedError("VIP Arrival notification must be issued for VIP check-in", "VIP_NOTIFICATION_NOT_ISSUED");
}

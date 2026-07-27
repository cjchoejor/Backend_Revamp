import { ValidationError } from "../../lib/errors.js";

/**
 * Policy 71 — Processing Lock TTL Policy
 * SIG-S1/S2/S4/S5/S6: TTL is unconditional and sourced from `processingLock.ttl.perChannel`.
 */
export function resolveProcessingLockTtlSeconds(input: { ttlMap: Record<string, number>; channel: string }): number {
  const ttlSeconds = Number(input.ttlMap[input.channel]);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 1) {
    throw new ValidationError(`processingLock.ttl.perChannel missing/invalid for channel ${input.channel}`);
  }
  return ttlSeconds;
}


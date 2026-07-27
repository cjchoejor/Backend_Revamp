import { InventoryClaimState, Prisma } from "@prisma/client";

/**
 * Centralised room-claim-state transition helper.
 *
 * `Room.currentClaimState` is the source of truth for "is this room bookable right now?"
 * (SIG-S3 §Policy 26). Every stage transition that changes a room's status — hold placement,
 * check-in, checkout, cancellation, no-show finalisation, expiry, closure — must update it,
 * and every update must emit a `RoomClaimStateEvent` for the audit trail (ACIG §3.4).
 *
 * Historically every site open-coded the update-plus-audit pair. That caused three
 * classes of bug documented in the 2026-07-25 gap analysis:
 *
 *  1. **State stuck non-FREE** — cancel / expiry / no-show paths that forgot to release the
 *     room at all (W3 multi-room, W5 no-show, no-show FOM, S1 expire, S9 closure, S8→S7 re-entry).
 *  2. **Multi-room leaks** — sites that released only `hold.roomId` and ignored
 *     `perNightBreakdown` from the sealed availability configuration.
 *  3. **Audit lies** — sites that hardcoded `fromState` instead of reading it from the row,
 *     so the audit trail didn't match reality on retries or partial states.
 *
 * This module offers two entry points that fix all three at once:
 *
 *  - `transitionRoomClaimState` — single-room, idempotent, reads real `fromState`.
 *  - `releaseEntryRoomsToFree` — multi-room; walks every room the entry references
 *    (via `RoomAssignment` + `CommittedHold.roomId` + `CommittedHold.perNightBreakdown`)
 *    and puts each back to `FREE`. Used by every cancellation / expiry / closure path.
 *
 * Both take a `TransactionClient` — callers MUST invoke them inside an existing
 * `prisma.$transaction` so the room update, audit row, and their own entity write commit
 * together. Passing a plain `PrismaClient` typechecks but breaks the atomicity contract.
 */

type TxClient = Prisma.TransactionClient;

export type ClaimTransitionResult = {
  transitioned: boolean;
  /** The row's state before this call. `null` if the room was not found. */
  fromState: InventoryClaimState | null;
  toState: InventoryClaimState;
  /** True when `skipIfSameState` matched — we did nothing. */
  skippedSameState?: boolean;
};

export type TransitionInput = {
  roomId: string;
  toState: InventoryClaimState;
  actorId: string;
  /** For attribution — which entry drove this transition. Optional (SYSTEM / admin work). */
  entryId?: string | null;
  /** Machine-readable reason for the audit row (e.g. `"S3_PRE_CONFIRMATION_CANCELLATION"`). */
  reason: string;
  /**
   * Restrict the transition to specific starting states. When set, the update is skipped
   * (returns `transitioned: false`) if the current state isn't in the list. Use when
   * you want to be defensive against races (e.g., only put a CONFIRMED room to OCCUPIED,
   * not a fresh S1 room that some other path just placed a hold on).
   *
   * Undefined = accept any current state. Prefer undefined for release-to-FREE paths so
   * the helper cleans up whatever the actual stuck state was.
   */
  onlyFromStates?: InventoryClaimState[];
  now?: Date;
};

/**
 * Transition ONE room's claim state. Reads the actual current state (no hardcoded
 * `fromState`), writes the update, and emits the audit event — all in `tx`.
 *
 * Idempotent: if the room is already at `toState`, does nothing and returns
 * `{ transitioned: false, skippedSameState: true }`. Safe to call from retry-able workers.
 *
 * When `onlyFromStates` doesn't match, returns `{ transitioned: false }` without erroring —
 * the caller decides whether that's noteworthy.
 */
export async function transitionRoomClaimState(tx: TxClient, input: TransitionInput): Promise<ClaimTransitionResult> {
  const now = input.now ?? new Date();
  const row = await tx.room.findUnique({ where: { id: input.roomId }, select: { currentClaimState: true } });
  if (!row) return { transitioned: false, fromState: null, toState: input.toState };

  const fromState = row.currentClaimState;
  if (fromState === input.toState) {
    return { transitioned: false, fromState, toState: input.toState, skippedSameState: true };
  }
  if (input.onlyFromStates && !input.onlyFromStates.includes(fromState)) {
    return { transitioned: false, fromState, toState: input.toState };
  }

  await tx.room.update({
    where: { id: input.roomId },
    data: { currentClaimState: input.toState, updatedAt: now },
  });
  await tx.roomClaimStateEvent.create({
    data: {
      roomId: input.roomId,
      entryId: input.entryId ?? null,
      fromState,
      toState: input.toState,
      actorId: input.actorId,
      reason: input.reason,
      effectiveFrom: now,
    },
  });
  return { transitioned: true, fromState, toState: input.toState };
}

/**
 * Collect every room this entry currently references, from three sources:
 *  1. `RoomAssignment` rows (post-check-in physical assignment)
 *  2. `CommittedHold.roomId` (legacy single-room hold pointer)
 *  3. `CommittedHold.perNightBreakdown` (multi-room sealed selection snapshot,
 *     populated by `s3-hold-service.placeCommittedHold` since 2026-07-13)
 *
 * Deduped. This is the pattern that every cancellation / expiry / closure needs
 * — releasing only `hold.roomId` leaks rooms 2..N of any multi-room booking.
 */
export async function collectRoomsHeldByEntry(tx: TxClient, entryId: string): Promise<string[]> {
  const [assignments, hold] = await Promise.all([
    tx.roomAssignment.findMany({ where: { entryId }, select: { roomId: true } }),
    tx.committedHold.findUnique({
      where: { entryId },
      select: { roomId: true, perNightBreakdown: true },
    }),
  ]);
  const ids = new Set<string>();
  for (const a of assignments) ids.add(a.roomId);
  if (hold?.roomId) ids.add(hold.roomId);
  const breakdown = (hold?.perNightBreakdown ?? null) as
    | Array<{ date?: string; roomIds?: Array<{ roomId?: string }> }>
    | null;
  if (Array.isArray(breakdown)) {
    for (const n of breakdown) {
      for (const r of n.roomIds ?? []) {
        if (typeof r?.roomId === "string") ids.add(r.roomId);
      }
    }
  }
  return Array.from(ids);
}

/**
 * Release EVERY room this entry holds back to `FREE`, from any starting state.
 *
 * Used by cancellations (S3/S5/S7), no-show finalisation (auto + FOM), S1 expiry,
 * S9 closure, and W3 hold expiry. Idempotent — rooms already FREE are skipped and
 * do not generate audit noise.
 *
 * Returns which rooms were touched and how many actually transitioned so the
 * caller can log the outcome.
 */
export async function releaseEntryRoomsToFree(
  tx: TxClient,
  input: { entryId: string; actorId: string; reason: string; now?: Date },
): Promise<{ inspected: string[]; transitioned: number }> {
  const now = input.now ?? new Date();
  const roomIds = await collectRoomsHeldByEntry(tx, input.entryId);
  let transitioned = 0;
  for (const roomId of roomIds) {
    const result = await transitionRoomClaimState(tx, {
      roomId,
      toState: InventoryClaimState.FREE,
      actorId: input.actorId,
      entryId: input.entryId,
      reason: input.reason,
      now,
    });
    if (result.transitioned) transitioned += 1;
  }
  return { inspected: roomIds, transitioned };
}

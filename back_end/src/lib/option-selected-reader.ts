/**
 * Backend reader for `AvailabilityConfiguration.optionSelected`. The JSON blob supports three
 * shapes (see `docs/SIG-S1-*` and the frontend counterpart in `types/api.ts`):
 *
 *   1) Legacy single-room seal — `{ roomId: string; isDeficient?: boolean }`
 *   2) Whole-stay multi-room seal — `{ roomIds: Array<{ roomId, isDeficient }>; isDeficient? }`
 *   3) Per-night seal — `{ perNight: Array<{ date, roomIds: [{ roomId, isDeficient }] }>; isDeficient? }`
 *
 * This module exists so backend code doesn't have to type-check the three shapes at every
 * consumer site. Callers pass in the raw `optionSelected` value from Prisma (a JsonValue)
 * and get back a normalised view: a distinct room-id set, a per-night breakdown when
 * available, and helpers to answer "how many rooms is this booking" and "what's the
 * representative room-id we can look up a roomType from".
 *
 * BUSINESS-LOGIC HOME: all room-shape reasoning happens here so downstream services stay
 * shape-agnostic. Frontend consumers shouldn't need to replicate this logic — they get
 * either a normalised response from a service (preferred) or use the same
 * `optionSelectedRoomIds` helper on the frontend for pure display.
 */

export type OptionSelectedNormalised = {
  /** Distinct room ids across the whole seal, deduped. Empty when opt is null. */
  distinctRoomIds: string[];
  /**
   * Explicit per-night breakdown when the seal was per-night. `null` when the seal was
   * whole-stay or single-room — those seals use the same rooms every night by construction.
   * Callers that need per-night data (billing per-night at S3, room-change amendments)
   * consult this; callers that need whole-stay data (agent rate, standard nightly rate)
   * just use `distinctRoomIds.length` or `firstRoomId()`.
   */
  perNight: Array<{ date: string; roomIds: string[] }> | null;
  /** True when any room in any shape has isDeficient === true. */
  anyDeficient: boolean;
};

/**
 * Parse the raw JSON from Prisma into a normalised shape. Returns an empty result for null
 * / malformed input so callers can safely rely on the fields without null-checking each one.
 */
export function readOptionSelected(opt: unknown): OptionSelectedNormalised {
  const empty: OptionSelectedNormalised = { distinctRoomIds: [], perNight: null, anyDeficient: false };
  if (!opt || typeof opt !== "object" || Array.isArray(opt)) return empty;
  const anyOpt = opt as Record<string, unknown>;

  // Case 1: legacy single-room seal.
  if (typeof anyOpt.roomId === "string") {
    return {
      distinctRoomIds: [anyOpt.roomId],
      perNight: null,
      anyDeficient: anyOpt.isDeficient === true,
    };
  }

  // Case 3: per-night seal (check before whole-stay so we don't miss the perNight branch when
  // a caller mistakenly puts both fields on the object).
  if (Array.isArray(anyOpt.perNight)) {
    const nights = anyOpt.perNight as Array<{ date?: string; roomIds?: Array<{ roomId?: string; isDeficient?: boolean }> }>;
    const distinct = new Set<string>();
    let anyDef = anyOpt.isDeficient === true;
    const perNight: Array<{ date: string; roomIds: string[] }> = [];
    for (const n of nights) {
      if (typeof n?.date !== "string" || !Array.isArray(n.roomIds)) continue;
      const nightRoomIds: string[] = [];
      for (const r of n.roomIds) {
        if (typeof r?.roomId !== "string") continue;
        distinct.add(r.roomId);
        nightRoomIds.push(r.roomId);
        if (r.isDeficient === true) anyDef = true;
      }
      perNight.push({ date: n.date, roomIds: nightRoomIds });
    }
    return { distinctRoomIds: Array.from(distinct), perNight, anyDeficient: anyDef };
  }

  // Case 2: whole-stay multi-room seal.
  if (Array.isArray(anyOpt.roomIds)) {
    const rows = anyOpt.roomIds as Array<{ roomId?: string; isDeficient?: boolean }>;
    const distinct: string[] = [];
    let anyDef = anyOpt.isDeficient === true;
    for (const r of rows) {
      if (typeof r?.roomId !== "string") continue;
      distinct.push(r.roomId);
      if (r.isDeficient === true) anyDef = true;
    }
    return { distinctRoomIds: distinct, perNight: null, anyDeficient: anyDef };
  }

  return empty;
}

/**
 * Convenience: the first distinct roomId, or undefined when the seal is empty. Callers that
 * only need a room to look up a `roomTypeId` (S2 quotation, agent rate resolution) use this.
 * Room-type is the same for whole-stay AND per-night seals since our current pricing engine
 * doesn't yet vary rate plans by night — that's a next-phase concern.
 */
export function firstRoomId(normalised: OptionSelectedNormalised): string | undefined {
  return normalised.distinctRoomIds[0];
}

export type SealNight = { date: string; roomIds: Array<{ roomId: string; isDeficient: boolean }> };

/**
 * The seal spelled out night by night, in the holds' snapshot shape (2026-10-12).
 *
 * A per-night seal is copied as it is. A whole-stay or single-room seal — the same rooms every
 * night — is spelled out over the stay's nights. Without that, a hold placed on such a seal kept
 * no snapshot, and a hold with no snapshot counts only its anchor room (`committedHoldSpans`), so
 * the seal's other rooms stayed sellable to anyone while the screen said they were marked. Null
 * when there is no seal, or no stay to spell a whole-stay seal over.
 */
export function sealAsPerNight(opt: unknown, stay: { checkIn: Date | null | undefined; checkOut: Date | null | undefined }): SealNight[] | null {
  if (!opt || typeof opt !== "object" || Array.isArray(opt)) return null;
  const o = opt as Record<string, unknown>;
  const asRoom = (r: unknown) => {
    const x = r as { roomId?: unknown; isDeficient?: unknown } | null;
    return typeof x?.roomId === "string" ? { roomId: x.roomId, isDeficient: x.isDeficient === true } : null;
  };
  if (Array.isArray(o.perNight)) {
    const out: SealNight[] = [];
    for (const n of o.perNight as Array<{ date?: unknown; roomIds?: unknown }>) {
      if (typeof n?.date !== "string" || !Array.isArray(n.roomIds)) continue;
      out.push({ date: n.date.slice(0, 10), roomIds: (n.roomIds as unknown[]).map(asRoom).filter((r): r is { roomId: string; isDeficient: boolean } => !!r) });
    }
    return out.length ? out : null;
  }
  const rooms = Array.isArray(o.roomIds)
    ? (o.roomIds as unknown[]).map(asRoom).filter((r): r is { roomId: string; isDeficient: boolean } => !!r)
    : typeof o.roomId === "string"
      ? [{ roomId: o.roomId, isDeficient: o.isDeficient === true }]
      : [];
  if (rooms.length === 0 || !stay.checkIn || !stay.checkOut) return null;
  const out: SealNight[] = [];
  const end = Date.UTC(stay.checkOut.getUTCFullYear(), stay.checkOut.getUTCMonth(), stay.checkOut.getUTCDate());
  for (
    let t = Date.UTC(stay.checkIn.getUTCFullYear(), stay.checkIn.getUTCMonth(), stay.checkIn.getUTCDate()), i = 0;
    t < end && i < 366;
    t += 86_400_000, i++
  ) {
    out.push({ date: new Date(t).toISOString().slice(0, 10), roomIds: rooms.map((r) => ({ ...r })) });
  }
  return out.length ? out : null;
}

"use client";

/**
 * Pieces Negotiation and Set up share: the race telltale (another booking working the same rooms
 * for the same nights), the pass a paper belongs to, room numbers by id, and the hotel-clock
 * conversion a typed date-and-time needs.
 *
 * Nothing here adds money up. The competing claims are the backend's own read
 * (`GET /api/entries/:id/competing-claims`); the hold that decides the race is still Policy 26.
 */
import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Chip } from "@/design-system";
import { bookingHref } from "@/components/ds/ui";
import { useSession } from "@/hooks/use-session";
import { getCompetingClaims, type CompetingClaimItem } from "@/lib/api/entries";
import { listRooms } from "@/lib/api/rooms";
import { STEP_NAMES, stepNoOfStage } from "@/lib/ds/steps";
import type { EntryDetail } from "@/types/api";
import { StepCard, useStepMode } from "./kit";

/** Who an authority level is, in the desk's words. */
export const LEVEL_WORD: Record<string, string> = {
  L1: "the front desk",
  L2: "the FOM",
  L3: "the GM",
  L4: "the administrator",
};

/* ------------------------------------------------------------------ rooms */

/** Room id → room number, from the house's room list (the same `["rooms"]` read Inquiry uses). */
export function useRoomNumbers(): Map<string, string> {
  const { session } = useSession();
  const rooms = useQuery({
    queryKey: ["rooms"],
    queryFn: () => listRooms(session!),
    enabled: !!session,
  });
  return useMemo(() => new Map((rooms.data?.items ?? []).map((r) => [r.id, r.roomNumber])), [rooms.data]);
}

/** "Room 201" · "Rooms 201, 202" — numbers sorted the way the house counts them. */
export function roomsWord(ids: string[], numbers: Map<string, string>): string {
  const nos = ids
    .map((id) => numbers.get(id))
    .filter((n): n is string => !!n)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  if (nos.length === 0) return ids.length === 1 ? "1 room" : `${ids.length} rooms`;
  return `${nos.length === 1 ? "Room" : "Rooms"} ${nos.join(", ")}`;
}

/* ------------------------------------------------------------------ passes */

/**
 * The booking's passes. A re-entry seals the pass being worked and opens the next; papers carry
 * no pass of their own, so one is attributed to the pass whose window contains its creation —
 * the same time-windowing the backend's pass history uses.
 */
export function passesOf(entry: EntryDetail) {
  const segs = [...(entry.segments ?? [])].sort((a, b) => (b.segmentNumber ?? 0) - (a.segmentNumber ?? 0));
  const current = segs[0] ?? null;
  const numberById = new Map(segs.map((s) => [s.id, s.segmentNumber]));
  const numberAt = (iso: string): number | null => {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return null;
    const hit = segs.find((s) => {
      const start = s.startedAt ? new Date(s.startedAt).getTime() : Number.NEGATIVE_INFINITY;
      const end = s.sealedAt ? new Date(s.sealedAt).getTime() : Number.POSITIVE_INFINITY;
      return t >= start && t < end;
    });
    return hit?.segmentNumber ?? null;
  };
  return {
    current,
    currentNumber: current?.segmentNumber ?? null,
    startedAt: current?.startedAt ?? null,
    numberById,
    numberAt,
    many: segs.length > 1,
  };
}

/* ------------------------------------------------------------------ the hotel's clock */

function tzOffsetMs(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return wall - utcMs;
}

/**
 * A `datetime-local` value is typed on the HOTEL's clock, whatever zone this machine is set to —
 * "Friday 5 PM" means 5 PM in Thimphu. Returns the instant, or null when the value is incomplete.
 */
export function hotelLocalToIso(local: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  let utc = wall - tzOffsetMs(wall, tz);
  utc = wall - tzOffsetMs(utc, tz);
  return new Date(utc).toISOString();
}

/** An instant as the `datetime-local` value the hotel's clock shows for it. */
export function isoToHotelLocal(value: string | number | Date | null | undefined, tz: string): string {
  if (value === null || value === undefined || value === "") return "";
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + tzOffsetMs(ms, tz)).toISOString().slice(0, 16);
}

/* ------------------------------------------------------------------ the race */

const CLAIM_WORD: Record<CompetingClaimItem["kind"], string> = {
  RESERVED: "reserved",
  COMMITTED_HOLD: "held",
  SPECULATIVE_HOLD: "marked",
  PROFORMA_INVOICE: "a proforma",
  QUOTATION: "a quotation",
};

const HARD: ReadonlyArray<CompetingClaimItem["kind"]> = ["RESERVED", "COMMITTED_HOLD"];

/** The competing markers alone — for the provisional-block line (reference only, never a name). */
export function useCompetingClaims(entryId: string) {
  const { session } = useSession();
  return useQuery({
    queryKey: ["competing-claims", entryId],
    queryFn: () => getCompetingClaims(session!, entryId),
    enabled: !!session,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

/**
 * "Another booking is working these rooms" — advisory. The first committed hold wins the rooms;
 * until then everything is paper, and this is where the slower booking learns it before money is
 * taken. Names the other booking by its reference, never by its guest (SS03 §5.4).
 */
export function CompetingClaimsCard({ entryId }: { entryId: string }) {
  const { past } = useStepMode();
  const claims = useCompetingClaims(entryId);
  const items = claims.data?.items ?? [];
  if (past || items.length === 0) return null;
  const anyHard = items.some((i) => HARD.includes(i.kind));
  return (
    <StepCard
      title={`Another booking is working ${items.length === 1 && items[0].roomNumbers.length === 1 ? "this room" : "these rooms"}`}
      icon="alert"
      right={<Chip tone={anyHard ? "danger" : "warning"}>{anyHard ? "already taken" : "first to hold wins"}</Chip>}
    >
      <table className="table compact">
        <thead>
          <tr>
            <th>Rooms</th>
            <th>What they have</th>
            <th>Booking</th>
            <th>At</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={`${i.entryId}:${i.kind}:${i.documentId ?? ""}`} className="static">
              <td>{i.roomNumbers.join(", ")}</td>
              <td>
                {CLAIM_WORD[i.kind]}
                {i.documentId ? <span className="sub">{i.documentId}</span> : null}
                {i.dispatched ? <span className="sub">sent to their guest</span> : null}
              </td>
              <td>
                <Link href={bookingHref(i.entryId)}>{i.reference ?? i.entryId}</Link>
              </td>
              <td>{STEP_NAMES[stepNoOfStage(i.currentStage) - 1]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="meta" style={{ marginTop: 8 }}>
        {anyHard
          ? "A hold or a reservation already stands on these nights — this booking will be refused at the committed hold. Change the rooms at Inquiry, or ask the GM to release theirs."
          : "Nobody holds these nights yet. Whoever places the committed hold first takes the rooms — the other booking is refused then, not before."}
      </p>
    </StepCard>
  );
}

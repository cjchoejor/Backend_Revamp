"use client";

/**
 * Rooms (Surface Spec 00 §2) — for knowing, not choosing. Every room's commercial standing and its
 * physical state, kept apart (FIG 1.14), and every hall. A tile opens the fault record: the desk
 * reports, the FOM verifies, and a room or hall with a fault leaves the pool the moment it is
 * reported.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Button, Dialog, EmptyState, RoomTile, type RoomPhysical, type RoomStanding } from "@/design-system";
import { LoadFailed, LoadingBlock } from "@/components/ds/ui";
import { DeficiencyPanel } from "@/components/deficiency/deficiency-panel";
import { useDeskBookings, useRoomsList } from "@/hooks/use-desk-data";
import { useSession } from "@/hooks/use-session";
import { listSpaces, type RoomListItem, type SpaceListItem } from "@/lib/api/rooms";
import { guestNameOf } from "@/lib/ds/status";
import { stepNoOfStage } from "@/lib/ds/steps";

function standingOfRoom(r: RoomListItem): RoomStanding {
  if (r.isUnderMaintenance || r.isBlocked) return "ooo";
  switch ((r.currentClaimState ?? "FREE").toUpperCase()) {
    case "OCCUPIED":
      return "occupied";
    case "CONFIRMED":
      return "reserved";
    case "COMMITTED_HELD":
      return "committed-held";
    case "SPECULATIVELY_HELD":
      return "speculatively-held";
    default:
      return r.isDeficient ? "deficient" : "free";
  }
}

function physicalOfRoom(r: RoomListItem): RoomPhysical | undefined {
  if (r.isBlocked) return "blocked";
  if (r.isUnderMaintenance) return "out-of-order";
  const claim = (r.currentClaimState ?? "").toUpperCase();
  const ps = (r.physicalState ?? "").toUpperCase();
  if (claim === "DEPARTED_DIRTY" || ps === "DIRTY") return "needs-cleaning";
  if (ps === "AVAILABLE_INSPECTED") return "inspected";
  if (ps === "AVAILABLE_CLEAN" || claim === "DEPARTED_CLEAN") return "clean";
  if (ps === "UNDER_MAINTENANCE") return "out-of-order";
  return undefined;
}

const BED_WORD: Record<string, string> = { KING: "King", TWIN: "Twin", QUEEN: "Queen", SINGLE: "Single" };

type Target = { kind: "room"; id: string; label: string } | { kind: "space"; id: string; label: string };

export default function RoomsPage() {
  const { session, isLoading } = useSession();
  const queryClient = useQueryClient();
  const rooms = useRoomsList();
  const bookings = useDeskBookings();
  const spaces = useQuery({
    queryKey: ["spaces"],
    queryFn: () => listSpaces(session!),
    enabled: !!session && !isLoading,
  });
  const [target, setTarget] = useState<Target | null>(null);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setTarget(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [target]);

  const items = useMemo(
    () => [...(rooms.data?.items ?? [])].sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, "en", { numeric: true })),
    [rooms.data],
  );

  // Who is in each room tonight, and who holds it next — names only, from the bookings list.
  const occupant = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of bookings.data?.items ?? []) {
      const step = stepNoOfStage(b.currentStage);
      if (b.status !== "ACTIVE" || step < 4 || step > 8) continue;
      for (const n of b.roomNumbers) {
        if (step >= 6 || !m.has(n)) m.set(n, guestNameOf(b.guestProfile));
      }
    }
    return m;
  }, [bookings.data]);

  const count = (pred: (r: RoomListItem) => boolean) => items.filter(pred).length;
  const occupied = count((r) => standingOfRoom(r) === "occupied");
  const held = count((r) => ["reserved", "committed-held", "speculatively-held"].includes(standingOfRoom(r)));
  const out = count((r) => !!(r.isBlocked || r.isUnderMaintenance || r.isDeficient));
  const free = count((r) => standingOfRoom(r) === "free");

  const spaceItems = spaces.data?.items ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Rooms</h2>
          <div className="meta">
            Tonight · {occupied} of {items.length} occupied · for knowing, not choosing
          </div>
        </div>
      </div>

      {rooms.error && !rooms.data ? (
        <LoadFailed what="the rooms" onRetry={() => void rooms.refetch()} />
      ) : rooms.isLoading ? (
        <LoadingBlock />
      ) : items.length === 0 ? (
        <EmptyState title="No rooms configured yet">Rooms are added in the console under Inventory.</EmptyState>
      ) : (
        <>
          <div className="grid4">
            {[
              ["Free", free],
              ["Occupied", occupied],
              ["Reserved · block", held],
              ["Out of order · deficient", out],
            ].map(([k, v]) => (
              <div className="card kpi" key={k}>
                <span className="meta">{k}</span>
                <span className="figure">{v}</span>
              </div>
            ))}
          </div>

          <div className="floor">
            <h4>The house</h4>
            <div className="tiles">
              {items.map((r) => {
                const standing = standingOfRoom(r);
                const bed = r.bedType ? BED_WORD[r.bedType] ?? r.bedType : null;
                return (
                  <RoomTile
                    key={r.id}
                    number={r.roomNumber}
                    standing={standing}
                    occupant={standing === "free" ? undefined : (occupant.get(r.roomNumber) ?? (standing === "occupied" ? "in-house" : standing === "ooo" || standing === "deficient" ? "out of service" : "held"))}
                    physical={physicalOfRoom(r)}
                    qualifier={r.isDeficient && standing !== "deficient" ? "fault reported" : undefined}
                    note={[r.roomType?.name, bed].filter(Boolean).join(" · ")}
                    onSelect={() => setTarget({ kind: "room", id: r.id, label: `Room ${r.roomNumber}` })}
                  />
                );
              })}
            </div>
            <p className="meta">
              {items.length} rooms · select one to report a fault or review one already raised. Room status changes come from each room&apos;s own work — check-out,
              housekeeping, inspection — not from this board.
            </p>
          </div>

          <section className="block">
            <div className="block-head">
              <h3>Halls and spaces</h3>
              <span className="meta">a hall with an open fault is refused when a booking asks for it</span>
            </div>
            {spaces.error && !spaces.data ? (
              <LoadFailed what="the spaces" onRetry={() => void spaces.refetch()} />
            ) : spaces.isLoading ? (
              <LoadingBlock />
            ) : spaceItems.length === 0 ? (
              <EmptyState title="No halls or spaces configured">They are added in the console under Inventory → Spaces.</EmptyState>
            ) : (
              <div className="floor">
                <div className="tiles">
                  {spaceItems.map((s: SpaceListItem) => (
                    <RoomTile
                      key={s.id}
                      number={s.code}
                      standing={s.isDeficient ? "deficient" : !s.isAvailable ? "ooo" : s.isEventInProgress ? "occupied" : "free"}
                      occupant={s.isEventInProgress ? "event in progress" : undefined}
                      note={`${s.name} · ${s.capacity || s.defaultCapacity} seats`}
                      onSelect={() => setTarget({ kind: "space", id: s.id, label: s.name })}
                    />
                  ))}
                </div>
              </div>
            )}
          </section>
        </>
      )}

      {target ? (
        <div className="scrim open" onClick={(e) => e.target === e.currentTarget && setTarget(null)}>
          <Dialog
            register="report"
            title={`Faults · ${target.label}`}
            footer={
              <Button kind="quiet" onClick={() => setTarget(null)}>
                Close
              </Button>
            }
          >
            <p className="sm">Report a fault, or review one already raised. The desk reports; the FOM verifies or rejects.</p>
            <DeficiencyPanel
              target={target.kind === "room" ? { roomId: target.id } : { spaceId: target.id }}
              targetLabel={target.label}
              onChanged={() => {
                void queryClient.invalidateQueries({ queryKey: target.kind === "room" ? ["rooms"] : ["spaces"] });
              }}
            />
          </Dialog>
        </div>
      ) : null}
    </div>
  );
}

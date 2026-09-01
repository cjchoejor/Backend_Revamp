"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { DeficiencyPanel } from "@/components/deficiency/deficiency-panel";
import { useSession } from "@/hooks/use-session";
import { listRooms, type RoomListItem } from "@/lib/api/rooms";
import {
  ROOM_STATUS,
  ROOM_STATUS_ORDER,
  deriveRoomStatus,
  floorOf,
  roomTypeShort,
  type RoomStatusKey,
} from "@/lib/desk/rooms";

export default function DeskRoomsPage() {
  const { session, isLoading: sessionLoading } = useSession();

  const roomsQuery = useQuery({
    queryKey: ["rooms"],
    queryFn: () => listRooms(session!),
    enabled: !!session && !sessionLoading,
  });

  const rooms = useMemo(() => roomsQuery.data?.items ?? [], [roomsQuery.data]);
  const queryClient = useQueryClient();
  // Which room's fault panel is open. Reporting is L1+, so front desk no longer waits for an
  // admin to take a broken room out of service.
  const [faultRoom, setFaultRoom] = useState<{ id: string; roomNumber: string } | null>(null);

  // Escape closes the dialog. Bound to the document rather than the scrim, because a div only
  // receives key events while focused and the operator's focus is inside the form.
  useEffect(() => {
    if (!faultRoom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFaultRoom(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [faultRoom]);
  const isLoading = sessionLoading || roomsQuery.isLoading;

  const statusOf = useMemo(() => {
    const m = new Map<string, RoomStatusKey>();
    rooms.forEach((r) => m.set(r.id, deriveRoomStatus(r)));
    return m;
  }, [rooms]);

  const counts = useMemo(() => {
    const c: Record<RoomStatusKey, number> = {
      occupied: 0,
      reserved: 0,
      ready: 0,
      dirty: 0,
      inspect: 0,
      deficient: 0,
      ooo: 0,
    };
    rooms.forEach((r) => {
      c[statusOf.get(r.id)!] += 1;
    });
    return c;
  }, [rooms, statusOf]);

  const floors = useMemo(() => {
    const map = new Map<string, RoomListItem[]>();
    rooms.forEach((r) => {
      const f = floorOf(r.roomNumber);
      if (!map.has(f)) map.set(f, []);
      map.get(f)!.push(r);
    });
    return [...map.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]) || a[0].localeCompare(b[0]))
      .map(([floor, list]) => [floor, list.sort((x, y) => x.roomNumber.localeCompare(y.roomNumber))] as const);
  }, [rooms]);

  const kpis: { key: RoomStatusKey | "attention"; label: string; value: number; color: string }[] = [
    { key: "occupied", label: "Occupied", value: counts.occupied, color: ROOM_STATUS.occupied.color },
    { key: "reserved", label: "Reserved", value: counts.reserved, color: ROOM_STATUS.reserved.color },
    { key: "ready", label: "Ready", value: counts.ready, color: ROOM_STATUS.ready.color },
    {
      key: "attention",
      label: "Needs attention",
      value: counts.dirty + counts.inspect + counts.deficient + counts.ooo,
      color: "var(--stop)",
    },
  ];

  return (
    <section className="view">
      <div className="eyebrow">Housekeeping</div>
      <h1 className="h-lg" style={{ margin: "4px 0 6px" }}>
        Rooms tonight
      </h1>
      <p className="lead">
        Where every room stands right now. Colour is the status — the board reflects the live claim and
        housekeeping state of each room.
      </p>

      {isLoading ? (
        <p className="lead" style={{ marginTop: 18 }}>
          Loading rooms…
        </p>
      ) : rooms.length === 0 ? (
        <div className="card" style={{ marginTop: 16, padding: "26px 20px", textAlign: "center" }}>
          <p className="lead" style={{ margin: "0 auto" }}>
            No rooms configured yet.
          </p>
        </div>
      ) : (
        <>
          <div className="kpibar">
            {kpis.map((k) => (
              <div className="kpi" key={k.key}>
                <div className="kv">{k.value}</div>
                <div className="kk">
                  <span className="d" style={{ background: k.color }} />
                  {k.label}
                </div>
              </div>
            ))}
          </div>

          {floors.map(([floor, list]) => (
            <div className="floor" key={floor}>
              <div className="floor-h">Floor {floor}</div>
              <div className="roomgrid">
                {list.map((r) => {
                  const key = statusOf.get(r.id)!;
                  const meta = ROOM_STATUS[key];
                  return (
                    <div
                      className={`room${meta.tile ? ` ${meta.tile}` : ""}`}
                      key={r.id}
                      role="button"
                      tabIndex={0}
                      title={r.isDeficient ? "Fault recorded — click to review" : "Click to report a fault"}
                      style={{ cursor: "pointer" }}
                      onClick={() => setFaultRoom({ id: r.id, roomNumber: r.roomNumber })}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setFaultRoom({ id: r.id, roomNumber: r.roomNumber }); }}
                    >
                      <div className="rn">
                        {r.roomNumber}
                        {r.isDeficient && (
                          <AlertTriangle style={{ width: 12, height: 12, marginLeft: 4, verticalAlign: "-1px" }} />
                        )}
                      </div>
                      <div className="rt">{roomTypeShort(r.roomTypeId)}</div>
                      <div className="rs" style={{ color: meta.color }}>
                        <span className="d" style={{ background: meta.color }} />
                        {meta.label}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {faultRoom && (
            <div
              onClick={() => setFaultRoom(null)}
              style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 60, display: "grid", placeItems: "center", padding: 16 }}
            >
              <div onClick={(e) => e.stopPropagation()} style={{ width: "min(560px, 100%)", maxHeight: "85vh", overflowY: "auto" }}>
                <div className="card" style={{ padding: 16, background: "var(--paper, #fff)" }}>
                  <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFaultRoom(null)}>
                      Close
                    </button>
                  </div>
                  <DeficiencyPanel
                    target={{ roomId: faultRoom.id }}
                    targetLabel={`Room ${faultRoom.roomNumber}`}
                    onChanged={() => { void queryClient.invalidateQueries({ queryKey: ["rooms"] }); }}
                  />
                </div>
              </div>
            </div>
          )}

          <div className="legend">
            {ROOM_STATUS_ORDER.map((k) => (
              <span className="lg" key={k}>
                <span className="d" style={{ background: ROOM_STATUS[k].color }} />
                {ROOM_STATUS[k].label}
              </span>
            ))}
          </div>
          <p className="lead" style={{ marginTop: 12, fontSize: 12 }}>
            This is a live status board. Housekeeping transitions and out-of-order changes flow from each
            room&rsquo;s own workflow, so the board always mirrors the system of record rather than being edited
            here.
          </p>
        </>
      )}
    </section>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { listRooms, type RoomListItem } from "@/lib/api/rooms";
import { DeficiencyPanel } from "@/components/deficiency/deficiency-panel";
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
  const queryClient = useQueryClient();
  // Which room's fault panel is open. Reporting is L1+, so front desk no longer has to wait for
  // an admin to take a broken room out of service.
  const [faultRoom, setFaultRoom] = useState<{ id: string; roomNumber: string } | null>(null);

  // Escape closes the dialog. Bound to the document rather than the scrim div, because a div
  // only receives key events while focused and the operator's focus is inside the form.
  useEffect(() => {
    if (!faultRoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFaultRoom(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [faultRoom]);

  const roomsQuery = useQuery({
    queryKey: ["rooms"],
    queryFn: () => listRooms(session!),
    enabled: !!session && !sessionLoading,
  });

  const rooms = useMemo(() => roomsQuery.data?.items ?? [], [roomsQuery.data]);
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
      ) : roomsQuery.isError ? (
        // Distinguished from "none configured" on purpose. A backend outage used to render as
        // "No rooms configured yet", which reads as a setup problem and sends people hunting in
        // the admin console for something that isn't wrong.
        <div className="card" style={{ marginTop: 16, padding: "26px 20px", textAlign: "center" }}>
          <p className="lead" style={{ margin: "0 auto" }}>
            Couldn&rsquo;t load rooms. Check that the backend is running, then retry.
          </p>
        </div>
      ) : rooms.length === 0 ? (
        <div className="card" style={{ marginTop: 16, padding: "26px 20px", textAlign: "center" }}>
          <p className="lead" style={{ margin: "0 auto" }}>
            No rooms configured yet. They&rsquo;re added in the admin console under Inventory → Rooms.
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
                    <button
                      type="button"
                      className={`room${meta.tile ? ` ${meta.tile}` : ""}`}
                      key={r.id}
                      onClick={() => setFaultRoom({ id: r.id, roomNumber: r.roomNumber })}
                      title={`Report or review faults on room ${r.roomNumber}`}
                      style={{ textAlign: "inherit", font: "inherit", cursor: "pointer", border: "none" }}
                    >
                      <div className="rn">{r.roomNumber}</div>
                      <div className="rt">{roomTypeShort(r.roomTypeId)}</div>
                      <div className="rs" style={{ color: meta.color }}>
                        <span className="d" style={{ background: meta.color }} />
                        {meta.label}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

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
            here. Select a room to report a fault or review one already raised against it.
          </p>

          {/* Reuses the desk's own .scrim/.modal so it sits in the same visual language as the
              other desk dialogs. Click the backdrop or press Escape to dismiss. */}
          {faultRoom && (
            <div className="scrim" onClick={(e) => e.target === e.currentTarget && setFaultRoom(null)} role="presentation">
              {/* .modal caps at 450px and hides overflow — fine for the confirm dialog it was
                  built for, too tight here. Widened, and the body scrolls so a room with several
                  logged faults doesn't get clipped. */}
              <div
                className="modal"
                role="dialog"
                aria-modal="true"
                aria-label={`Faults on room ${faultRoom.roomNumber}`}
                style={{ maxWidth: 640 }}
              >
                <div className="modal-top" style={{ background: "var(--stop-t)", borderBottomColor: "#e2b3ac" }}>
                  <div className="modal-ic" style={{ background: "var(--stop)" }}>
                    <AlertTriangle />
                  </div>
                  <div>
                    <h3>Room {faultRoom.roomNumber}</h3>
                    <p>Report a fault, or review one already raised.</p>
                  </div>
                </div>
                <div className="modal-body" style={{ maxHeight: "70vh", overflowY: "auto" }}>
                  <DeficiencyPanel
                    target={{ roomId: faultRoom.id }}
                    targetLabel={`Room ${faultRoom.roomNumber}`}
                    // The board colours rooms from isDeficient, so refresh it whenever a fault
                    // is raised, confirmed, rejected or fixed.
                    onChanged={() => void queryClient.invalidateQueries({ queryKey: ["rooms"] })}
                  />
                </div>
                <div className="modal-foot">
                  <button className="btn btn-ghost" onClick={() => setFaultRoom(null)}>
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

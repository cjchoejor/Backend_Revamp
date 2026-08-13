"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  changeBookingRoom,
  getRoomPlanHistory,
  listRoomChangeCandidates,
  type RoomChangeCandidate,
} from "@/lib/api/entries";
import { listRooms, setRoomBedType } from "@/lib/api/rooms";
import { money } from "@/lib/desk/workspace";
import type { EntryDetail } from "@/types/api";

/**
 * In-place room change (2026-08-12, operator ruling): every room row on S5/S6/S7 carries a
 * "Change room" affordance that swaps ONLY that room, from the current page. The backend runs
 * the whole governed journey (new segment, availability re-checked the way S1 checks it, silent
 * re-quote, walk back to this stage) in one call — the desk never navigates away, and nothing
 * is sent to the guest unless the operator sends it.
 *
 * Authority (2026-08-13 ruling, mirrors p58): a SAME-TYPE swap is desk logistics — anyone
 * (L1+) does it, at any of S5–S7. A CROSS-TYPE move is an upgrade/downgrade that re-prices the
 * stay, so it needs FOM+ (L2+) — below that the different-type options are shown but locked.
 *
 * The candidate list shows EVERY room with its S1-style standing over the change's nights
 * (2026-08-13, operator request): free rooms are pickable; reserved / held / blocked /
 * maintenance rooms stay visible with who holds them, exactly like the S1 availability table.
 */

function bedLabel(t?: string | null) {
  if (!t) return "";
  return t.charAt(0) + t.slice(1).toLowerCase();
}

function levelRank(level?: string) {
  return level === "L4" ? 4 : level === "L3" ? 3 : level === "L2" ? 2 : level === "L1" ? 1 : 0;
}

function shortDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** "reserved — Dorji Wangmo (14 Aug – 16 Aug)" — the S1 cell tooltip's vocabulary, inline. */
function statusText(c: RoomChangeCandidate): string {
  switch (c.availability) {
    case "FREE":
      return "";
    case "RESERVED":
      return `reserved${c.claimedBy?.guestName ? ` — ${c.claimedBy.guestName}` : ""}${
        c.claimedBy ? ` (${shortDate(c.claimedBy.startDate)} – ${shortDate(c.claimedBy.endDate)})` : ""
      }`;
    case "HELD":
      return `${c.claimedBy?.holdKind === "SPECULATIVE" ? "held (quote hold)" : "held"}${
        c.claimedBy?.guestName ? ` — ${c.claimedBy.guestName}` : ""
      }${c.claimedBy ? ` (${shortDate(c.claimedBy.startDate)} – ${shortDate(c.claimedBy.endDate)})` : ""}`;
    case "BLOCKED":
      return `blocked${c.blockedReason ? ` — ${c.blockedReason}` : ""}`;
    case "MAINTENANCE":
      return "under maintenance";
  }
}

export function RoomChangeControl({
  entry,
  fromRoomId,
  fromRoomNumber,
  onChanged,
  compact,
}: {
  entry: EntryDetail;
  fromRoomId: string;
  fromRoomNumber: string;
  /** Parent's cache invalidation — the change touches the entry, quotes, timers, rooms. */
  onChanged: () => void;
  /** Renders the trigger as a small inline link-button (for dense room rows). */
  compact?: boolean;
}) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [toRoomId, setToRoomId] = useState("");
  const [reason, setReason] = useState("");

  const stage = entry.currentStage;
  // Same-type swaps are open to the whole desk (L1+); cross-type (upgrade/downgrade) is FOM+.
  const canCrossType = levelRank(session?.actorLevel) >= 2;

  const candidatesQuery = useQuery({
    queryKey: ["room-change-candidates", entry.id, fromRoomId],
    queryFn: () => listRoomChangeCandidates(session!, entry.id, fromRoomId),
    enabled: !!session && open,
    staleTime: 30_000,
  });

  const changeM = useMutation({
    mutationFn: () =>
      changeBookingRoom(session!, entry.id, { fromRoomId, toRoomId, reason: reason.trim() }),
    onSuccess: (out) => {
      const moved = `Room ${out.fromRoom.roomNumber} → ${out.toRoom.roomNumber}`;
      if (out.walk.blocked) {
        toast.warning(
          `${moved} — the booking is at ${out.walk.reachedStage}, not back at this step yet: ${out.walk.blocked.message}`,
          { duration: 12000 },
        );
      } else if (out.pricing.delta != null && Math.abs(out.pricing.delta) >= 0.01) {
        const dir = out.pricing.delta > 0 ? "+" : "−";
        toast.success(
          `${moved} · new total ${money(out.pricing.newTotal)} (was ${money(out.pricing.priorTotal)}, ${dir}${money(Math.abs(out.pricing.delta))}). Nothing was sent to the guest — send the new quote only if they ask.`,
          { duration: 12000 },
        );
      } else {
        toast.success(`${moved} — price unchanged. Everything else about the booking carried.`);
      }
      setOpen(false);
      setToRoomId("");
      setReason("");
      void queryClient.invalidateQueries({ queryKey: ["rooms-catalog"] });
      void queryClient.invalidateQueries({ queryKey: ["room-change-candidates", entry.id] });
      void queryClient.invalidateQueries({ queryKey: ["room-plan-history", entry.id] });
      onChanged();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "The room change was refused"),
  });

  const candidates = candidatesQuery.data?.candidates ?? [];
  const sameTypeCandidates = candidates.filter((c) => c.sameType);
  const otherTypeCandidates = candidates.filter((c) => !c.sameType);
  const selectableCount = candidates.filter((c) => c.selectable && (c.sameType || canCrossType)).length;
  const picked = candidates.find((c) => c.roomId === toRoomId) ?? null;
  const nights = candidatesQuery.data?.substitutionNights.length ?? 0;

  const optionLabel = (c: RoomChangeCandidate, withType: boolean) => {
    const bits = [c.roomNumber];
    if (withType) bits.push(c.roomTypeName ?? "—");
    if (c.bedType) bits.push(`${bedLabel(c.bedType)}${c.bedType === "TWIN" ? " beds" : " bed"}`);
    const status = statusText(c);
    if (status) bits.push(status);
    else if (!c.sameType && !canCrossType) bits.push("needs FOM");
    return bits.join(" · ");
  };

  return (
    <div style={compact ? { display: "inline-block" } : undefined}>
      <button
        className="btn btn-ghost btn-sm"
        style={compact ? { fontSize: 11, padding: "2px 8px" } : undefined}
        onClick={() => setOpen((v) => !v)}
        title="Swap only this room — the rest of the booking carries. The backend re-checks availability and re-prices as if the booking were re-made, without leaving this page."
      >
        <ArrowLeftRight style={{ width: 11, height: 11 }} />
        {open ? "Cancel change" : `Change room ${fromRoomNumber}`}
      </button>

      {open && (
        <div
          style={{
            marginTop: 8,
            border: "1px solid var(--line-2)",
            borderRadius: 10,
            padding: "10px 12px",
            background: "var(--panel, rgba(255,255,255,0.5))",
            maxWidth: 560,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            Move Room {fromRoomNumber}
            {stage === "S7" ? " — from tonight onward" : ""}
          </div>
          <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "0 0 8px", lineHeight: 1.5 }}>
            Swaps only this room{nights > 0 ? ` for its ${nights} night${nights === 1 ? "" : "s"}` : ""}. Guests, payments,
            paperwork and the rest of the room plan carry unchanged — the backend re-checks availability and re-prices the
            stay exactly as if it were being set up fresh, and the booking comes straight back to this step. Nothing is
            sent to the guest unless you send it.
            {stage === "S7" ? " Nights already slept stay billed on the current room." : ""}
            {" "}A same-type swap needs no approval; a different type (upgrade or downgrade) needs FOM (L2+).
          </p>

          {candidatesQuery.isLoading && <p style={{ fontSize: 12, color: "var(--ink-3)" }}>Checking availability…</p>}
          {candidatesQuery.isError && (
            <p style={{ fontSize: 12, color: "var(--stop)" }}>
              {candidatesQuery.error instanceof ApiError ? candidatesQuery.error.message : "Could not load the available rooms"}
            </p>
          )}
          {candidatesQuery.data && selectableCount === 0 && (
            <p style={{ fontSize: 12, color: "var(--stop)" }}>
              {candidates.some((c) => c.selectable)
                ? "The only free rooms are a different type — an FOM (L2+) has to make that change."
                : "No other room is free for those nights — the list shows who holds each one."}
            </p>
          )}

          {candidates.length > 0 && (
            <div className="frow" style={{ alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
              <div className="field">
                <label>New room (status over these nights, as the S1 search sees it)</label>
                <select value={toRoomId} onChange={(e) => setToRoomId(e.target.value)}>
                  <option value="">Choose…</option>
                  {sameTypeCandidates.length > 0 && (
                    <optgroup label={`Same type — ${candidatesQuery.data?.fromRoom.roomTypeName ?? "same rate"} · anyone can swap`}>
                      {sameTypeCandidates.map((c) => (
                        <option key={c.roomId} value={c.roomId} disabled={!c.selectable}>
                          {optionLabel(c, false)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {otherTypeCandidates.length > 0 && (
                    <optgroup
                      label={
                        canCrossType
                          ? "Different type — upgrade/downgrade, price will change"
                          : "Different type — upgrade/downgrade · needs FOM (L2+)"
                      }
                    >
                      {otherTypeCandidates.map((c) => (
                        <option key={c.roomId} value={c.roomId} disabled={!c.selectable || !canCrossType}>
                          {optionLabel(c, true)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>
              <div className="field" style={{ flex: 1, minWidth: 180 }}>
                <label>Reason (recorded on the audit trail)</label>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. aircon fault in 302" />
              </div>
              <div className="field">
                <button
                  className="btn btn-primary btn-sm"
                  disabled={
                    changeM.isPending ||
                    !toRoomId ||
                    reason.trim().length < 3 ||
                    !picked?.selectable ||
                    (!!picked && !picked.sameType && !canCrossType)
                  }
                  onClick={() => changeM.mutate()}
                >
                  {changeM.isPending ? "Changing…" : "Swap room"}
                </button>
              </div>
            </div>
          )}

          {picked && !picked.sameType && canCrossType && (
            <div
              className="fact b-transit"
              style={{ marginTop: 8, padding: "6px 10px", fontSize: 11.5, display: "block", lineHeight: 1.5 }}
            >
              {picked.roomTypeName ?? "That room"} is a different type, so the stay re-prices at its own rate — the new
              total (and the difference) shows the moment the swap completes. The bill already sent and the advance
              already paid stand; a fresh quote exists silently and goes out only if the guest asks for it.
            </div>
          )}
          {picked?.isDeficient && (
            <div className="fact b-warn" style={{ marginTop: 8, padding: "6px 10px", fontSize: 11.5, display: "block" }}>
              Room {picked.roomNumber} carries a known deficiency — make sure the guest accepts it.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * "Initially selected" cell (2026-08-13, operator request): every S5–S7 room row keeps stating
 * what the FIRST selection was — room and bed setup as sealed at Inquiry — permanently, so a
 * room change or a bed-type change never erases where the booking started. Reads the
 * backend-derived room-plan history (first sealed config + room-change chain + bed-type
 * traces); nothing is computed client-side. Amber when the room or the bed has moved since.
 */
export function InitialSelectionCell({ entryId, roomId }: { entryId: string; roomId: string }) {
  const { session } = useSession();
  const historyQuery = useQuery({
    queryKey: ["room-plan-history", entryId],
    queryFn: () => getRoomPlanHistory(session!, entryId),
    enabled: !!session,
    staleTime: 60_000,
  });

  const item = historyQuery.data?.rooms.find((r) => r.currentRoomId === roomId) ?? null;
  if (!item) return null;

  const changed = item.roomChanged || item.bedTypeChanged;
  const label = item.initialRoomNumber
    ? `Room ${item.initialRoomNumber}${item.initialBedType ? ` · ${bedLabel(item.initialBedType)}${item.initialBedType === "TWIN" ? " beds" : " bed"}` : ""}`
    : "not recorded";

  const titleBits: string[] = [];
  if (item.initialRoomNumber) {
    titleBits.push(
      `First selection: Room ${item.initialRoomNumber}${item.initialRoomTypeName ? ` (${item.initialRoomTypeName})` : ""}${
        item.initialBedType ? `, ${bedLabel(item.initialBedType)} bed setup` : ""
      }`,
    );
  } else {
    titleBits.push("The first selection predates the room-change record — origin unknown");
  }
  for (const c of item.changes) {
    titleBits.push(
      `Changed ${shortDate(c.at)}: Room ${c.fromRoomNumber ?? "?"} → ${c.toRoomNumber ?? "?"}${c.reason ? ` (${c.reason})` : ""}`,
    );
  }
  if (item.bedTypeChanged) {
    titleBits.push(`Bed setup was ${bedLabel(item.initialBedType)} at selection — now ${bedLabel(item.currentBedType)}`);
  }

  return (
    <span
      className={`tag${changed ? " warn" : ""}`}
      title={titleBits.join("\n")}
      style={{ whiteSpace: "nowrap" }}
    >
      Initially: {label}
    </span>
  );
}

/**
 * Bed-type dropdown, extracted from the S5 pattern so S6/S7 room rows carry it too
 * (2026-08-12, operator request: bed type editable S5–S7). Self-contained: reads the shared
 * rooms catalog (same query key app-wide) and writes through the L1 bed-type endpoint; each
 * room offers only the setups its own type carries (`allowedBedTypes`, server-derived).
 */
export function BedTypeEditor({ roomId }: { roomId: string }) {
  const { session } = useSession();
  const queryClient = useQueryClient();

  const roomsCatalogQuery = useQuery({
    queryKey: ["rooms-catalog"],
    queryFn: () => listRooms(session!),
    enabled: !!session,
  });

  const room = useMemo(
    () => (roomsCatalogQuery.data?.items ?? []).find((r) => r.id === roomId) ?? null,
    [roomsCatalogQuery.data, roomId],
  );
  const vocabulary = useMemo(() => {
    const all = new Set<string>();
    for (const r of roomsCatalogQuery.data?.items ?? []) if (r.bedType) all.add(r.bedType);
    return [...all].sort();
  }, [roomsCatalogQuery.data]);

  const bedTypeM = useMutation({
    mutationFn: (bedType: string) => setRoomBedType(session!, roomId, bedType),
    onSuccess: (r) => {
      toast.success(`Room ${r.roomNumber} set to ${r.bedType === "TWIN" ? "Twin beds" : `${bedLabel(r.bedType)} bed`}`);
      void queryClient.invalidateQueries({ queryKey: ["rooms-catalog"] });
      // The "Initially" cells compare against the live registry — keep them honest.
      void queryClient.invalidateQueries({ queryKey: ["room-plan-history"] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Could not change the bed type"),
  });

  if (!room) return null;
  const current = room.bedType ?? "";
  const options = room.allowedBedTypes?.length ? room.allowedBedTypes : vocabulary;

  return (
    <select
      value={current}
      disabled={bedTypeM.isPending}
      onChange={(e) => {
        if (e.target.value) bedTypeM.mutate(e.target.value);
      }}
      title="Physical bed setup of this room — the options are the setups this room's type carries; changing it updates the room registry (recorded)"
      style={{ width: 108, fontSize: 11.5, padding: "3px 6px" }}
    >
      {!current && <option value="">Set beds…</option>}
      {options.map((t) => (
        <option key={t} value={t}>
          {t === "TWIN" ? "Twin beds" : `${bedLabel(t)} bed`}
        </option>
      ))}
      {current && !options.includes(current) && (
        <option value={current}>{current === "TWIN" ? "Twin beds" : `${bedLabel(current)} bed`}</option>
      )}
    </select>
  );
}

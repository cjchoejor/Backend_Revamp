"use client";

import { Help } from "@/components/ds/help";
import { Suspense, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createAdminRoom, deactivateAdminRoom, deleteAdminRoom, getDeficientCategories, listAdminRooms, listRoomTypes, markRoomDeficient, reactivateAdminRoom, resolveRoomDeficient, updateAdminRoom } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { useConfirm, usePrompt } from "@/components/providers/dialog-provider";
import { AllowedBedSetups, bedSetupListWords, bedSetupWord } from "@/components/admin/bed-setup-fields";
import { DateTimeInput } from "@/components/ds/date-input";
import { SettingsList } from "@/components/admin/settings-list";
import { CLAIM_STATE_OPTIONS } from "@/lib/admin/setting-forms";

const standingWord = (state: string) => CLAIM_STATE_OPTIONS.find((o) => o.value === state)?.label ?? state;
const CONDITION_WORD: Record<string, string> = {
  AVAILABLE_CLEAN: "Clean",
  AVAILABLE_INSPECTED: "Inspected",
  DIRTY: "Needs cleaning",
  UNDER_MAINTENANCE: "Under maintenance",
};

type DeficientForm = { roomId: string; roomNumber: string; category: string; description: string; deadline: string };
/** `usualBedType` "" = the room follows its room type's usual setup. */
type EditDraft = { roomNumber: string; roomTypeId: string; floorNumber: string; usualBedType: string; allowedBedTypes: string[] };

/**
 * "KING" → "King". The vocabulary itself comes from the API (`bedTypes` on the rooms
 * response) — this only makes it readable, so a bed type added backend-side still renders.
 */
function bedLabel(bedType: string) {
  return bedType.charAt(0) + bedType.slice(1).toLowerCase();
}

/** What a room's beds read as in the table: "Twin · 2 beds", "King", "—". */
function bedSummary(bedType: string | null, bedCount: number | null) {
  if (!bedType) return null;
  return bedCount && bedCount > 1 ? `${bedLabel(bedType)} · ${bedCount} beds` : bedLabel(bedType);
}

export default function AdminRoomsPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [form, setForm] = useState<{ roomNumber: string; roomTypeId: string; floorNumber: string; usualBedType: string; allowedBedTypes: string[] }>(
    { roomNumber: "", roomTypeId: "", floorNumber: "", usualBedType: "", allowedBedTypes: [] },
  );
  const [defForm, setDefForm] = useState<DeficientForm | null>(null);

  // Edit-in-place: when not null, the row with this roomId renders as editable inputs.
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft>({ roomNumber: "", roomTypeId: "", floorNumber: "", usualBedType: "", allowedBedTypes: [] });

  // Filters
  const [filterRoomTypeId, setFilterRoomTypeId] = useState<string>("ALL");
  const [filterFloor, setFilterFloor] = useState<string>("ALL");

  const roomsQuery = useQuery({
    queryKey: ["admin", "rooms"],
    queryFn: () => listAdminRooms(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const roomTypesQuery = useQuery({
    queryKey: ["admin", "room-types"],
    queryFn: () => listRoomTypes(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createAdminRoom(session!, {
        roomNumber: form.roomNumber,
        roomTypeId: form.roomTypeId,
        floorNumber: form.floorNumber ? Number.parseInt(form.floorNumber, 10) : null,
        // The room's own usual setup (blank = its type's); it starts made up that way, and the
        // number of beds follows the setup (a Twin is two) — the backend works both out.
        defaultBedType: form.usualBedType || null,
        allowedBedTypes: form.allowedBedTypes,
      }),
    onSuccess: () => {
      toast.success("Room created");
      setForm({ roomNumber: "", roomTypeId: form.roomTypeId, floorNumber: "", usualBedType: form.usualBedType, allowedBedTypes: form.allowedBedTypes });
      void queryClient.invalidateQueries({ queryKey: ["admin", "rooms"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Create failed"),
  });

  const updateMutation = useMutation({
    mutationFn: () => {
      if (!editId) throw new Error("No row in edit mode");
      const floorNumber = editDraft.floorNumber.trim() === "" ? null : Number.parseInt(editDraft.floorNumber, 10);
      return updateAdminRoom(session!, editId, {
        roomNumber: editDraft.roomNumber.trim(),
        roomTypeId: editDraft.roomTypeId,
        floorNumber,
        // Null = follow the room type. A new usual setup also makes the room up that way now,
        // unless a guest is in it (then it follows when they leave).
        defaultBedType: editDraft.usualBedType || null,
        // Empty = follow the room type's list.
        allowedBedTypes: editDraft.allowedBedTypes,
      });
    },
    onSuccess: () => {
      toast.success("Room updated");
      setEditId(null);
      void queryClient.invalidateQueries({ queryKey: ["admin", "rooms"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Update failed"),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => deactivateAdminRoom(session!, id),
    onSuccess: () => {
      toast.success("Room deactivated (blocked)");
      void queryClient.invalidateQueries({ queryKey: ["admin", "rooms"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Deactivate failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAdminRoom(session!, id),
    onSuccess: () => {
      toast.success("Room deleted");
      void queryClient.invalidateQueries({ queryKey: ["admin", "rooms"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Delete failed"),
  });

  const resolveDeficientMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => resolveRoomDeficient(session!, id, note),
    onSuccess: () => {
      toast.success("Fault put right");
      void queryClient.invalidateQueries({ queryKey: ["admin", "rooms"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "That could not be saved"),
  });

  const reactivateMutation = useMutation({
    mutationFn: (id: string) => reactivateAdminRoom(session!, id),
    onSuccess: () => {
      toast.success("Room reactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "rooms"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Reactivate failed"),
  });

  const markDeficientMutation = useMutation({
    mutationFn: () => {
      if (!defForm) throw new Error("No form");
      return markRoomDeficient(session!, defForm.roomId, {
        category: defForm.category,
        description: defForm.description,
        resolutionDeadline: defForm.deadline ? new Date(defForm.deadline).toISOString() : null,
      });
    },
    onSuccess: () => {
      toast.success("Fault reported");
      setDefForm(null);
      void queryClient.invalidateQueries({ queryKey: ["admin", "rooms"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "The fault could not be reported"),
  });

  const categoriesQuery = useQuery({
    queryKey: ["admin", "deficient-categories"],
    queryFn: () => getDeficientCategories(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const allRooms = roomsQuery.data?.items ?? [];
  // Served by the API so a bed type added backend-side appears here without a UI change.
  const bedTypes = roomsQuery.data?.bedTypes ?? [];

  // Derive the unique floor values from the loaded inventory for the floor filter.
  const distinctFloors = Array.from(
    new Set(allRooms.map((r) => (r.floorNumber == null ? "_none" : String(r.floorNumber)))),
  ).sort((a, b) => {
    if (a === "_none") return 1;
    if (b === "_none") return -1;
    return Number(a) - Number(b);
  });

  // Apply filters.
  const rooms = allRooms.filter((r) => {
    if (filterRoomTypeId !== "ALL" && r.roomType.id !== filterRoomTypeId) return false;
    if (filterFloor !== "ALL") {
      if (filterFloor === "_none" && r.floorNumber != null) return false;
      if (filterFloor !== "_none" && String(r.floorNumber ?? "") !== filterFloor) return false;
    }
    return true;
  });

  function startEdit(r: {
    id: string;
    roomNumber: string;
    roomType: { id: string };
    floorNumber: number | null;
    defaultBedType: string | null;
    allowedBedTypes: string[];
  }) {
    setEditId(r.id);
    setEditDraft({
      roomNumber: r.roomNumber,
      roomTypeId: r.roomType.id,
      floorNumber: r.floorNumber == null ? "" : String(r.floorNumber),
      usualBedType: r.defaultBedType ?? "",
      allowedBedTypes: r.allowedBedTypes ?? [],
    });
  }
  function cancelEdit() {
    setEditId(null);
  }

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Rooms and spaces</p>
        <h1 className="admin-display flex items-center gap-2 text-3xl">
          Rooms
          <Help label="Rooms">Add rooms, set their beds and report faults. Whether a room is held or occupied comes from its bookings, so it is not changed here.</Help>
        </h1>
      </div>

      <div className="admin-panel grid gap-4 p-5 md:grid-cols-2">
        <h2 className="admin-display col-span-full text-lg">Add room</h2>
        <input className="admin-input" placeholder="Room number" value={form.roomNumber} onChange={(e) => setForm({ ...form, roomNumber: e.target.value })} />
        <select className="admin-select" value={form.roomTypeId} onChange={(e) => setForm({ ...form, roomTypeId: e.target.value })}>
          <option value="">Select room type</option>
          {(roomTypesQuery.data?.items ?? []).map((rt) => (
            <option key={rt.id} value={rt.id}>
              {rt.code} — {rt.name}
            </option>
          ))}
        </select>
        <input className="admin-input" placeholder="Floor" value={form.floorNumber} onChange={(e) => setForm({ ...form, floorNumber: e.target.value })} />
        <select className="admin-select" value={form.usualBedType} onChange={(e) => setForm({ ...form, usualBedType: e.target.value })}>
          <option value="">
            {(() => {
              const usual = (roomTypesQuery.data?.items ?? []).find((rt) => rt.id === form.roomTypeId)?.defaultBedType;
              return usual ? `Usual bed — as its room type (${bedSetupWord(usual)})` : "Usual bed — as its room type";
            })()}
          </option>
          {bedTypes.map((b) => (
            <option key={b} value={b}>
              Usual bed — {bedLabel(b)}
            </option>
          ))}
        </select>
        <div className="col-span-full">
          <div className="text-[11px] font-medium text-muted-foreground">This room can be made up as</div>
          <AllowedBedSetups
            vocabulary={bedTypes}
            value={form.allowedBedTypes}
            onChange={(v) => setForm({ ...form, allowedBedTypes: v })}
            emptyLabel="Follows its room type"
          />
        </div>
        <p className="admin-muted col-span-full text-xs">
          Any room can be made up in any bed setup unless its room type — or the room itself, here — narrows it. The
          <em> usual bed</em> is how the room is normally made up: its room type&apos;s, unless you give this room its own
          (two rooms of one type can differ). <em>Bed now</em> is how it is made up today — the desk changes it when a
          guest asks for another setup, and it goes back to the usual bed when that guest leaves.
        </p>
        <button type="button" className="admin-btn col-span-full w-fit" disabled={createMutation.isPending} onClick={() => createMutation.mutate()}>
          Create room
        </button>
      </div>

      <Suspense>
        <SettingsList groups={[{ keys: ["deficientCondition.categories"] }]} />
      </Suspense>

      {defForm && (
        <div className="admin-panel space-y-3 p-5">
          <h2 className="admin-display text-lg">Report a fault on Room {defForm.roomNumber}</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="admin-muted text-xs">
              Kind of fault
              <select
                className="admin-select mt-1 w-full"
                value={defForm.category}
                onChange={(e) => setDefForm({ ...defForm, category: e.target.value })}
              >
                <option value="">Pick one</option>
                {(Array.isArray(categoriesQuery.data?.configValue) ? (categoriesQuery.data!.configValue as Array<{ code: string; label: string; isActive?: boolean }>) : [])
                  .filter((c) => c.isActive !== false)
                  .map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.label}
                    </option>
                  ))}
              </select>
            </label>
            <label className="admin-muted text-xs">
              To be fixed by (optional)
              <DateTimeInput
                className="admin-input mt-1 w-full"
                value={defForm.deadline}
                onChange={(e) => setDefForm({ ...defForm, deadline: e.target.value })}
              />
            </label>
            <label className="admin-muted text-xs md:col-span-2">
              Description
              <textarea
                className="admin-input mt-1 w-full"
                rows={2}
                placeholder="What's wrong with the room?"
                value={defForm.description}
                onChange={(e) => setDefForm({ ...defForm, description: e.target.value })}
              />
            </label>
          </div>
          <p className="admin-muted text-xs">
            Left empty, the time allowed comes from the rule Time to fix a fault.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="admin-btn w-fit"
              disabled={markDeficientMutation.isPending || !defForm.category || defForm.description.trim().length < 3}
              onClick={() => markDeficientMutation.mutate()}
            >
              Report the fault
            </button>
            <button type="button" className="admin-btn w-fit" onClick={() => setDefForm(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="admin-panel overflow-x-auto p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3 border-b border-[var(--admin-rule)] pb-3 text-xs">
          <span className="admin-muted">Filter:</span>
          <label className="flex items-center gap-1">
            <span className="admin-muted">Room type</span>
            <select className="admin-select w-44" value={filterRoomTypeId} onChange={(e) => setFilterRoomTypeId(e.target.value)}>
              <option value="ALL">All</option>
              {(roomTypesQuery.data?.items ?? []).map((rt) => (
                <option key={rt.id} value={rt.id}>{rt.code} — {rt.name}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            <span className="admin-muted">Floor</span>
            <select className="admin-select w-28" value={filterFloor} onChange={(e) => setFilterFloor(e.target.value)}>
              <option value="ALL">All</option>
              {distinctFloors.map((f) => (
                <option key={f} value={f}>{f === "_none" ? "(no floor)" : `Floor ${f}`}</option>
              ))}
            </select>
          </label>
          {(filterRoomTypeId !== "ALL" || filterFloor !== "ALL") && (
            <button
              type="button"
              className="admin-btn admin-btn-ghost text-[10px]"
              onClick={() => { setFilterRoomTypeId("ALL"); setFilterFloor("ALL"); }}
            >
              Clear filters
            </button>
          )}
          <span className="ml-auto admin-muted">
            Showing {rooms.length} of {allRooms.length}
          </span>
        </div>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Room</th>
              <th>Type</th>
              <th>Floor</th>
              <th>Bed now</th>
              <th>Usual bed</th>
              <th>Can be made up as</th>
              <th>Standing</th>
              <th>Condition</th>
              <th>Fault</th>
              <th>Out of order</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rooms.map((r) => {
              const inEdit = editId === r.id;
              if (inEdit) {
                return (
                  <tr key={r.id} className="bg-[var(--admin-brass-glow)]/30">
                    <td>
                      <input
                        className="admin-input w-20"
                        value={editDraft.roomNumber}
                        onChange={(e) => setEditDraft({ ...editDraft, roomNumber: e.target.value })}
                      />
                    </td>
                    <td>
                      <select
                        className="admin-select"
                        value={editDraft.roomTypeId}
                        onChange={(e) => setEditDraft({ ...editDraft, roomTypeId: e.target.value })}
                      >
                        {(roomTypesQuery.data?.items ?? []).map((rt) => (
                          <option key={rt.id} value={rt.id}>{rt.code}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className="admin-input w-16"
                        type="number"
                        value={editDraft.floorNumber}
                        onChange={(e) => setEditDraft({ ...editDraft, floorNumber: e.target.value })}
                        placeholder="—"
                      />
                    </td>
                    <td className="text-xs">
                      {bedSummary(r.bedType, r.bedCount) ?? <span className="opacity-50">—</span>}
                      <div className="text-[10px] opacity-60">changed at the desk</div>
                    </td>
                    <td>
                      <select
                        className="admin-select w-40"
                        value={editDraft.usualBedType}
                        onChange={(e) => setEditDraft({ ...editDraft, usualBedType: e.target.value })}
                        title="How this room is normally made up. Changing it also makes the room up that way now, unless a guest is in it."
                      >
                        <option value="">
                          {(() => {
                            const usual = (roomTypesQuery.data?.items ?? []).find((rt) => rt.id === editDraft.roomTypeId)?.defaultBedType;
                            return usual ? `As its room type (${bedSetupWord(usual)})` : "As its room type";
                          })()}
                        </option>
                        {bedTypes.map((b) => (
                          <option key={b} value={b}>
                            {bedLabel(b)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <AllowedBedSetups
                        vocabulary={bedTypes}
                        value={editDraft.allowedBedTypes}
                        onChange={(v) => setEditDraft({ ...editDraft, allowedBedTypes: v })}
                        emptyLabel="Follows its room type"
                      />
                    </td>
                    <td>{standingWord(r.currentClaimState)}</td>
                    <td>{CONDITION_WORD[r.physicalState] ?? r.physicalState}</td>
                    <td>{r.isDeficient ? "Yes" : "—"}</td>
                    <td>{r.isBlocked ? "Yes" : "—"}</td>
                    <td className="text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          className="admin-btn admin-btn-success text-[10px]"
                          disabled={updateMutation.isPending || !editDraft.roomNumber.trim() || !editDraft.roomTypeId}
                          onClick={() => updateMutation.mutate()}
                        >
                          Save
                        </button>
                        <button type="button" className="admin-btn admin-btn-ghost text-[10px]" onClick={cancelEdit}>
                          Cancel
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              }
              return (
              <tr key={r.id}>
                <td>
                  <strong>{r.roomNumber}</strong>
                </td>
                <td>
                  {r.roomType.name} <span className="text-xs opacity-60">({r.roomType.code})</span>
                </td>
                <td>{r.floorNumber ?? "—"}</td>
                <td>
                  {bedSummary(r.bedType, r.bedCount) ?? <span className="opacity-50">—</span>}
                  {r.usualBedType && r.bedType !== r.usualBedType && (
                    <div className="text-[10px] opacity-60">for a guest — back to {bedSetupWord(r.usualBedType)} when they leave</div>
                  )}
                </td>
                <td className="text-xs">
                  {bedSetupWord(r.usualBedType)}
                  <div className="text-[10px] opacity-60">
                    {r.usualBedTypeSource === "ROOM" ? "this room's own" : r.usualBedTypeSource === "ROOM_TYPE" ? "from its room type" : "not set"}
                  </div>
                </td>
                <td className="text-xs">
                  {bedSetupListWords(r.allowedBedTypesSource === "ALL" ? [] : r.effectiveAllowedBedTypes)}
                  <div className="text-[10px] opacity-60">
                    {r.allowedBedTypesSource === "ROOM" ? "this room's own list" : r.allowedBedTypesSource === "ROOM_TYPE" ? "from its room type" : "no limit set"}
                  </div>
                </td>
                <td>{standingWord(r.currentClaimState)}</td>
                <td>{CONDITION_WORD[r.physicalState] ?? r.physicalState}</td>
                <td>{r.isDeficient ? "Yes" : "—"}</td>
                <td>{r.isBlocked ? "Yes" : "—"}</td>
                <td className="text-right">
                  <div className="flex justify-end gap-1">
                    <button
                      type="button"
                      className="admin-btn text-[10px]"
                      onClick={() => startEdit(r)}
                    >
                      Edit
                    </button>
                    {r.isDeficient && (
                      <button
                        type="button"
                        className="admin-btn admin-btn-success text-[10px]"
                        disabled={resolveDeficientMutation.isPending}
                        onClick={async () => {
                          const note = await prompt({
                            title: "Fault put right",
                            message: `Room ${r.roomNumber} — what was fixed? You may leave this empty.`,
                            placeholder: "What was fixed",
                            confirmLabel: "Fault put right",
                            multiline: true,
                          });
                          if (note === null) return;
                          resolveDeficientMutation.mutate({ id: r.id, note: note.trim() || undefined });
                        }}
                      >
                        Fault put right
                      </button>
                    )}
                    {!r.isDeficient && !r.isBlocked && (
                      <button
                        type="button"
                        className="admin-btn text-[10px]"
                        onClick={() =>
                          setDefForm({
                            roomId: r.id,
                            roomNumber: r.roomNumber,
                            category: "",
                            description: "",
                            deadline: "",
                          })
                        }
                      >
                        Report a fault
                      </button>
                    )}
                    {r.isBlocked ? (
                      <button
                        type="button"
                        className="admin-btn admin-btn-success text-[10px]"
                        disabled={reactivateMutation.isPending}
                        onClick={() => reactivateMutation.mutate(r.id)}
                      >
                        Reactivate
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="admin-btn text-[10px]"
                        disabled={deactivateMutation.isPending}
                        onClick={async () => {
                          const ok = await confirm({
                            title: "Deactivate room",
                            message: `Deactivate room ${r.roomNumber}? It will be marked BLOCKED — not bookable until you reactivate it.`,
                            confirmLabel: "Deactivate",
                            variant: "danger",
                          });
                          if (ok) deactivateMutation.mutate(r.id);
                        }}
                      >
                        Deactivate
                      </button>
                    )}
                    <button
                      type="button"
                      className="admin-btn text-[10px] text-destructive"
                      disabled={deleteMutation.isPending}
                      onClick={async () => {
                        if (r.currentClaimState !== "FREE") {
                          toast.error("Only a free room with no history can be deleted — use Deactivate instead");
                          return;
                        }
                        const ok = await confirm({
                          title: "Delete room",
                          message: `Permanently delete room ${r.roomNumber}? This cannot be undone. Use Deactivate if you might want it back later.`,
                          confirmLabel: "Delete",
                          variant: "danger",
                        });
                        if (ok) deleteMutation.mutate(r.id);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        <p className="admin-muted mt-3 text-xs">{rooms.length} room(s)</p>
      </div>
    </div>
  );
}

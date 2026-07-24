"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import {
  createRateCardVersion,
  deleteRateCardOverride,
  listRateCards,
  setRateCardOverride,
  type PartyType,
  type RateCardAdmin,
  type RateCardInput,
} from "@/lib/api/admin";
import { listRoomTypes, type RoomTypeAdmin } from "@/lib/api/admin";
import { ApiError } from "@/lib/api/client";
import { useConfirm } from "@/components/providers/dialog-provider";

type Draft = {
  roomBaseRate: string;
  extraBedRate: string;
  cnbPercent: string;
  breakfastRate: string;
  lunchRate: string;
  dinnerRate: string;
  cpRate: string;
  mapLunchRate: string;
  mapDinnerRate: string;
  apRate: string;
  currency: string;
  notes: string;
};

const EMPTY_DRAFT: Draft = {
  roomBaseRate: "",
  extraBedRate: "",
  cnbPercent: "",
  breakfastRate: "",
  lunchRate: "",
  dinnerRate: "",
  cpRate: "",
  mapLunchRate: "",
  mapDinnerRate: "",
  apRate: "",
  currency: "BTN",
  notes: "",
};

function draftFromCard(card: RateCardAdmin): Draft {
  return {
    roomBaseRate: card.roomBaseRate ?? "",
    extraBedRate: card.extraBedRate ?? "",
    cnbPercent: card.cnbPercent == null ? "" : String(card.cnbPercent),
    breakfastRate: card.breakfastRate ?? "",
    lunchRate: card.lunchRate ?? "",
    dinnerRate: card.dinnerRate ?? "",
    cpRate: card.cpRate ?? "",
    mapLunchRate: card.mapLunchRate ?? "",
    mapDinnerRate: card.mapDinnerRate ?? "",
    apRate: card.apRate ?? "",
    currency: card.currency ?? "BTN",
    notes: card.notes ?? "",
  };
}

function decimalOrNull(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Self-contained Rate Card editor scoped to a single party (TravelAgent or CorporateAccount).
 * Renders:
 *  - the current active rate card's values as a form
 *  - per-room-type overrides
 *  - the version history list
 *
 * Editing & saving creates a NEW rate card version (append-only); active overrides are
 * carried forward automatically by the backend.
 */
export function RateCardEditor({
  partyType,
  partyId,
}: {
  partyType: PartyType;
  partyId: string;
}) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const confirmDialog = useConfirm();
  const enabled = !!session && session.actorLevel === "L4";

  const cardsQuery = useQuery({
    queryKey: ["admin", "rate-cards", partyType, partyId],
    queryFn: () => listRateCards(session!, partyType, partyId),
    enabled,
  });
  const roomTypesQuery = useQuery({
    queryKey: ["admin", "room-types"],
    queryFn: () => listRoomTypes(session!),
    enabled,
  });

  const cards = cardsQuery.data?.cards ?? [];
  const active = cards.find((c) => c.effectiveTo == null) ?? null;
  const history = cards.filter((c) => c.effectiveTo != null);

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  useEffect(() => {
    setDraft(active ? draftFromCard(active) : EMPTY_DRAFT);
  }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveMutation = useMutation({
    mutationFn: () => {
      const body: RateCardInput = {
        partyType,
        partyId,
        roomBaseRate: decimalOrNull(draft.roomBaseRate) ?? 0,
        extraBedRate: decimalOrNull(draft.extraBedRate),
        cnbPercent: draft.cnbPercent.trim() ? Number(draft.cnbPercent) : null,
        breakfastRate: decimalOrNull(draft.breakfastRate),
        lunchRate: decimalOrNull(draft.lunchRate),
        dinnerRate: decimalOrNull(draft.dinnerRate),
        cpRate: decimalOrNull(draft.cpRate),
        mapLunchRate: decimalOrNull(draft.mapLunchRate),
        mapDinnerRate: decimalOrNull(draft.mapDinnerRate),
        apRate: decimalOrNull(draft.apRate),
        currency: draft.currency.trim() || "BTN",
        notes: draft.notes.trim() || null,
      };
      return createRateCardVersion(session!, body);
    },
    onSuccess: () => {
      toast.success("Rate card saved (new version)");
      void queryClient.invalidateQueries({ queryKey: ["admin", "rate-cards", partyType, partyId] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Save failed"),
  });

  const dirty = active ? JSON.stringify(draft) !== JSON.stringify(draftFromCard(active)) : true;
  const canSave = !!draft.roomBaseRate.trim() && decimalOrNull(draft.roomBaseRate) != null;

  /* ----- room-type overrides UI ----- */
  const [overrideRoomTypeId, setOverrideRoomTypeId] = useState("");
  const [overrideRate, setOverrideRate] = useState("");
  const roomTypes: RoomTypeAdmin[] = roomTypesQuery.data?.items ?? [];

  const setOverrideMutation = useMutation({
    mutationFn: () =>
      setRateCardOverride(session!, active!.id, {
        roomTypeId: overrideRoomTypeId,
        roomBaseRate: decimalOrNull(overrideRate) ?? 0,
      }),
    onSuccess: () => {
      toast.success("Override saved");
      setOverrideRoomTypeId("");
      setOverrideRate("");
      void queryClient.invalidateQueries({ queryKey: ["admin", "rate-cards", partyType, partyId] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Save failed"),
  });

  const deleteOverrideMutation = useMutation({
    mutationFn: (overrideId: string) => deleteRateCardOverride(session!, overrideId),
    onSuccess: () => {
      toast.success("Override removed");
      void queryClient.invalidateQueries({ queryKey: ["admin", "rate-cards", partyType, partyId] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Delete failed"),
  });

  async function handleDeleteOverride(o: { id: string; roomType?: { name: string } }) {
    const ok = await confirmDialog({
      title: "Remove override?",
      message: `Remove the per-room-type override for ${o.roomType?.name ?? "this room type"}? The base rate will apply to that room type going forward.`,
      confirmLabel: "Remove",
      variant: "danger",
    });
    if (ok) deleteOverrideMutation.mutate(o.id);
  }

  if (!enabled) return null;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="admin-display text-lg">Rate card</h3>
        <p className="admin-muted text-xs">
          Editing any field and clicking <strong>Save</strong> creates a new version; the prior is closed
          out. Historical bookings always see the rate that was active at the time of the quote.
          Per-room-type overrides are carried forward automatically.
        </p>
      </div>

      <div className="admin-panel space-y-4 p-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <RateField label="Room base rate" value={draft.roomBaseRate} onChange={(v) => setDraft({ ...draft, roomBaseRate: v })} required />
          <RateField label="Extra bed" value={draft.extraBedRate} onChange={(v) => setDraft({ ...draft, extraBedRate: v })} />
          <label className="block space-y-1">
            <span className="admin-muted text-xs">CNB % (child no bed)</span>
            <input type="number" min={0} max={100} step={1} className="admin-input" value={draft.cnbPercent} onChange={(e) => setDraft({ ...draft, cnbPercent: e.target.value })} />
          </label>
        </div>
        <div>
          <p className="admin-eyebrow mb-2">Standalone meal add-ons</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <RateField label="Breakfast" value={draft.breakfastRate} onChange={(v) => setDraft({ ...draft, breakfastRate: v })} />
            <RateField label="Lunch" value={draft.lunchRate} onChange={(v) => setDraft({ ...draft, lunchRate: v })} />
            <RateField label="Dinner" value={draft.dinnerRate} onChange={(v) => setDraft({ ...draft, dinnerRate: v })} />
          </div>
        </div>
        <div>
          <p className="admin-eyebrow mb-2">Meal plan rates (per night)</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <RateField label="CP (room + breakfast)" value={draft.cpRate} onChange={(v) => setDraft({ ...draft, cpRate: v })} />
            <RateField label="MAP lunch (B + L)" value={draft.mapLunchRate} onChange={(v) => setDraft({ ...draft, mapLunchRate: v })} />
            <RateField label="MAP dinner (B + D)" value={draft.mapDinnerRate} onChange={(v) => setDraft({ ...draft, mapDinnerRate: v })} />
            <RateField label="AP (B + L + D)" value={draft.apRate} onChange={(v) => setDraft({ ...draft, apRate: v })} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="admin-muted text-xs">Currency</span>
            <input className="admin-input w-24" value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })} />
          </label>
          <label className="block space-y-1 sm:col-span-1">
            <span className="admin-muted text-xs">Notes (optional)</span>
            <input className="admin-input" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Anything to remember about this rate change…" />
          </label>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="admin-muted text-xs">
            {active ? (
              <>Active since {new Date(active.effectiveFrom).toLocaleDateString()} · v{cards.length}</>
            ) : (
              <em>No rate card yet — fill in the room base rate and save to create one.</em>
            )}
          </div>
          <button type="button" className="admin-btn" disabled={!dirty || !canSave || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            {saveMutation.isPending ? "Saving…" : active ? "Save (new version)" : "Create rate card"}
          </button>
        </div>
      </div>

      {/* Overrides */}
      {active && (
        <div className="admin-panel space-y-3 p-5">
          <div className="flex items-baseline justify-between gap-2">
            <h4 className="admin-display text-base">Per-room-type overrides</h4>
            <p className="admin-muted text-xs">Override the base rate for specific room types. Other room types use the base.</p>
          </div>
          {active.overrides.length === 0 ? (
            <p className="admin-muted text-sm">None — all room types use the base rate of {active.roomBaseRate} {active.currency}.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-[var(--admin-ink-soft)]">
                  <th className="py-1.5">Room type</th>
                  <th className="py-1.5">Rate</th>
                  <th className="py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {active.overrides.map((o) => (
                  <tr key={o.id} className="border-b border-border last:border-0">
                    <td className="py-1.5">{o.roomType?.name ?? o.roomTypeId}</td>
                    <td className="py-1.5 font-mono">{o.roomBaseRate} {active.currency}</td>
                    <td className="py-1.5 text-right">
                      <button type="button" className="admin-btn admin-btn-ghost admin-btn-sm" onClick={() => handleDeleteOverride(o)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
            <label className="block space-y-1">
              <span className="admin-muted text-xs">Add / update for room type</span>
              <select className="admin-input" value={overrideRoomTypeId} onChange={(e) => setOverrideRoomTypeId(e.target.value)}>
                <option value="">— pick —</option>
                {roomTypes.map((rt) => (
                  <option key={rt.id} value={rt.id}>{rt.name} ({rt.code})</option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="admin-muted text-xs">Rate</span>
              <input className="admin-input w-28" type="number" min={0} step="0.01" value={overrideRate} onChange={(e) => setOverrideRate(e.target.value)} placeholder="0.00" />
            </label>
            <button
              type="button"
              className="admin-btn"
              disabled={!overrideRoomTypeId || !overrideRate.trim() || setOverrideMutation.isPending}
              onClick={() => setOverrideMutation.mutate()}
            >
              Save override
            </button>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div className="admin-panel space-y-2 p-5">
          <h4 className="admin-display text-base">Version history</h4>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border uppercase tracking-wide text-[var(--admin-ink-soft)]">
                <th className="py-1.5">Active range</th>
                <th className="py-1.5">Base rate</th>
                <th className="py-1.5">Currency</th>
                <th className="py-1.5">Notes</th>
              </tr>
            </thead>
            <tbody>
              {history.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0">
                  <td className="py-1.5 font-mono">{new Date(c.effectiveFrom).toLocaleDateString()} → {c.effectiveTo ? new Date(c.effectiveTo).toLocaleDateString() : "—"}</td>
                  <td className="py-1.5 font-mono">{c.roomBaseRate}</td>
                  <td className="py-1.5">{c.currency}</td>
                  <td className="py-1.5">{c.notes ?? <span className="admin-muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RateField({ label, value, onChange, required }: { label: string; value: string; onChange: (v: string) => void; required?: boolean }) {
  return (
    <label className="block space-y-1">
      <span className="admin-muted text-xs">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      <input
        className="admin-input"
        type="number"
        min={0}
        step="0.01"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0.00"
      />
    </label>
  );
}

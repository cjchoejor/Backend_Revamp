"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "@/lib/api/client";
import { getHotelProfile, updateHotelProfile, type HotelProfileAdmin } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";

export default function AdminHotelProfilePage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const profileQuery = useQuery({
    queryKey: ["admin", "hotel-profile"],
    queryFn: () => getHotelProfile(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const [draft, setDraft] = useState<Partial<HotelProfileAdmin> | null>(null);
  const [jsonFields, setJsonFields] = useState({
    contactNumbers: "",
    operatingHours: "",
    publicHolidaySchedule: "",
  });

  useEffect(() => {
    const row = profileQuery.data;
    if (!row) return;
    setDraft(row);
    setJsonFields({
      contactNumbers: JSON.stringify(row.contactNumbers ?? [], null, 2),
      operatingHours: JSON.stringify(row.operatingHours ?? {}, null, 2),
      publicHolidaySchedule: JSON.stringify(row.publicHolidaySchedule ?? [], null, 2),
    });
  }, [profileQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("No profile loaded");
      let contactNumbers: unknown;
      let operatingHours: unknown;
      let publicHolidaySchedule: unknown;
      try {
        contactNumbers = JSON.parse(jsonFields.contactNumbers || "[]");
        operatingHours = JSON.parse(jsonFields.operatingHours || "{}");
        publicHolidaySchedule = JSON.parse(jsonFields.publicHolidaySchedule || "[]");
      } catch {
        throw new Error("One of the JSON fields is invalid");
      }
      return updateHotelProfile(session!, {
        expectedVersion: draft.version,
        hotelName: draft.hotelName ?? "",
        registeredAddress: draft.registeredAddress ?? "",
        tradingAddress: draft.tradingAddress ?? null,
        primaryEmail: draft.primaryEmail ?? "",
        timeZone: draft.timeZone ?? "",
        propertyCurrency: draft.propertyCurrency ?? "",
        contactNumbers,
        operatingHours,
        publicHolidaySchedule,
      });
    },
    onSuccess: () => {
      toast.success("Hotel profile saved");
      void queryClient.invalidateQueries({ queryKey: ["admin", "hotel-profile"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Save failed"),
  });

  const row = profileQuery.data;
  const isBusy = profileQuery.isLoading || saveMutation.isPending;
  const canRender = !!session && session.actorLevel === "L4";

  const header = useMemo(() => {
    if (!row) return null;
    return (
      <div className="admin-panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="admin-display text-lg">{row.hotelName}</h2>
            <p className="admin-muted text-xs">Version {row.version}</p>
          </div>
          <button type="button" className="admin-btn" disabled={isBusy} onClick={() => saveMutation.mutate()}>
            Save
          </button>
        </div>
      </div>
    );
  }, [row, isBusy, saveMutation]);

  if (!canRender) return null;

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 01 · Identity</p>
        <h1 className="admin-display text-3xl">Hotel profile</h1>
        <p className="admin-muted mt-2 max-w-2xl text-sm">Single-row property identity record used across templates and invoices.</p>
      </div>

      {header}

      {profileQuery.isError && (
        <div className="admin-panel p-4 text-sm text-red-200">
          {profileQuery.error instanceof ApiError ? profileQuery.error.message : "Failed to load hotel profile"}
        </div>
      )}

      {draft && (
        <div className="admin-panel grid gap-4 p-5 md:grid-cols-2">
          <h2 className="admin-display col-span-full text-lg">Core fields</h2>
          <input className="admin-input" value={draft.hotelName ?? ""} onChange={(e) => setDraft({ ...draft, hotelName: e.target.value })} placeholder="Hotel name" />
          <input className="admin-input" value={draft.primaryEmail ?? ""} onChange={(e) => setDraft({ ...draft, primaryEmail: e.target.value })} placeholder="Primary email" />
          <input className="admin-input md:col-span-2" value={draft.registeredAddress ?? ""} onChange={(e) => setDraft({ ...draft, registeredAddress: e.target.value })} placeholder="Registered address" />
          <input className="admin-input md:col-span-2" value={draft.tradingAddress ?? ""} onChange={(e) => setDraft({ ...draft, tradingAddress: e.target.value || null })} placeholder="Trading address (optional)" />
          <input className="admin-input" value={draft.timeZone ?? ""} onChange={(e) => setDraft({ ...draft, timeZone: e.target.value })} placeholder="Time zone (IANA)" />
          <input className="admin-input" value={draft.propertyCurrency ?? ""} onChange={(e) => setDraft({ ...draft, propertyCurrency: e.target.value })} placeholder="Currency (e.g. BTN)" />

          <h2 className="admin-display col-span-full mt-4 text-lg">Structured JSON fields</h2>
          <div className="md:col-span-2">
            <div className="admin-muted mb-1 text-xs">contactNumbers</div>
            <textarea className="admin-textarea min-h-[120px]" value={jsonFields.contactNumbers} onChange={(e) => setJsonFields({ ...jsonFields, contactNumbers: e.target.value })} />
          </div>
          <div className="md:col-span-2">
            <div className="admin-muted mb-1 text-xs">operatingHours</div>
            <textarea className="admin-textarea min-h-[120px]" value={jsonFields.operatingHours} onChange={(e) => setJsonFields({ ...jsonFields, operatingHours: e.target.value })} />
          </div>
          <div className="md:col-span-2">
            <div className="admin-muted mb-1 text-xs">publicHolidaySchedule</div>
            <textarea
              className="admin-textarea min-h-[120px]"
              value={jsonFields.publicHolidaySchedule}
              onChange={(e) => setJsonFields({ ...jsonFields, publicHolidaySchedule: e.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  );
}


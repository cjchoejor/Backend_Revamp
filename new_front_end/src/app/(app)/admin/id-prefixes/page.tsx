"use client";

import { Help } from "@/components/ds/help";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { listIdPrefixAssignments, resetIdPrefix, setIdPrefix, type IdPrefixEntry } from "@/lib/api/admin";
import { ApiError } from "@/lib/api/client";

const ENTITY_LABEL: Record<string, string> = {
  INQUIRY: "Inquiry",
  ENTRY: "Entry",
  FOLIO: "Folio",
  QUOTATION: "Quotation",
  INVOICE: "Invoice",
  RESERVATION: "Reservation",
  AMENDMENT: "Amendment",
  COMMISSION_DUE: "Commission due",
  COMMUNICATION: "Communication",
  CREDIT_EXTENSION: "Credit extension",
  DISPUTE: "Dispute",
  HANDOFF: "Handoff",
  KEY_RETURN: "Key return",
  LOST_AND_FOUND: "Lost & Found",
  NIGHT_AUDIT: "Night audit",
  NO_SHOW: "No-show",
  PAYMENT: "Payment",
  ROOM_ASSIGNMENT: "Room assignment",
  ROOM_INSPECTION: "Room inspection",
  WORK_ORDER: "Work order",
  EARLY_DEPARTURE: "Early departure",
  ROOM_MOVE: "Room move",
  VOUCHER: "Confirmation voucher",
  REFUND: "Refund",
  TRAVEL_AGENT: "Travel agent",
  CORPORATE_ACCOUNT: "Corporate account",
  RATE_CARD: "Rate card",
  STAFF_USER: "Staff user",
  ROLE: "Role",
  DEPARTMENT: "Department",
  SESSION: "Session",
};

function PrefixRow({
  row,
  onSave,
  onReset,
  saving,
}: {
  row: IdPrefixEntry;
  onSave: (entity: string, prefix: string) => void;
  onReset: (entity: string) => void;
  saving: boolean;
}) {
  const day = useHotelDay();
  const [draft, setDraft] = useState(row.currentPrefix);
  // Sync the draft if the server value changes (e.g. someone else edited it).
  useEffect(() => setDraft(row.currentPrefix), [row.currentPrefix]);

  const dirty = draft !== row.currentPrefix;
  const looksValid = /^[A-Z]{2,4}$/.test(draft);

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-3 py-2 align-middle">
        <span className="text-sm font-medium">{ENTITY_LABEL[row.entity] ?? row.entity}</span>
      </td>
      <td className="px-3 py-2 align-middle">
        <input
          className="admin-input w-24 font-mono uppercase"
          maxLength={4}
          value={draft}
          onChange={(e) => setDraft(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))}
          disabled={saving}
        />
      </td>
      <td className="px-3 py-2 align-middle text-xs font-mono text-[var(--admin-ink-soft)]">{row.defaultPrefix}</td>
      <td className="px-3 py-2 align-middle text-xs">
        {row.isOverridden ? (
          <span className="admin-tag">overridden</span>
        ) : (
          <span className="admin-muted">default</span>
        )}
      </td>
      <td className="px-3 py-2 align-middle text-xs font-mono text-[var(--admin-ink-soft)]">
        {draft}-{day ? day.today.replace(/-/g, "") : "date"}-0001
      </td>
      <td className="px-3 py-2 align-middle">
        <div className="flex gap-1.5">
          <button
            type="button"
            className="admin-btn admin-btn-sm"
            disabled={!dirty || !looksValid || saving}
            onClick={() => onSave(row.entity, draft)}
          >
            Save
          </button>
          {row.isOverridden && (
            <button
              type="button"
              className="admin-btn admin-btn-ghost admin-btn-sm"
              disabled={saving}
              onClick={() => onReset(row.entity)}
            >
              Reset
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

export default function AdminIdPrefixesPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const enabled = !!session && session.actorLevel === "L4";

  const assignmentsQuery = useQuery({
    queryKey: ["admin", "id-prefixes"],
    queryFn: () => listIdPrefixAssignments(session!),
    enabled,
  });

  const saveMutation = useMutation({
    mutationFn: (vars: { entity: string; prefix: string }) => setIdPrefix(session!, vars),
    onSuccess: (data) => {
      toast.success("Prefix saved");
      queryClient.setQueryData(["admin", "id-prefixes"], data);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Save failed"),
  });

  const resetMutation = useMutation({
    mutationFn: (entity: string) => resetIdPrefix(session!, { entity }),
    onSuccess: (data) => {
      toast.success("Reset to default");
      queryClient.setQueryData(["admin", "id-prefixes"], data);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Reset failed"),
  });

  if (!session || session.actorLevel !== "L4") return null;

  const rows = assignmentsQuery.data?.assignments ?? [];
  const saving = saveMutation.isPending || resetMutation.isPending;

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">The hotel and its people</p>
        <h1 className="admin-display flex items-center gap-2 text-3xl">
          Number prefixes
          <Help label="Number prefixes">A prefix is two to four capital letters, and no two kinds of record can share one. A change counts from the next number given out. Booking, invoice and other numbers read PREFIX-date-number. Change a prefix here and new numbers use it; numbers already given stay as they are. A prefix is 2 to 4 capital letters, and no two may be the same.</Help>
        </h1>
      </div>

      <div className="admin-panel overflow-x-auto p-0">
        <table className="w-full text-left">
          <thead className="border-b border-border bg-[var(--admin-bg)]/50">
            <tr className="text-xs uppercase tracking-wide text-[var(--admin-ink-soft)]">
              <th className="px-3 py-2">Entity</th>
              <th className="px-3 py-2">Current prefix</th>
              <th className="px-3 py-2">Default</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Preview</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <PrefixRow
                key={row.entity}
                row={row}
                onSave={(entity, prefix) => saveMutation.mutate({ entity, prefix })}
                onReset={(entity) => resetMutation.mutate(entity)}
                saving={saving}
              />
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-6 text-center text-sm text-[var(--admin-ink-soft)]" colSpan={6}>
                  {assignmentsQuery.isLoading ? "Loading…" : "No numbers are set up"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

    </div>
  );
}

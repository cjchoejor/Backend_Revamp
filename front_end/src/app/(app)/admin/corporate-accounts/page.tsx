"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import {
  createCorporateAccount,
  deactivateCorporateAccount,
  listCorporateAccounts,
  reactivateCorporateAccount,
  updateCorporateAccount,
  type ContactMode,
  type CorporateAccountAdmin,
  type CorporateAccountInput,
} from "@/lib/api/admin";
import { ApiError } from "@/lib/api/client";
import { useConfirm } from "@/components/providers/dialog-provider";
import { RateCardEditor } from "@/components/admin/rate-card-editor";
import { VersionsTab } from "@/components/admin/versions-tab";

const CONTACT_MODES: ContactMode[] = ["PHONE", "EMAIL", "WHATSAPP", "IN_PERSON", "OTHER"];
const EMPTY: CorporateAccountInput = { displayName: "", modeOfContact: "EMAIL" };

export default function AdminCorporateAccountsPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const confirmDialog = useConfirm();
  const enabled = !!session && session.actorLevel === "L4";
  const [showInactive, setShowInactive] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CorporateAccountInput>(EMPTY);

  const accountsQuery = useQuery({
    queryKey: ["admin", "corporate-accounts", showInactive],
    queryFn: () => listCorporateAccounts(session!, { includeInactive: showInactive }),
    enabled,
  });
  const accounts = accountsQuery.data?.accounts ?? [];
  const selected: CorporateAccountAdmin | null =
    selectedId === "new" ? null : accounts.find((a) => a.id === selectedId) ?? null;
  const isNewMode = selectedId === "new";

  function startNew() {
    setSelectedId("new");
    setDraft(EMPTY);
  }
  function selectAccount(a: CorporateAccountAdmin) {
    setSelectedId(a.id);
    setDraft({
      displayName: a.displayName,
      contactNumber: a.contactNumber,
      contactEmail: a.contactEmail,
      modeOfContact: a.modeOfContact,
      gstNumber: a.gstNumber,
      billingAddress: a.billingAddress,
      notes: a.notes,
      isActive: a.isActive,
    });
  }

  const createMutation = useMutation({
    mutationFn: () => createCorporateAccount(session!, draft),
    onSuccess: (created) => {
      toast.success("Corporate account created");
      void queryClient.invalidateQueries({ queryKey: ["admin", "corporate-accounts"] });
      setSelectedId(created.id);
      selectAccount(created);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Create failed"),
  });

  const updateMutation = useMutation({
    mutationFn: () => updateCorporateAccount(session!, selectedId!, draft),
    onSuccess: (updated) => {
      toast.success("Saved");
      void queryClient.invalidateQueries({ queryKey: ["admin", "corporate-accounts"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "versions", "CorporateAccount", updated.id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Save failed"),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: (a: CorporateAccountAdmin) =>
      a.isActive ? deactivateCorporateAccount(session!, a.id) : reactivateCorporateAccount(session!, a.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["admin", "corporate-accounts"] }),
  });

  if (!enabled) return null;

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 03 · Commercial</p>
        <h1 className="admin-display text-3xl">Corporate accounts</h1>
        <p className="admin-muted mt-2 max-w-2xl text-sm">
          Companies with negotiated rates. Same rate-card shape as travel agents (base rate,
          per-room-type overrides, meal plans, meal add-ons, CNB %) plus billing fields (GST
          number, billing address). Saving the rate card creates a new version; historical
          bookings always see the rate active at the time they were quoted.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <div className="admin-panel max-h-[80vh] space-y-2 overflow-y-auto p-3">
          <div className="flex items-center justify-between gap-2">
            <button type="button" className="admin-btn admin-btn-sm" onClick={startNew}>+ New corporate</button>
            <label className="flex items-center gap-1 text-xs text-[var(--admin-ink-soft)]">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Inactive
            </label>
          </div>
          <ul className="space-y-0.5">
            {accounts.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className={`block w-full truncate rounded px-2 py-1.5 text-left text-sm ${
                    selectedId === a.id ? "bg-[var(--admin-brass-glow)] text-[var(--admin-brass)]" : "text-[var(--admin-ink-soft)] hover:bg-[var(--admin-bg)]/50"
                  }`}
                  onClick={() => selectAccount(a)}
                >
                  <span className="font-medium">{a.displayName}</span>
                  <br />
                  <span className="font-mono text-[10px] opacity-60">{a.id}</span>
                  {!a.isActive && <span className="ml-2 text-[10px] uppercase opacity-60">inactive</span>}
                </button>
              </li>
            ))}
            {accounts.length === 0 && (
              <li className="px-2 py-2 text-xs text-[var(--admin-ink-soft)]">No accounts yet — click &ldquo;+ New corporate&rdquo; to create one.</li>
            )}
          </ul>
        </div>

        <div className="space-y-6">
          {selectedId == null && (
            <div className="admin-panel p-8 text-center text-sm text-[var(--admin-ink-soft)]">
              Select an account from the list or click <strong>+ New corporate</strong> to begin.
            </div>
          )}
          {selectedId != null && (
            <>
              <div className="admin-panel space-y-4 p-5">
                <h2 className="admin-display text-xl">
                  {isNewMode ? "New corporate account" : selected?.displayName}
                </h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block space-y-1">
                    <span className="admin-muted text-xs">Display name <span className="text-red-500">*</span></span>
                    <input className="admin-input" value={draft.displayName ?? ""} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />
                  </label>
                  <label className="block space-y-1">
                    <span className="admin-muted text-xs">Mode of contact</span>
                    <select className="admin-input" value={draft.modeOfContact ?? "EMAIL"} onChange={(e) => setDraft({ ...draft, modeOfContact: e.target.value as ContactMode })}>
                      {CONTACT_MODES.map((m) => <option key={m} value={m}>{m.replace("_", " ")}</option>)}
                    </select>
                  </label>
                  <label className="block space-y-1">
                    <span className="admin-muted text-xs">Contact number</span>
                    <input className="admin-input" value={draft.contactNumber ?? ""} onChange={(e) => setDraft({ ...draft, contactNumber: e.target.value })} />
                  </label>
                  <label className="block space-y-1">
                    <span className="admin-muted text-xs">Email</span>
                    <input className="admin-input" type="email" value={draft.contactEmail ?? ""} onChange={(e) => setDraft({ ...draft, contactEmail: e.target.value })} />
                  </label>
                  <label className="block space-y-1">
                    <span className="admin-muted text-xs">GST number</span>
                    <input className="admin-input" value={draft.gstNumber ?? ""} onChange={(e) => setDraft({ ...draft, gstNumber: e.target.value })} placeholder="e.g. 12ABCDE3456F1Z5" />
                  </label>
                  <label className="block space-y-1">
                    <span className="admin-muted text-xs">Billing address</span>
                    <input className="admin-input" value={draft.billingAddress ?? ""} onChange={(e) => setDraft({ ...draft, billingAddress: e.target.value })} />
                  </label>
                  <label className="block space-y-1 sm:col-span-2">
                    <span className="admin-muted text-xs">Notes</span>
                    <textarea className="admin-input min-h-[60px]" value={draft.notes ?? ""} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
                  </label>
                </div>
                <div className="flex items-center justify-between gap-3">
                  {selected && (
                    <button
                      type="button"
                      className="admin-btn admin-btn-ghost admin-btn-sm"
                      onClick={async () => {
                        const ok = await confirmDialog({
                          title: selected.isActive ? "Deactivate account?" : "Reactivate account?",
                          message: selected.isActive
                            ? "Deactivated accounts are hidden from the front-desk picker but retain their rate-card history."
                            : "Reactivated accounts become available in the picker again.",
                          confirmLabel: selected.isActive ? "Deactivate" : "Reactivate",
                          variant: selected.isActive ? "danger" : "default",
                        });
                        if (ok) toggleActiveMutation.mutate(selected);
                      }}
                    >
                      {selected.isActive ? "Deactivate" : "Reactivate"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="admin-btn ml-auto"
                    disabled={!draft.displayName?.trim() || createMutation.isPending || updateMutation.isPending}
                    onClick={() => (isNewMode ? createMutation.mutate() : updateMutation.mutate())}
                  >
                    {isNewMode ? "Create" : "Save"}
                  </button>
                </div>
              </div>

              {!isNewMode && selected && (
                <>
                  <RateCardEditor partyType="CORPORATE" partyId={selected.id} />
                  <div className="admin-panel p-5">
                    <VersionsTab
                      entityType="CorporateAccount"
                      entityId={selected.id}
                      invalidateOnRestore={[["admin", "corporate-accounts", true], ["admin", "corporate-accounts", false]]}
                    />
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

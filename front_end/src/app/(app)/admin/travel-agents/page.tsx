"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import {
  createTravelAgent,
  deactivateTravelAgent,
  listTravelAgents,
  reactivateTravelAgent,
  updateTravelAgent,
  type ContactMode,
  type TravelAgentAdmin,
  type TravelAgentInput,
} from "@/lib/api/admin";
import { ApiError } from "@/lib/api/client";
import { useConfirm } from "@/components/providers/dialog-provider";
import { RatePackagesEditor } from "@/components/admin/rate-packages-editor";
import { VersionsTab } from "@/components/admin/versions-tab";

const CONTACT_MODES: ContactMode[] = ["PHONE", "EMAIL", "WHATSAPP", "IN_PERSON", "OTHER"];
const EMPTY: TravelAgentInput = { displayName: "", modeOfContact: "PHONE" };

export default function AdminTravelAgentsPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const confirmDialog = useConfirm();
  const enabled = !!session && session.actorLevel === "L4";
  const [showInactive, setShowInactive] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TravelAgentInput>(EMPTY);

  const agentsQuery = useQuery({
    queryKey: ["admin", "travel-agents", showInactive],
    queryFn: () => listTravelAgents(session!, { includeInactive: showInactive }),
    enabled,
  });
  const agents = agentsQuery.data?.agents ?? [];
  const selected: TravelAgentAdmin | null =
    selectedId === "new" ? null : agents.find((a) => a.id === selectedId) ?? null;

  const isNewMode = selectedId === "new";

  function startNew() {
    setSelectedId("new");
    setDraft(EMPTY);
  }
  function selectAgent(a: TravelAgentAdmin) {
    setSelectedId(a.id);
    setDraft({
      displayName: a.displayName,
      contactNumbers: a.contactNumbers ?? [],
      contactEmail: a.contactEmail,
      modeOfContact: a.modeOfContact,
      notes: a.notes,
      isActive: a.isActive,
    });
  }

  const createMutation = useMutation({
    mutationFn: () => createTravelAgent(session!, draft),
    onSuccess: (created) => {
      toast.success("Travel agent created");
      void queryClient.invalidateQueries({ queryKey: ["admin", "travel-agents"] });
      setSelectedId(created.id);
      selectAgent(created);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Create failed"),
  });

  const updateMutation = useMutation({
    mutationFn: () => updateTravelAgent(session!, selectedId!, draft),
    onSuccess: (updated) => {
      toast.success("Saved");
      void queryClient.invalidateQueries({ queryKey: ["admin", "travel-agents"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "versions", "TravelAgent", updated.id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Save failed"),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: (a: TravelAgentAdmin) =>
      a.isActive ? deactivateTravelAgent(session!, a.id) : reactivateTravelAgent(session!, a.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["admin", "travel-agents"] }),
  });

  if (!enabled) return null;

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 03 · Commercial</p>
        <h1 className="admin-display text-3xl">Travel agents</h1>
        <p className="admin-muted mt-2 max-w-2xl text-sm">
          Travel agencies the hotel works with. This page holds the agency&rsquo;s <strong>identity</strong> —
          name, contacts, notes. Its <strong>rates</strong> live in packages: one agency can carry Season,
          Off season and Premium side by side, and the operator picks which applies when quoting. Saving a
          package creates a new version, so a booking always keeps the rate it was quoted on.
          Select no agent to edit the <strong>common package</strong> used when a party has none of its own.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <div className="admin-panel max-h-[80vh] space-y-2 overflow-y-auto p-3">
          <div className="flex items-center justify-between gap-2">
            <button type="button" className="admin-btn admin-btn-sm" onClick={startNew}>+ New agent</button>
            <label className="flex items-center gap-1 text-xs text-[var(--admin-ink-soft)]">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Inactive
            </label>
          </div>
          <ul className="space-y-0.5">
            {agents.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className={`block w-full truncate rounded px-2 py-1.5 text-left text-sm ${
                    selectedId === a.id ? "bg-[var(--admin-brass-glow)] text-[var(--admin-brass)]" : "text-[var(--admin-ink-soft)] hover:bg-[var(--admin-bg)]/50"
                  }`}
                  onClick={() => selectAgent(a)}
                >
                  <span className="font-medium">{a.displayName}</span>
                  <br />
                  <span className="font-mono text-[10px] opacity-60">{a.id}</span>
                  {!a.isActive && <span className="ml-2 text-[10px] uppercase opacity-60">inactive</span>}
                </button>
              </li>
            ))}
            {agents.length === 0 && (
              <li className="px-2 py-2 text-xs text-[var(--admin-ink-soft)]">No agents yet — click &ldquo;+ New agent&rdquo; to create one.</li>
            )}
          </ul>
        </div>

        <div className="space-y-6">
          {selectedId == null && (
            <div className="admin-panel p-8 text-center text-sm text-[var(--admin-ink-soft)]">
              <p>Select an agent from the list or click <strong>+ New agent</strong> to begin.</p>
              {/* The fallback has its own page — editing it here as well would give one hotel-wide
                  setting two homes, and this empty state is where it was previously undiscoverable. */}
              <p className="mt-3 text-xs">
                Looking for the rate used by an agency that has no package yet? That is the{" "}
                <a className="underline" href="/admin/common-rate-package">Common rate package</a>.
              </p>
            </div>
          )}
          {selectedId != null && (
            <>
              <div className="admin-panel space-y-4 p-5">
                <h2 className="admin-display text-xl">
                  {isNewMode ? "New travel agent" : selected?.displayName}
                </h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block space-y-1">
                    <span className="admin-muted text-xs">Display name <span className="text-red-500">*</span></span>
                    <input className="admin-input" value={draft.displayName ?? ""} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />
                  </label>
                  <label className="block space-y-1">
                    <span className="admin-muted text-xs">Mode of contact</span>
                    <select className="admin-input" value={draft.modeOfContact ?? "PHONE"} onChange={(e) => setDraft({ ...draft, modeOfContact: e.target.value as ContactMode })}>
                      {CONTACT_MODES.map((m) => <option key={m} value={m}>{m.replace("_", " ")}</option>)}
                    </select>
                  </label>
                  <label className="block space-y-1">
                    <span className="admin-muted text-xs">Contact numbers</span>
                    {/* An agency usually has several (office, owner, WhatsApp). Comma-separated
                        in, array out — the service trims, drops blanks and de-duplicates. */}
                    <input
                      className="admin-input"
                      placeholder="17123456, 77123456"
                      value={(draft.contactNumbers ?? []).join(", ")}
                      onChange={(e) => setDraft({ ...draft, contactNumbers: e.target.value.split(",").map((s) => s.trim()) })}
                    />
                    <span className="admin-muted block text-[10px] opacity-70">Separate multiple numbers with commas.</span>
                  </label>
                  <label className="block space-y-1">
                    <span className="admin-muted text-xs">Email</span>
                    <input className="admin-input" type="email" value={draft.contactEmail ?? ""} onChange={(e) => setDraft({ ...draft, contactEmail: e.target.value })} />
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
                          title: selected.isActive ? "Deactivate agent?" : "Reactivate agent?",
                          message: selected.isActive
                            ? "Deactivated agents are hidden from the front-desk picker but retain their rate-card history."
                            : "Reactivated agents become available in the picker again.",
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
                  <RatePackagesEditor owner={{ travelAgentId: selected.id }} ownerLabel={selected.displayName} />
                  <div className="admin-panel p-5">
                    <VersionsTab
                      entityType="TravelAgent"
                      entityId={selected.id}
                      invalidateOnRestore={[["admin", "travel-agents", true], ["admin", "travel-agents", false]]}
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

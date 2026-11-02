"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Control } from "@/components/admin/setting-form";
import { Help } from "@/components/ds/help";
import { activateMode, deactivateMode, listModes, saveMode, type ModeAdmin } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";

const STAGES = [
  { value: "S1", label: "Inquiry" },
  { value: "S2", label: "Negotiation" },
  { value: "S3", label: "Set up" },
  { value: "S4", label: "Reserve" },
  { value: "S5", label: "Arrival" },
  { value: "S6", label: "Check-in" },
  { value: "S7", label: "Stay" },
  { value: "S8", label: "Check-out" },
  { value: "S9", label: "Closed" },
  { value: "TERMINAL", label: "Ended" },
];
const stageWord = (s: string) => STAGES.find((x) => x.value === s)?.label ?? s;

/** The skips the system knows how to judge (lib/mode-auto-fulfilment). Any other is never skipped. */
const CONDITIONS = [
  { value: "SAME_RATE_AS_FROZEN_RESERVATION", label: "The rate has not changed" },
  { value: "INVENTORY_ALREADY_COMMITTED_FOR_NEW_NIGHTS", label: "The extra nights are already held" },
  { value: "WITHIN_ORIGINAL_GROUP_THRESHOLD", label: "The party is still below a group" },
];

const NEEDS = [
  { value: "AvailabilityEngine", label: "Room availability" },
  { value: "PricingPipelineEngine", label: "Pricing" },
  { value: "RatePlanRegistry", label: "Rate plans" },
  { value: "SeasonCalendar", label: "Seasons" },
  { value: "CommunicationConfigService", label: "Messages" },
  { value: "CancellationPolicyRegistry", label: "Cancellation policies" },
  { value: "RoomAssignmentService", label: "Room assignment" },
  { value: "DiscountAuthorityPolicy", label: "Discount limits" },
  { value: "GroupDetectionPolicy", label: "Group detection" },
  { value: "GuestProfileService", label: "Guest records" },
  { value: "DisputeService", label: "Disputes" },
  { value: "FolioService", label: "The bill" },
  { value: "BillingModelPolicy", label: "Who pays" },
  { value: "FolioSettlementService", label: "Settling the bill" },
];

const STATE_WORD: Record<string, string> = { DRAFT: "Draft", VALIDATED: "Ready", ACTIVE: "In use", SUPERSEDED: "Replaced" };

type Draft = {
  id?: string;
  modeKey: string;
  displayName: string;
  description: string;
  isPredefined: boolean;
  stageRoute: string[];
  autoFulfilmentConditions: { stage: string; condition: string }[];
  featureDependencies: string[];
};

const EMPTY: Draft = {
  modeKey: "",
  displayName: "",
  description: "",
  isPredefined: false,
  stageRoute: [],
  autoFulfilmentConditions: [],
  featureDependencies: [],
};

const draftFromRow = (m: ModeAdmin): Draft => ({
  id: m.id,
  modeKey: m.modeKey,
  displayName: m.displayName,
  description: m.description ?? "",
  isPredefined: m.isPredefined,
  stageRoute: Array.isArray(m.stageRoute) ? m.stageRoute : [],
  autoFulfilmentConditions: Array.isArray(m.autoFulfilmentConditions) ? m.autoFulfilmentConditions : [],
  featureDependencies: Array.isArray(m.featureDependencies) ? m.featureDependencies : [],
});

export default function AdminKindsOfChangePage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);

  const query = useQuery({
    queryKey: ["admin", "modes"],
    queryFn: () => listModes(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const saveMutation = useMutation({
    mutationFn: () => {
      const d = draft!;
      return saveMode(session!, {
        id: d.id,
        modeKey: d.modeKey.trim(),
        displayName: d.displayName.trim(),
        description: d.description.trim() || null,
        isPredefined: d.isPredefined,
        stageRoute: d.stageRoute,
        autoFulfilmentConditions: d.autoFulfilmentConditions,
        featureDependencies: d.featureDependencies,
      });
    },
    onSuccess: () => {
      toast.success(draft?.id ? "Saved as a new version. Put it in use when it is ready." : "Added");
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: ["admin", "modes"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Save failed"),
  });

  const activateMutation = useMutation({
    mutationFn: (id: string) => activateMode(session!, id),
    onSuccess: () => {
      toast.success("In use");
      void queryClient.invalidateQueries({ queryKey: ["admin", "modes"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "It could not be put in use"),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => deactivateMode(session!, id),
    onSuccess: () => {
      toast.success("No longer in use");
      void queryClient.invalidateQueries({ queryKey: ["admin", "modes"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "It could not be taken out of use"),
  });

  if (!session || session.actorLevel !== "L4") return null;
  const items = query.data?.items ?? [];

  return (
    <div className="space-y-8 pb-16">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="admin-eyebrow mb-2">Rules</p>
          <h1 className="admin-display flex items-center gap-2 text-3xl">
            Kinds of change
            <Help label="Kinds of change">
              Each kind of change to a booking, such as a room change or a new rate, and the steps it goes back through. Taking one out of use stops that change being made on any booking. A new version waits until you put it in use.
            </Help>
          </h1>
        </div>
        {!draft ? (
          <button type="button" className="admin-btn" onClick={() => setDraft({ ...EMPTY })}>
            Add a kind of change
          </button>
        ) : null}
      </div>

      {draft ? (
        <div className="admin-panel space-y-4 p-5">
          <h2 className="admin-display text-lg">{draft.id ? draft.displayName : "A new kind of change"}</h2>

          <div className="sf-grid">
            <div className="sf-field">
              <span className="sf-label">Name</span>
              <input className="admin-input" value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />
            </div>
            {!draft.isPredefined ? (
              <div className="sf-field">
                <span className="sf-label">
                  Short code
                  <Help label="Short code">A short name the system keeps for this. Keep it once it is in use.</Help>
                </span>
                <input className="admin-input" placeholder="ROOM_CHANGE" value={draft.modeKey} onChange={(e) => setDraft({ ...draft, modeKey: e.target.value })} />
              </div>
            ) : null}
          </div>

          <div className="sf-field">
            <span className="sf-label">What it is for</span>
            <input className="admin-input" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </div>

          <div className="sf-field">
            <span className="sf-label">
              The steps it goes through
              <Help label="The steps it goes through">Click a step to add it or take it off. Use the arrows to put them in order.</Help>
            </span>
            <Control
              f={{ kind: "multi", label: "The steps", options: STAGES }}
              value={draft.stageRoute}
              onChange={(v) => setDraft({ ...draft, stageRoute: v as string[] })}
            />
            {draft.stageRoute.length > 0 ? (
              <ol className="mt-2 flex flex-wrap items-center gap-2">
                {draft.stageRoute.map((s, i) => (
                  <li key={`${s}-${i}`} className="sf-tag">
                    <span>
                      {i + 1}. {stageWord(s)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Move ${stageWord(s)} earlier`}
                      disabled={i === 0}
                      onClick={() => {
                        const next = [...draft.stageRoute];
                        [next[i - 1], next[i]] = [next[i], next[i - 1]];
                        setDraft({ ...draft, stageRoute: next });
                      }}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${stageWord(s)} later`}
                      disabled={i === draft.stageRoute.length - 1}
                      onClick={() => {
                        const next = [...draft.stageRoute];
                        [next[i + 1], next[i]] = [next[i], next[i + 1]];
                        setDraft({ ...draft, stageRoute: next });
                      }}
                    >
                      →
                    </button>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>

          <div className="sf-field">
            <span className="sf-label">
              A step it can skip
              <Help label="A step it can skip">The system skips the step by itself when this holds.</Help>
            </span>
            <Control
              f={{
                kind: "rows",
                label: "A step it can skip",
                addLabel: "Add a step it can skip",
                word: ["step", "steps"],
                emptyText: "It goes through every step.",
                blank: { stage: "S2", condition: "SAME_RATE_AS_FROZEN_RESERVATION" },
                columns: [
                  { kind: "select", key: "stage", label: "Step", options: STAGES },
                  { kind: "select", key: "condition", label: "When", options: CONDITIONS },
                ],
              }}
              value={draft.autoFulfilmentConditions}
              onChange={(v) => setDraft({ ...draft, autoFulfilmentConditions: v as Draft["autoFulfilmentConditions"] })}
            />
          </div>

          <div className="sf-field">
            <span className="sf-label">
              What it relies on
              <Help label="What it relies on">Parts of the system this change needs. The readiness check warns about any it does not know.</Help>
            </span>
            <Control
              f={{ kind: "multi", label: "What it relies on", options: NEEDS }}
              value={draft.featureDependencies}
              onChange={(v) => setDraft({ ...draft, featureDependencies: v as string[] })}
            />
          </div>

          <div className="flex gap-2">
            <button type="button" className="admin-btn" disabled={saveMutation.isPending || !draft.modeKey.trim() || !draft.displayName.trim()} onClick={() => saveMutation.mutate()}>
              {draft.id ? "Save a new version" : "Add it"}
            </button>
            <button type="button" className="admin-btn admin-btn-ghost" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="admin-panel overflow-x-auto p-4">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Kind of change</th>
              <th>The steps</th>
              <th>Standing</th>
              <th>Version</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={5} className="admin-muted">
                  None yet.
                </td>
              </tr>
            ) : null}
            {items.map((m) => (
              <tr key={m.id}>
                <td>
                  <strong>{m.displayName}</strong>
                </td>
                <td>{(m.stageRoute ?? []).map(stageWord).join(" → ") || "—"}</td>
                <td>
                  <span className={`admin-tag ${m.lifecycleState === "ACTIVE" ? "admin-tag-ok" : m.lifecycleState === "SUPERSEDED" ? "" : "admin-tag-warn"}`}>
                    {STATE_WORD[m.lifecycleState] ?? m.lifecycleState}
                  </span>
                </td>
                <td>{m.version}</td>
                <td className="text-right">
                  <span className="inline-flex gap-1">
                    {m.lifecycleState !== "SUPERSEDED" ? (
                      <button type="button" className="admin-btn text-[10px]" onClick={() => setDraft(draftFromRow(m))}>
                        Change
                      </button>
                    ) : null}
                    {!m.isActive && m.lifecycleState !== "SUPERSEDED" ? (
                      <button type="button" className="admin-btn admin-btn-success text-[10px]" onClick={() => activateMutation.mutate(m.id)}>
                        Put in use
                      </button>
                    ) : null}
                    {m.isActive ? (
                      <button type="button" className="admin-btn text-[10px]" onClick={() => deactivateMutation.mutate(m.id)}>
                        Take out of use
                      </button>
                    ) : null}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

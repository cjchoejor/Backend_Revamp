"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { activateMode, deactivateMode, listModes, saveMode, type ModeAdmin } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";

const STAGES = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "TERMINAL"] as const;

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

export default function AdminModesPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [depInput, setDepInput] = useState("");

  const query = useQuery({
    queryKey: ["admin", "modes"],
    queryFn: () => listModes(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const resetDraft = () => {
    setDraft(EMPTY);
    setDepInput("");
  };

  const saveMutation = useMutation({
    mutationFn: () =>
      saveMode(session!, {
        id: draft.id,
        modeKey: draft.modeKey.trim(),
        displayName: draft.displayName.trim(),
        description: draft.description.trim() || null,
        isPredefined: draft.isPredefined,
        stageRoute: draft.stageRoute,
        autoFulfilmentConditions: draft.autoFulfilmentConditions,
        featureDependencies: draft.featureDependencies,
      }),
    onSuccess: () => {
      toast.success(draft.id ? "Mode updated (new version saved as VALIDATED)" : "Mode created");
      resetDraft();
      void queryClient.invalidateQueries({ queryKey: ["admin", "modes"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Save failed"),
  });

  const activateMutation = useMutation({
    mutationFn: (id: string) => activateMode(session!, id),
    onSuccess: () => {
      toast.success("Mode activated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "modes"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Activate failed"),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => deactivateMode(session!, id),
    onSuccess: () => {
      toast.success("Mode deactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "modes"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Deactivate failed"),
  });

  if (!session || session.actorLevel !== "L4") return null;
  const items = query.data?.items ?? [];

  const toggleStage = (stage: string) => {
    setDraft((d) =>
      d.stageRoute.includes(stage)
        ? { ...d, stageRoute: d.stageRoute.filter((s) => s !== stage) }
        : { ...d, stageRoute: [...d.stageRoute, stage] },
    );
  };

  const moveStage = (idx: number, dir: -1 | 1) => {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= draft.stageRoute.length) return;
    const next = [...draft.stageRoute];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    setDraft({ ...draft, stageRoute: next });
  };

  const addCondition = () =>
    setDraft({
      ...draft,
      autoFulfilmentConditions: [...draft.autoFulfilmentConditions, { stage: "S1", condition: "" }],
    });
  const updateCondition = (i: number, patch: Partial<{ stage: string; condition: string }>) => {
    const next = [...draft.autoFulfilmentConditions];
    next[i] = { ...next[i], ...patch };
    setDraft({ ...draft, autoFulfilmentConditions: next });
  };
  const removeCondition = (i: number) =>
    setDraft({ ...draft, autoFulfilmentConditions: draft.autoFulfilmentConditions.filter((_, idx) => idx !== i) });

  const addDependency = () => {
    const v = depInput.trim();
    if (!v) return;
    if (draft.featureDependencies.includes(v)) {
      setDepInput("");
      return;
    }
    setDraft({ ...draft, featureDependencies: [...draft.featureDependencies, v] });
    setDepInput("");
  };
  const removeDependency = (v: string) =>
    setDraft({ ...draft, featureDependencies: draft.featureDependencies.filter((d) => d !== v) });

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 04 · Workflow</p>
        <h1 className="admin-display text-3xl">Modes</h1>
        <p className="admin-muted mt-1 max-w-3xl text-sm">
          Per ACIG §2.1A.7, each mode is an operational scenario (e.g. <span className="font-mono">NEW_BOOKING</span>,
          {" "}
          <span className="font-mono">ROOM_CHANGE</span>) defined by the stages it routes through, where auto-fulfilment
          kicks in, and which engines/services it depends on. Lifecycle:{" "}
          <span className="font-mono">DRAFT → VALIDATED → ACTIVE → SUPERSEDED</span>. Saving here transitions to
          VALIDATED; click Activate to publish (auto-supersedes any prior active row with the same key).
        </p>
      </div>

      <div className="admin-panel space-y-4 p-5">
        <div className="flex items-center justify-between">
          <h2 className="admin-display text-lg">{draft.id ? `Edit mode (v${"?"})` : "Create / edit mode"}</h2>
          {draft.id && (
            <button type="button" className="admin-btn text-[10px]" onClick={resetDraft}>
              Cancel edit
            </button>
          )}
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <input
            className="admin-input"
            placeholder="modeKey (e.g. NEW_BOOKING)"
            value={draft.modeKey}
            disabled={!!draft.id && draft.isPredefined}
            onChange={(e) => setDraft({ ...draft, modeKey: e.target.value })}
          />
          <input
            className="admin-input"
            placeholder="Display name"
            value={draft.displayName}
            onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
          />
        </div>
        <input
          className="admin-input"
          placeholder="Description (optional)"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={draft.isPredefined}
            disabled={!!draft.id}
            onChange={(e) => setDraft({ ...draft, isPredefined: e.target.checked })}
          />
          Predefined (one of the 8 canonical modes — locked once saved)
        </label>

        <div>
          <p className="admin-muted mb-1 text-xs">Stage route — click to add/remove; use ↑↓ to reorder</p>
          <div className="mb-2 flex flex-wrap gap-1">
            {STAGES.map((s) => (
              <button
                key={s}
                type="button"
                className={`admin-btn text-[10px] ${draft.stageRoute.includes(s) ? "admin-btn-success" : ""}`}
                onClick={() => toggleStage(s)}
              >
                {s}
              </button>
            ))}
          </div>
          {draft.stageRoute.length > 0 && (
            <ol className="space-y-1">
              {draft.stageRoute.map((s, i) => (
                <li key={`${s}-${i}`} className="flex items-center gap-2 text-xs">
                  <span className="admin-muted w-6">{i + 1}.</span>
                  <span className="font-mono">{s}</span>
                  <button type="button" className="admin-btn text-[10px]" onClick={() => moveStage(i, -1)} disabled={i === 0}>
                    ↑
                  </button>
                  <button
                    type="button"
                    className="admin-btn text-[10px]"
                    onClick={() => moveStage(i, 1)}
                    disabled={i === draft.stageRoute.length - 1}
                  >
                    ↓
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <p className="admin-muted text-xs">Auto-fulfilment conditions</p>
            <button type="button" className="admin-btn text-[10px]" onClick={addCondition}>
              + Add condition
            </button>
          </div>
          {draft.autoFulfilmentConditions.length === 0 ? (
            <p className="admin-muted text-[10px]">No auto-fulfilment conditions.</p>
          ) : (
            <div className="space-y-2">
              {draft.autoFulfilmentConditions.map((c, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <select
                    className="admin-select w-24"
                    value={c.stage}
                    onChange={(e) => updateCondition(i, { stage: e.target.value })}
                  >
                    {STAGES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <input
                    className="admin-input flex-1"
                    placeholder="Condition (e.g. SAME_TEAM_AUTO_FULFIL)"
                    value={c.condition}
                    onChange={(e) => updateCondition(i, { condition: e.target.value })}
                  />
                  <button type="button" className="admin-btn text-[10px]" onClick={() => removeCondition(i)}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <p className="admin-muted mb-1 text-xs">Feature dependencies (services / engines this mode requires)</p>
          <div className="mb-2 flex gap-2">
            <input
              className="admin-input flex-1"
              placeholder="e.g. PricingPipelineEngine"
              value={depInput}
              onChange={(e) => setDepInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addDependency();
                }
              }}
            />
            <button type="button" className="admin-btn text-[10px]" onClick={addDependency}>
              Add
            </button>
          </div>
          {draft.featureDependencies.length > 0 && (
            <ul className="flex flex-wrap gap-1">
              {draft.featureDependencies.map((d) => (
                <li key={d} className="admin-tag flex items-center gap-1 text-[10px]">
                  <span className="font-mono">{d}</span>
                  <button type="button" className="text-red-500 hover:text-red-700" onClick={() => removeDependency(d)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button
          type="button"
          className="admin-btn w-fit"
          disabled={saveMutation.isPending || !draft.modeKey.trim() || !draft.displayName.trim()}
          onClick={() => saveMutation.mutate()}
        >
          {draft.id ? "Save new version" : "Create mode"}
        </button>
      </div>

      <div className="admin-panel overflow-x-auto p-4">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Name</th>
              <th>Stage route</th>
              <th>Lifecycle</th>
              <th>v</th>
              <th>Active</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="admin-muted text-sm">
                  No modes yet — run the seed script to install the 8 predefined modes.
                </td>
              </tr>
            )}
            {items.map((m) => (
              <tr key={m.id}>
                <td className="font-mono text-xs">{m.modeKey}</td>
                <td>{m.displayName}</td>
                <td className="font-mono text-[10px]">{(m.stageRoute ?? []).join(" → ") || "—"}</td>
                <td>
                  <span
                    className={`admin-tag ${
                      m.lifecycleState === "ACTIVE"
                        ? "admin-tag-ok"
                        : m.lifecycleState === "SUPERSEDED"
                          ? ""
                          : "admin-tag-warn"
                    }`}
                  >
                    {m.lifecycleState}
                  </span>
                </td>
                <td className="font-mono text-xs">{m.version}</td>
                <td>{m.isActive ? "yes" : "no"}</td>
                <td className="space-x-1 text-right">
                  {m.lifecycleState !== "SUPERSEDED" && (
                    <button type="button" className="admin-btn text-[10px]" onClick={() => setDraft(draftFromRow(m))}>
                      Edit
                    </button>
                  )}
                  {!m.isActive && m.lifecycleState !== "SUPERSEDED" && (
                    <button
                      type="button"
                      className="admin-btn admin-btn-success text-[10px]"
                      onClick={() => activateMutation.mutate(m.id)}
                    >
                      Activate
                    </button>
                  )}
                  {m.isActive && (
                    <button
                      type="button"
                      className="admin-btn text-[10px]"
                      onClick={() => deactivateMutation.mutate(m.id)}
                    >
                      Deactivate
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

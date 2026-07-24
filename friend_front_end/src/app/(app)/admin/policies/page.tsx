"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CODE_POLICY_MODULES } from "@/lib/admin/config-schemas";
import { REGISTRY_POLICY_KEYS, getPolicyMeta, type PolicyKeyMeta } from "@/lib/admin/policy-schemas";
import { deactivatePolicy, listPolicies, savePolicy, type PolicyAdmin } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { useConfirm } from "@/components/providers/dialog-provider";

type Draft = {
  policyId: string;
  policyClass: string;
  description: string;
  enabled: boolean;
  params: Record<string, unknown>;
  rawJson: string;
};

const blankDraftForMeta = (meta: PolicyKeyMeta): Draft => {
  const params: Record<string, unknown> = {};
  for (const f of meta.fields) {
    const def = meta.defaults[f.key];
    params[f.key] = f.kind === "json" ? JSON.stringify(def ?? {}, null, 2) : def;
  }
  return {
    policyId: meta.policyId,
    policyClass: meta.policyClass,
    description: meta.description,
    enabled: true,
    params,
    rawJson: "",
  };
};

const blankCustomDraft = (): Draft => ({
  policyId: "",
  policyClass: "AVAILABILITY",
  description: "",
  enabled: true,
  params: {},
  rawJson: '{\n  "enabled": true\n}',
});

const draftFromExistingRow = (row: PolicyAdmin): Draft => {
  const def = (row.policyDefinition ?? {}) as Record<string, unknown>;
  const meta = getPolicyMeta(row.policyId);
  if (meta) {
    const params: Record<string, unknown> = {};
    for (const f of meta.fields) {
      const raw = def[f.key] ?? meta.defaults[f.key];
      // For "json" fields, store the textarea-friendly stringified value in params.
      params[f.key] = f.kind === "json" ? JSON.stringify(raw ?? {}, null, 2) : raw;
    }
    return {
      policyId: row.policyId,
      policyClass: row.policyClass,
      description: typeof def.description === "string" ? def.description : meta.description,
      enabled: def.enabled !== false,
      params,
      rawJson: "",
    };
  }
  return {
    policyId: row.policyId,
    policyClass: row.policyClass,
    description: typeof def.description === "string" ? def.description : "",
    enabled: def.enabled !== false,
    params: {},
    rawJson: JSON.stringify(def, null, 2),
  };
};

export default function AdminPoliciesPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingExisting, setEditingExisting] = useState(false);

  const enabledQuery = !!session && session.actorLevel === "L4";

  const query = useQuery({
    queryKey: ["admin", "policies"],
    queryFn: () => listPolicies(session!),
    enabled: enabledQuery,
  });

  const items: PolicyAdmin[] = query.data?.items ?? [];
  const activeByPolicyId = useMemo(() => {
    const map = new Map<string, PolicyAdmin>();
    for (const row of items) if (row.isActive) map.set(row.policyId, row);
    return map;
  }, [items]);

  const meta = draft ? getPolicyMeta(draft.policyId) : undefined;

  const buildDefinition = (d: Draft): Record<string, unknown> | null => {
    const m = getPolicyMeta(d.policyId);
    if (m) {
      const out: Record<string, unknown> = {
        enabled: d.enabled,
        description: d.description || m.description,
      };
      for (const f of m.fields) {
        const v = d.params[f.key];
        if (f.kind === "number") {
          const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
          if (!Number.isFinite(n)) {
            toast.error(`"${f.label}" must be a number`);
            return null;
          }
          if (f.min !== undefined && n < f.min) {
            toast.error(`"${f.label}" must be >= ${f.min}`);
            return null;
          }
          if (f.max !== undefined && n > f.max) {
            toast.error(`"${f.label}" must be <= ${f.max}`);
            return null;
          }
          out[f.key] = n;
        } else if (f.kind === "boolean") {
          // Draft holds boolean directly. Also coerce "true"/"false" strings just in case
          // a caller passed them in from the JSON fallback view.
          out[f.key] = v === true || v === "true";
        } else if (f.kind === "json") {
          try {
            out[f.key] = JSON.parse(String(v ?? "{}"));
          } catch (e) {
            toast.error(`"${f.label}" is not valid JSON: ${(e as Error).message}`);
            return null;
          }
        } else {
          out[f.key] = String(v ?? "");
        }
      }
      return out;
    }
    try {
      const parsed = JSON.parse(d.rawJson) as Record<string, unknown>;
      return { enabled: d.enabled, description: d.description, ...parsed };
    } catch (e) {
      toast.error(`Invalid JSON: ${(e as Error).message}`);
      return null;
    }
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error("No draft");
      const definition = buildDefinition(draft);
      if (!definition) throw new Error("validation-failed");
      return savePolicy(session!, {
        policyId: draft.policyId.trim(),
        policyClass: draft.policyClass.trim(),
        policyDefinition: definition,
      });
    },
    onSuccess: () => {
      toast.success("Policy version saved");
      setDraft(null);
      setEditingExisting(false);
      void queryClient.invalidateQueries({ queryKey: ["admin", "policies"] });
    },
    onError: (e) => {
      if (e instanceof Error && e.message === "validation-failed") return;
      toast.error(e instanceof ApiError ? e.message : "Save failed");
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: (policyId: string) => deactivatePolicy(session!, policyId),
    onSuccess: () => {
      toast.success("Policy deactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "policies"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Deactivate failed"),
  });

  if (!session || session.actorLevel !== "L4") return null;

  const knownMissing = REGISTRY_POLICY_KEYS.filter((p) => !activeByPolicyId.has(p.policyId));
  const customRows = items.filter((r) => !getPolicyMeta(r.policyId));

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 04 · Workflow</p>
        <h1 className="admin-display text-3xl">Policy registry</h1>
      </div>

      <div className="admin-panel space-y-3 border-amber-500/30 bg-amber-500/5 p-5 text-sm">
        <h2 className="admin-display text-base">Two different kinds of &ldquo;policies&rdquo;</h2>
        <ol className="admin-muted list-decimal space-y-2 pl-5">
          <li>
            <strong className="text-[var(--admin-ink-soft)]">Runtime guards (TypeScript)</strong> &mdash; ~149 modules under{" "}
            <span className="font-mono text-xs">back_end/src/policies</span> (P01, P16, P31, &hellip;). These enforce stage
            gates at request time. They are <em>not</em> editable in this console; only a developer can change them in
            code.
          </li>
          <li>
            <strong className="text-[var(--admin-ink-soft)]">Policy registry (database)</strong> &mdash; versioned rows in{" "}
            <span className="font-mono text-xs">policy_registry</span>. Some rows here are now consulted at runtime
            (consumers shown below); the rest record intent and audit history.
          </li>
        </ol>
      </div>

      <section className="admin-panel p-5">
        <h2 className="admin-display mb-3 text-lg">Runtime guards in code (read-only)</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {CODE_POLICY_MODULES.map((p) => (
            <li key={p.id} className="rounded border border-[var(--admin-rule)] px-3 py-2 text-sm">
              <span className="font-mono text-xs text-[var(--admin-brass)]">{p.id}</span>
              <span className="text-[var(--admin-ink-soft)]"> &mdash; {p.name}</span>
              <span className="admin-muted block text-[10px]">~{p.count} modules</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="admin-panel space-y-3 p-5">
        <h2 className="admin-display text-lg">Registry policies</h2>
        <p className="admin-muted text-xs">
          Edit a known policy below to change runtime behaviour. Unknown policies fall back to a raw JSON editor.
        </p>

        <div className="grid gap-3 md:grid-cols-2">
          {REGISTRY_POLICY_KEYS.map((m) => {
            const row = activeByPolicyId.get(m.policyId);
            const def = (row?.policyDefinition ?? {}) as Record<string, unknown>;
            return (
              <div key={m.policyId} className="rounded border border-[var(--admin-rule)] p-3 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-mono text-[11px] text-[var(--admin-brass)]">{m.policyId}</p>
                    <p className="font-medium">{m.title}</p>
                    <p className="admin-muted mt-1 text-xs">{m.description}</p>
                    <p className="admin-muted mt-1 text-[10px]">
                      Consumed by: <span className="font-mono">{m.consumedBy.join(", ")}</span>
                    </p>
                  </div>
                  <div className="text-right">
                    {row ? (
                      <span className={`admin-tag ${def.enabled === false ? "admin-tag-warn" : "admin-tag-ok"}`}>
                        v{row.version} {def.enabled === false ? "disabled" : "enabled"}
                      </span>
                    ) : (
                      <span className="admin-tag admin-tag-warn">not in DB</span>
                    )}
                  </div>
                </div>
                {row && m.fields.length > 0 && (
                  <ul className="admin-muted mt-2 text-[11px]">
                    {m.fields.map((f) => {
                      const raw = def[f.key];
                      const display =
                        f.kind === "json"
                          ? raw === undefined
                            ? "—"
                            : JSON.stringify(raw)
                          : raw === undefined
                            ? "—"
                            : String(raw);
                      return (
                        <li key={f.key}>
                          <span className="font-mono">{f.key}</span>: {display}
                          {f.kind === "number" && f.unit ? ` ${f.unit}` : ""}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="admin-btn text-[10px]"
                    onClick={() => {
                      setDraft(row ? draftFromExistingRow(row) : blankDraftForMeta(m));
                      setEditingExisting(!!row);
                      if (typeof window !== "undefined") {
                        setTimeout(
                          () => document.getElementById("policy-edit-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }),
                          60,
                        );
                      }
                    }}
                  >
                    {row ? "Edit" : "Create"}
                  </button>
                  {row && (
                    <button
                      type="button"
                      className="admin-btn text-[10px]"
                      disabled={deactivateMutation.isPending}
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Deactivate policy",
                          message: `Deactivate "${m.policyId}" (v${row.version})? Runtime code will fall back to the ConfigurationEntry default (if any) or the TS default.`,
                          confirmLabel: "Deactivate",
                          variant: "danger",
                        });
                        if (ok) deactivateMutation.mutate(m.policyId);
                      }}
                    >
                      Deactivate
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {knownMissing.length > 0 && (
          <p className="admin-muted text-[11px]">
            {knownMissing.length} known polic{knownMissing.length === 1 ? "y is" : "ies are"} not yet stored in the DB &mdash;
            click &ldquo;Create&rdquo; to seed defaults.
          </p>
        )}
      </section>

      {draft && (
        <section id="policy-edit-panel" className="admin-panel space-y-4 p-5">
          <div className="flex items-center justify-between">
            <h2 className="admin-display text-lg">
              {editingExisting ? "Edit policy version" : "Create policy version"}
            </h2>
            <button type="button" className="admin-btn text-[10px]" onClick={() => { setDraft(null); setEditingExisting(false); }}>
              Cancel
            </button>
          </div>
          <p className="admin-muted text-xs">
            Saving creates a new active version &mdash; the previous active version is automatically deactivated.
          </p>

          <div className="grid gap-3 md:grid-cols-2">
            <input
              className="admin-input"
              placeholder="Policy ID (e.g. registry.noShow.graceMinutes)"
              value={draft.policyId}
              disabled={!!meta}
              onChange={(e) => setDraft({ ...draft, policyId: e.target.value })}
            />
            <input
              className="admin-input"
              placeholder="Class (e.g. CANCELLATION)"
              value={draft.policyClass}
              disabled={!!meta}
              onChange={(e) => setDraft({ ...draft, policyClass: e.target.value })}
            />
          </div>

          <textarea
            className="admin-textarea min-h-[60px]"
            placeholder="Description for hotel staff"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />
            Enabled
          </label>

          {meta ? (
            meta.fields.length === 0 ? (
              <p className="admin-muted text-xs">This policy has no extra parameters &mdash; toggle Enabled to control it.</p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {meta.fields.map((f) => (
                  <label
                    key={f.key}
                    className={`flex flex-col gap-1 text-xs ${f.kind === "json" ? "md:col-span-2" : ""}`}
                  >
                    <span className="font-medium">
                      {f.label}
                      {f.kind === "number" && f.unit ? <span className="admin-muted"> ({f.unit})</span> : null}
                    </span>
                    {f.kind === "json" ? (
                      <textarea
                        className="admin-textarea min-h-[140px] font-mono text-xs"
                        placeholder={f.placeholder}
                        value={String(draft.params[f.key] ?? "")}
                        onChange={(e) =>
                          setDraft({ ...draft, params: { ...draft.params, [f.key]: e.target.value } })
                        }
                      />
                    ) : f.kind === "boolean" ? (
                      <label className="inline-flex items-center gap-2 py-1">
                        <input
                          type="checkbox"
                          checked={draft.params[f.key] === true || draft.params[f.key] === "true"}
                          onChange={(e) =>
                            setDraft({ ...draft, params: { ...draft.params, [f.key]: e.target.checked } })
                          }
                        />
                        <span className="text-xs">
                          {draft.params[f.key] === true || draft.params[f.key] === "true" ? "On" : "Off"}
                        </span>
                      </label>
                    ) : (
                      <input
                        className="admin-input"
                        type={f.kind === "number" ? "number" : "text"}
                        min={f.kind === "number" ? f.min : undefined}
                        max={f.kind === "number" ? f.max : undefined}
                        step={f.kind === "number" ? f.step ?? 1 : undefined}
                        value={String(draft.params[f.key] ?? "")}
                        onChange={(e) => {
                          const raw = e.target.value;
                          setDraft({
                            ...draft,
                            params: {
                              ...draft.params,
                              [f.key]: f.kind === "number" ? (raw === "" ? "" : Number.parseFloat(raw)) : raw,
                            },
                          });
                        }}
                      />
                    )}
                    {f.help && <span className="admin-muted text-[10px]">{f.help}</span>}
                  </label>
                ))}
              </div>
            )
          ) : (
            <div className="space-y-1">
              <p className="admin-muted text-[11px]">
                Unknown policy ID &mdash; edit the JSON payload directly. The top-level <span className="font-mono">enabled</span>{" "}
                and <span className="font-mono">description</span> fields above are merged in automatically.
              </p>
              <textarea
                className="admin-textarea min-h-[120px] font-mono text-xs"
                placeholder="{ }"
                value={draft.rawJson}
                onChange={(e) => setDraft({ ...draft, rawJson: e.target.value })}
              />
            </div>
          )}

          <button
            type="button"
            className="admin-btn w-fit"
            disabled={saveMutation.isPending || !draft.policyId.trim() || !draft.policyClass.trim()}
            onClick={() => saveMutation.mutate()}
          >
            {editingExisting ? "Save new version" : "Create policy version"}
          </button>
        </section>
      )}

      <section className="admin-panel space-y-3 p-5">
        <h2 className="admin-display text-lg">Other (non-schema) registry rows</h2>
        {customRows.length === 0 ? (
          <p className="admin-muted text-sm">None.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Policy ID</th>
                <th>Class</th>
                <th>Version</th>
                <th>Active</th>
                <th>Definition</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {customRows.map((p) => (
                <tr key={p.id}>
                  <td className="font-mono text-xs">{p.policyId}</td>
                  <td>{p.policyClass}</td>
                  <td>{p.version}</td>
                  <td>{p.isActive ? "yes" : "no"}</td>
                  <td>
                    <pre className="font-mono text-[10px]">{JSON.stringify(p.policyDefinition, null, 2)}</pre>
                  </td>
                  <td className="text-right">
                    {p.isActive && (
                      <>
                        <button
                          type="button"
                          className="admin-btn text-[10px]"
                          onClick={() => {
                            setDraft(draftFromExistingRow(p));
                            setEditingExisting(true);
                            if (typeof window !== "undefined") {
                        setTimeout(
                          () => document.getElementById("policy-edit-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }),
                          60,
                        );
                      }
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="admin-btn ml-1 text-[10px]"
                          disabled={deactivateMutation.isPending}
                          onClick={async () => {
                            const ok = await confirm({
                              title: "Deactivate policy",
                              message: `Deactivate "${p.policyId}" (v${p.version})?`,
                              confirmLabel: "Deactivate",
                              variant: "danger",
                            });
                            if (ok) deactivateMutation.mutate(p.policyId);
                          }}
                        >
                          Deactivate
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!editingExisting && !draft && (
          <button
            type="button"
            className="admin-btn w-fit text-[10px]"
            onClick={() => {
              setDraft(blankCustomDraft());
              setEditingExisting(false);
              if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          >
            Add custom policy
          </button>
        )}
      </section>
    </div>
  );
}

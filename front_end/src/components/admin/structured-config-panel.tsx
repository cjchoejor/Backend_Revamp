"use client";

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { ConfigFormEditor } from "@/components/admin/config-form-editor";
import { SmartConfigEditor } from "@/components/admin/smart-config-editor";
import { getConfigSchema, type ConfigSchema } from "@/lib/admin/config-schemas";
import type { ConfigurationActive } from "@/lib/api/admin";
import { ApiError } from "@/lib/api/client";

type Props = {
  configKey: string;
  load: (key: string) => Promise<ConfigurationActive>;
  save: (key: string, body: { configValue: unknown; notes?: string | null }) => Promise<unknown>;
  onSaved?: () => void;
};

/** Empty starter value per schema kind — used when no DB row exists yet so the form still renders. */
function defaultValueForSchema(schema: ConfigSchema | undefined): unknown {
  if (!schema) return {};
  switch (schema.kind) {
    case "number":
    case "percentage":
    case "seconds":
    case "hours":
    case "days":
    case "money":
      return 0;
    case "text":
    case "cron":
    case "day-list":
      return "";
    default:
      return {};
  }
}

/**
 * Simple scalar shapes don't have structure to edit — hiding the "Use advanced JSON editor" toggle
 * keeps the panel focused. Object/array-style configs (record-seconds, stage-dwell, fom-override-
 * frequency, etc.) still expose the toggle so power users can paste a value.
 */
function isScalarSchema(schema: ConfigSchema | undefined): boolean {
  if (!schema) return false;
  switch (schema.kind) {
    case "number":
    case "percentage":
    case "text":
    case "cron":
    case "seconds":
    case "hours":
    case "days":
    case "day-list":
    case "money":
      return true;
    default:
      return false;
  }
}

export function StructuredConfigPanel({ configKey, load, save, onSaved }: Props) {
  const meta = getConfigSchema(configKey);
  const [draft, setDraft] = useState<unknown>(null);
  const [notes, setNotes] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const [useAdvanced, setUseAdvanced] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setIsNew(false);
    load(configKey)
      .then((row) => {
        setDraft(row.configValue);
        setNotes(row.notes ?? "");
        setLoaded(true);
      })
      .catch((e) => {
        // First-time setup / not-yet-seeded: initialise with the schema's empty default so the
        // form still renders. The user's first Save creates the active row.
        if (e instanceof ApiError && e.status === 404) {
          setDraft(defaultValueForSchema(meta?.schema));
          setNotes("");
          setIsNew(true);
          setLoaded(true);
        } else {
          toast.error(e instanceof ApiError ? e.message : "Failed to load");
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when key changes only
  }, [configKey]);

  const saveMutation = useMutation({
    mutationFn: () => save(configKey, { configValue: draft, notes: notes || null }),
    onSuccess: () => {
      toast.success(isNew ? "Configuration created" : "Configuration saved");
      setIsNew(false);
      onSaved?.();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  if (!loaded) {
    return <p className="admin-muted text-sm">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      {meta && (
        <div className="rounded-lg border border-[var(--admin-rule)] bg-[var(--admin-bg)]/50 p-3 text-sm">
          <p className="text-[var(--admin-ink-soft)]">{meta.description}</p>
          {meta.worker && (
            <p className="admin-muted mt-1 text-xs">
              Background job: <span className="font-mono text-[var(--admin-brass)]">{meta.worker}</span>
            </p>
          )}
        </div>
      )}

      {isNew && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-[var(--admin-ink-soft)]">
          No saved value yet for this setting. The form below is showing default starter values — adjust them and click
          Save to create the first version.
        </div>
      )}

      {meta && !useAdvanced ? (
        <ConfigFormEditor schema={meta.schema} value={draft} onChange={setDraft} />
      ) : (
        <div>
          {!meta && (
            <p className="admin-muted mb-2 text-xs">
              No dedicated form for this key yet — edit fields below. Use Advanced JSON to paste a value.
            </p>
          )}
          <SmartConfigEditor value={draft} onChange={setDraft} />
        </div>
      )}

      {meta && !isScalarSchema(meta.schema) && (
        <label className="flex items-center gap-2 text-xs text-[var(--admin-ink-soft)]">
          <input type="checkbox" checked={useAdvanced} onChange={(e) => setUseAdvanced(e.target.checked)} />
          Use advanced JSON editor instead of the dedicated form
        </label>
      )}

      <label className="block space-y-1">
        <span className="admin-muted text-xs">Change note (optional, recorded in the audit trail)</span>
        <input
          className="admin-input"
          placeholder="e.g. Updated GST to 5% per circular 2026-06"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>

      <button type="button" className="admin-btn w-fit" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
        {isNew ? "Create configuration" : "Save changes"}
      </button>
    </div>
  );
}

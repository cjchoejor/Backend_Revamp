"use client";

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { ConfigFormEditor } from "@/components/admin/config-form-editor";
import { SmartConfigEditor } from "@/components/admin/smart-config-editor";
import { getConfigSchema } from "@/lib/admin/config-schemas";
import type { ConfigurationActive } from "@/lib/api/admin";
import { ApiError } from "@/lib/api/client";

type Props = {
  configKey: string;
  load: (key: string) => Promise<ConfigurationActive>;
  save: (key: string, body: { configValue: unknown; notes?: string | null }) => Promise<unknown>;
  onSaved?: () => void;
};

export function StructuredConfigPanel({ configKey, load, save, onSaved }: Props) {
  const meta = getConfigSchema(configKey);
  const [draft, setDraft] = useState<unknown>(null);
  const [notes, setNotes] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [useAdvanced, setUseAdvanced] = useState(false);

  useEffect(() => {
    setLoaded(false);
    load(configKey)
      .then((row) => {
        setDraft(row.configValue);
        setNotes(row.notes ?? "");
        setLoaded(true);
      })
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Failed to load"));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when key changes only
  }, [configKey]);

  const saveMutation = useMutation({
    mutationFn: () => save(configKey, { configValue: draft, notes: notes || null }),
    onSuccess: () => {
      toast.success("Configuration saved");
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

      {meta && (
        <label className="flex items-center gap-2 text-xs text-[var(--admin-ink-soft)]">
          <input type="checkbox" checked={useAdvanced} onChange={(e) => setUseAdvanced(e.target.checked)} />
          Use generic editor instead of the dedicated form
        </label>
      )}

      <input className="admin-input" placeholder="Change notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />

      <button type="button" className="admin-btn w-fit" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
        Save changes
      </button>
    </div>
  );
}

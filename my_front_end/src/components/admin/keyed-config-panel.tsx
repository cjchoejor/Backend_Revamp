"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "@/lib/api/client";
import { SmartConfigEditor } from "./smart-config-editor";
import { ConfigFormEditor } from "./config-form-editor";
import { getConfigSchema } from "@/lib/admin/config-schemas";

type Mode = "json" | "number" | "text";

export function KeyedConfigPanel({
  title,
  description,
  queryKey,
  load,
  save,
  mode = "json",
  enabled = true,
  configKey,
}: {
  title: string;
  description?: string;
  queryKey: string[];
  load: () => Promise<unknown>;
  save: (value: unknown) => Promise<unknown>;
  mode?: Mode;
  enabled?: boolean;
  /**
   * Optional ConfigurationEntry key. When provided AND a typed schema is registered for it in
   * config-schemas.ts, the rich typed editor renders instead of the JSON fallback. The panel's
   * underlying load/save plumbing is unchanged — only the rendered editor differs.
   */
  configKey?: string;
}) {
  const queryClient = useQueryClient();
  // For json mode we hold the parsed value; for number/text we hold the string draft.
  const [jsonDraft, setJsonDraft] = useState<unknown>(null);
  const [strDraft, setStrDraft] = useState("");
  const [dirty, setDirty] = useState(false);

  const query = useQuery({ queryKey, queryFn: load, enabled });

  useEffect(() => {
    if (query.data === undefined || dirty) return;
    const v = query.data;
    if (mode === "json") setJsonDraft(v ?? null);
    else setStrDraft(v == null ? "" : String(v));
  }, [query.data, mode, dirty]);

  const mutation = useMutation({
    mutationFn: () => {
      if (mode === "json") return save(jsonDraft);
      if (mode === "number") return save(Number(strDraft));
      return save(strDraft);
    },
    onSuccess: () => {
      toast.success(`${title} saved`);
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : "Save failed");
    },
  });

  return (
    <div className="admin-panel space-y-3 p-5">
      <div>
        <p className="admin-eyebrow">{title}</p>
        {description && <p className="admin-muted text-xs">{description}</p>}
      </div>
      {mode === "json" ? (
        configKey && getConfigSchema(configKey)?.schema ? (
          <ConfigFormEditor
            schema={getConfigSchema(configKey)!.schema!}
            value={jsonDraft}
            onChange={(v) => {
              setJsonDraft(v);
              setDirty(true);
            }}
          />
        ) : (
          <SmartConfigEditor
            value={jsonDraft}
            onChange={(v) => {
              setJsonDraft(v);
              setDirty(true);
            }}
          />
        )
      ) : (
        <input
          className="admin-input w-48"
          type={mode === "number" ? "number" : "text"}
          value={strDraft}
          onChange={(e) => {
            setStrDraft(e.target.value);
            setDirty(true);
          }}
        />
      )}
      <button type="button" className="admin-btn w-fit" disabled={mutation.isPending || !dirty} onClick={() => mutation.mutate()}>
        Save
      </button>
    </div>
  );
}

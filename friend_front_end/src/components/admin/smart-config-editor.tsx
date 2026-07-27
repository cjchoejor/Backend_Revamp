"use client";

import { useState, type ReactNode } from "react";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function detectType(v: unknown): "string" | "number" | "boolean" | "array" | "object" | "null" {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  return "string";
}

const initialFor: Record<string, JsonValue> = {
  string: "",
  number: 0,
  boolean: false,
  array: [],
  object: {},
  null: null,
};

type EditorContext = {
  /**
   * When true, structure-changing actions are exposed: renaming object keys, removing object
   * fields, and removing array items. When false (the default), only values are editable —
   * field names render as read-only labels. Adding NEW fields/items is always permitted
   * because additive changes can't break operational code that consumes a known shape.
   */
  structureUnlocked: boolean;
};

/** Recursive editor for any JSON value — keeps the JSON valid by construction. */
function ValueEditor({
  value,
  onChange,
  ctx,
  depth = 0,
}: {
  value: JsonValue;
  onChange: (v: JsonValue) => void;
  ctx: EditorContext;
  depth?: number;
}): ReactNode {
  const type = detectType(value);

  if (type === "null") {
    return (
      <select
        className="admin-select w-44 text-xs"
        defaultValue=""
        onChange={(e) => {
          const t = e.target.value;
          if (t) onChange(initialFor[t] ?? "");
        }}
      >
        <option value="">— set value —</option>
        <option value="string">Text</option>
        <option value="number">Number</option>
        <option value="boolean">Yes / No</option>
        <option value="array">List</option>
        <option value="object">Object</option>
      </select>
    );
  }

  if (type === "string") {
    return (
      <input
        className="admin-input w-full text-xs"
        value={value as string}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  if (type === "number") {
    return (
      <input
        className="admin-input w-40 text-xs"
        type="number"
        value={value as number}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
      />
    );
  }

  if (type === "boolean") {
    return (
      <label className="inline-flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={value as boolean}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{(value as boolean) ? "Yes" : "No"}</span>
      </label>
    );
  }

  if (type === "array") {
    const items = value as JsonValue[];
    return (
      <div className="space-y-2">
        {items.length === 0 && <p className="admin-muted text-xs italic">(empty list)</p>}
        {items.map((item, i) => {
          const itemType = detectType(item);
          const isBlock = itemType === "object" || itemType === "array";
          return (
            <div
              key={i}
              className={`rounded border border-[var(--admin-rule)] p-2 ${isBlock ? "" : "flex items-start gap-2"}`}
            >
              <span className="admin-muted shrink-0 pt-1 text-[10px] uppercase tracking-wide">#{i + 1}</span>
              <div className="min-w-0 flex-1">
                <ValueEditor
                  value={item}
                  onChange={(v) => onChange([...items.slice(0, i), v, ...items.slice(i + 1)])}
                  ctx={ctx}
                  depth={depth + 1}
                />
              </div>
              {ctx.structureUnlocked && (
                <button
                  type="button"
                  className="admin-btn shrink-0 text-[10px]"
                  onClick={() => onChange([...items.slice(0, i), ...items.slice(i + 1)])}
                  title="Remove this item"
                >
                  Remove
                </button>
              )}
            </div>
          );
        })}
        <div className="flex flex-wrap gap-1">
          <button type="button" className="admin-btn text-[10px]" onClick={() => onChange([...items, ""])}>
            + Add text
          </button>
          <button type="button" className="admin-btn text-[10px]" onClick={() => onChange([...items, 0])}>
            + Add number
          </button>
          <button type="button" className="admin-btn text-[10px]" onClick={() => onChange([...items, {}])}>
            + Add object
          </button>
        </div>
      </div>
    );
  }

  // object
  const obj = value as Record<string, JsonValue>;
  const entries = Object.entries(obj);
  return (
    <div className="space-y-2">
      {entries.length === 0 && <p className="admin-muted text-xs italic">(no fields)</p>}
      {entries.map(([k, v]) => {
        const itemType = detectType(v);
        const isBlock = itemType === "object" || itemType === "array";
        return (
          <div key={k} className="rounded border border-[var(--admin-rule)] p-2">
            <div className="mb-1 flex items-center gap-2">
              {ctx.structureUnlocked ? (
                <input
                  className="admin-input w-44 text-xs font-mono"
                  value={k}
                  onChange={(e) => {
                    const next: Record<string, JsonValue> = {};
                    let renamed = false;
                    for (const [ek, ev] of entries) {
                      if (ek === k && !renamed) {
                        const newKey = e.target.value || k;
                        next[newKey] = ev;
                        renamed = true;
                      } else {
                        next[ek] = ev;
                      }
                    }
                    onChange(next);
                  }}
                  aria-label={`Field name (${k})`}
                />
              ) : (
                <span className="font-mono text-xs text-[var(--admin-brass)]" title="Field name — unlock structure controls to rename">
                  {k}
                </span>
              )}
              <span className="admin-muted text-[10px]">: {itemType}</span>
              {ctx.structureUnlocked && (
                <button
                  type="button"
                  className="admin-btn ml-auto text-[10px]"
                  onClick={() => {
                    const { [k]: _drop, ...rest } = obj;
                    void _drop;
                    onChange(rest);
                  }}
                  title="Remove this field"
                >
                  Remove
                </button>
              )}
            </div>
            <div className={isBlock ? "border-l-2 border-[var(--admin-rule)] pl-3" : ""}>
              <ValueEditor value={v} onChange={(nv) => onChange({ ...obj, [k]: nv })} ctx={ctx} depth={depth + 1} />
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          className="admin-btn text-[10px]"
          onClick={() => {
            let i = 1;
            let name = `field${i}`;
            while (name in obj) name = `field${++i}`;
            onChange({ ...obj, [name]: "" });
          }}
        >
          + Add field
        </button>
      </div>
    </div>
  );
}

/**
 * Safe, non-coder-friendly editor for JSON configuration values. Internally tracks the value as a
 * structured object and emits valid JSON on every change. Includes an "Advanced JSON" escape hatch
 * for power users / inspection.
 *
 * Structural edits (renaming object keys, removing fields, removing array items) are LOCKED by
 * default to prevent accidental shape mutation — operational code consumes these objects by exact
 * field name (`id`, `code`, `nightlyRate`, …) and a rename would break the workflow. Operators who
 * genuinely need to restructure toggle "Show structure controls" or switch to Advanced JSON.
 */
export function SmartConfigEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [structureUnlocked, setStructureUnlocked] = useState(false);
  const [rawDraft, setRawDraft] = useState<string>("");
  const [rawError, setRawError] = useState<string | null>(null);

  const safeValue = (value ?? null) as JsonValue;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="admin-muted text-xs">
          {advanced
            ? "Editing raw JSON. Switch back to use the structured editor."
            : "Edit values below — field names are locked to prevent accidental shape changes. Use Advanced JSON to paste or restructure freely."}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {!advanced && (
            <label className="admin-muted flex items-center gap-1 text-[10px]" title="Allows renaming and removing fields. Use with care — field names are read by operational code.">
              <input
                type="checkbox"
                checked={structureUnlocked}
                onChange={(e) => setStructureUnlocked(e.target.checked)}
              />
              Show structure controls
            </label>
          )}
          <button
            type="button"
            className="admin-btn text-[10px]"
            onClick={() => {
              if (!advanced) {
                setRawDraft(JSON.stringify(safeValue, null, 2));
                setRawError(null);
              }
              setAdvanced((p) => !p);
            }}
          >
            {advanced ? "Use structured editor" : "Advanced JSON"}
          </button>
        </div>
      </div>

      {!advanced && structureUnlocked && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[10px] text-[var(--admin-ink-soft)]">
          ⚠ Structure controls enabled — renaming or removing a field can break operational code that expects exact
          field names (e.g. <span className="font-mono">id</span>, <span className="font-mono">nightlyRate</span>).
          Only do this if you know the consumer.
        </div>
      )}

      {!advanced ? (
        <ValueEditor value={safeValue} onChange={(v) => onChange(v)} ctx={{ structureUnlocked }} />
      ) : (
        <div className="space-y-2">
          <textarea
            className="admin-input w-full font-mono text-xs"
            rows={10}
            value={rawDraft}
            onChange={(e) => {
              setRawDraft(e.target.value);
              try {
                const parsed = e.target.value.trim() === "" ? null : JSON.parse(e.target.value);
                onChange(parsed);
                setRawError(null);
              } catch (err) {
                setRawError(err instanceof Error ? err.message : "Invalid JSON");
              }
            }}
          />
          {rawError && <p className="text-xs text-red-500">{rawError}</p>}
        </div>
      )}
    </div>
  );
}

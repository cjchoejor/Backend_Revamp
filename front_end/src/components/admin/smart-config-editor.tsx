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

/** Recursive editor for any JSON value — keeps the JSON valid by construction. */
function ValueEditor({
  value,
  onChange,
  depth = 0,
}: {
  value: JsonValue;
  onChange: (v: JsonValue) => void;
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
                  depth={depth + 1}
                />
              </div>
              <button
                type="button"
                className="admin-btn shrink-0 text-[10px]"
                onClick={() => onChange([...items.slice(0, i), ...items.slice(i + 1)])}
                title="Remove this item"
              >
                Remove
              </button>
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
              <span className="admin-muted text-[10px]">: {itemType}</span>
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
            </div>
            <div className={isBlock ? "pl-3 border-l-2 border-[var(--admin-rule)]" : ""}>
              <ValueEditor value={v} onChange={(nv) => onChange({ ...obj, [k]: nv })} depth={depth + 1} />
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
 */
export function SmartConfigEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [rawDraft, setRawDraft] = useState<string>("");
  const [rawError, setRawError] = useState<string | null>(null);

  const safeValue = (value ?? null) as JsonValue;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="admin-muted text-xs">
          {advanced
            ? "Editing raw JSON. Switch back to use the structured editor."
            : "Edit fields below — types are detected automatically. Use Advanced JSON if you need to paste a value."}
        </p>
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

      {!advanced ? (
        <ValueEditor value={safeValue} onChange={(v) => onChange(v)} />
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

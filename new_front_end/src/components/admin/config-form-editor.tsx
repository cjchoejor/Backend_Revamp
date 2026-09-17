"use client";

import { useEffect, useRef, useState } from "react";
import {
  ACK_WINDOW_LABELS,
  DWELL_LEVELS,
  ENTRY_STATES,
  STAGES,
  type ConfigSchema,
  type StageDwellValue,
} from "@/lib/admin/config-schemas";

/**
 * Percentage input — user types the percentage (e.g. "5", "2.5"), value is stored as the decimal
 * equivalent (0.05, 0.025). Keeps an internal string draft so partial input like "2." or empty
 * field doesn't snap back to a number while the user is mid-type.
 */
function PercentageInput({
  schema,
  storedDecimal,
  onChange,
}: {
  schema: Extract<ConfigSchema, { kind: "percentage" }>;
  storedDecimal: number;
  onChange: (value: unknown) => void;
}) {
  const [draft, setDraft] = useState<string>(() => (storedDecimal * 100).toString());
  const lastEmittedRef = useRef<number>(storedDecimal);

  // If the underlying decimal changes from somewhere else (e.g. server reload), sync the draft.
  useEffect(() => {
    if (Math.abs(storedDecimal - lastEmittedRef.current) > 1e-9) {
      setDraft((storedDecimal * 100).toString());
      lastEmittedRef.current = storedDecimal;
    }
  }, [storedDecimal]);

  const commit = (text: string) => {
    setDraft(text);
    // Allow empty / partial input ("2.") without emitting NaN.
    if (text === "" || text === "." || text === "-") return;
    const pct = Number.parseFloat(text);
    if (!Number.isFinite(pct)) return;
    const decimal = Math.round((pct / 100) * 1_000_000) / 1_000_000;
    lastEmittedRef.current = decimal;
    onChange(decimal);
  };

  const onBlur = () => {
    // On blur, normalise the draft so what's visible matches what's stored.
    const pct = Number.parseFloat(draft);
    if (!Number.isFinite(pct)) {
      setDraft((storedDecimal * 100).toString());
      return;
    }
    setDraft(pct.toString());
  };

  return (
    <label className="block space-y-1">
      <span className="admin-muted text-xs">{schema.label}</span>
      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          className="admin-input max-w-[200px]"
          min={schema.min ?? 0}
          max={schema.max}
          step={schema.step ?? 0.5}
          value={draft}
          onChange={(e) => commit(e.target.value)}
          onBlur={onBlur}
        />
        <span className="admin-muted text-sm">%</span>
      </div>
      <span className="admin-muted text-[10px]">
        Stored as decimal:{" "}
        <span className="font-mono">{(storedDecimal).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}</span>
      </span>
      {schema.help && <span className="admin-muted block text-[10px]">{schema.help}</span>}
    </label>
  );
}

type Props = {
  schema: ConfigSchema;
  value: unknown;
  onChange: (value: unknown) => void;
};

/**
 * String-draft number input. The HTML input is controlled by a local string so the user can
 * freely backspace to empty, type a leading `0.`, or paste partial values without the field
 * snapping back to a stale numeric value. Commits the parsed float (or `0` for empty/invalid)
 * to the parent on every change, then on blur the field re-syncs to a canonical numeric string.
 */
function NumberInput({
  label,
  val,
  onChange,
  opts,
}: {
  label: string;
  val: number;
  onChange: (n: number) => void;
  opts?: { min?: number; step?: number; unit?: string; help?: string };
}) {
  const [draft, setDraft] = useState<string>(() => (Number.isFinite(val) ? String(val) : "0"));
  const lastEmittedRef = useRef<number>(Number.isFinite(val) ? val : 0);

  // External update (e.g. parent state reset) → re-sync draft.
  useEffect(() => {
    if (!Number.isFinite(val)) return;
    if (Math.abs(val - lastEmittedRef.current) > 1e-9) {
      setDraft(String(val));
      lastEmittedRef.current = val;
    }
  }, [val]);

  const commit = (text: string) => {
    setDraft(text);
    if (text === "" || text === "." || text === "-" || text === "-." || text.endsWith(".")) return;
    const n = Number.parseFloat(text);
    if (!Number.isFinite(n)) return;
    lastEmittedRef.current = n;
    onChange(n);
  };

  const onBlur = () => {
    const n = Number.parseFloat(draft);
    if (!Number.isFinite(n)) {
      setDraft(String(Number.isFinite(val) ? val : 0));
      return;
    }
    setDraft(String(n));
  };

  return (
    <label className="block space-y-1">
      <span className="admin-muted text-xs">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          className="admin-input max-w-[200px]"
          value={draft}
          min={opts?.min}
          step={opts?.step ?? 1}
          onChange={(e) => commit(e.target.value)}
          onBlur={onBlur}
        />
        {opts?.unit && <span className="admin-muted text-xs">{opts.unit}</span>}
      </div>
      {opts?.help && <span className="admin-muted text-[10px]">{opts.help}</span>}
    </label>
  );
}

// Legacy positional-arg shim — preserved so existing call sites that take `numInput(label, val, onChange, opts)`
// keep compiling. New code should use <NumberInput /> directly.
function numInput(
  label: string,
  val: number,
  onChange: (n: number) => void,
  opts?: { min?: number; step?: number; unit?: string; help?: string },
) {
  return <NumberInput label={label} val={val} onChange={onChange} opts={opts} />;
}

/**
 * Compact cell-style number input for tables (stage-dwell, ack-windows, record-seconds, etc.).
 * Same string-draft semantics as NumberInput — lets the user clear and retype without snapping
 * back to 0.
 */
function CellNumberInput({
  val,
  onChange,
  min,
  max,
  step,
  className = "admin-input w-24 py-1 text-xs",
}: {
  val: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
}) {
  const [draft, setDraft] = useState<string>(() => String(Number.isFinite(val) ? val : 0));
  const lastEmittedRef = useRef<number>(Number.isFinite(val) ? val : 0);

  useEffect(() => {
    if (!Number.isFinite(val)) return;
    if (Math.abs(val - lastEmittedRef.current) > 1e-9) {
      setDraft(String(val));
      lastEmittedRef.current = val;
    }
  }, [val]);

  return (
    <input
      type="number"
      inputMode="decimal"
      className={className}
      value={draft}
      min={min}
      max={max}
      step={step ?? 1}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        if (text === "" || text === "." || text === "-" || text === "-." || text.endsWith(".")) return;
        const n = Number.parseFloat(text);
        if (!Number.isFinite(n)) return;
        lastEmittedRef.current = n;
        onChange(n);
      }}
      onBlur={() => {
        const n = Number.parseFloat(draft);
        if (!Number.isFinite(n)) {
          setDraft(String(Number.isFinite(val) ? val : 0));
          return;
        }
        setDraft(String(n));
      }}
    />
  );
}

const ENTRY_STATE_LABELS: Record<string, string> = {
  ACTIVE: "Active (in-progress)",
  IDLE: "Idle (no recent activity)",
  PARKED: "Parked (deliberately paused)",
};

const DWELL_LEVEL_HELP: Record<string, string> = {
  warning: "Soft alert to staff",
  critical: "Stronger alert; FOM notified",
  escalation: "GM-level escalation",
};

function StageDwellEditor({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const data = (typeof value === "object" && value !== null ? value : {}) as StageDwellValue;

  const update = (stage: string, state: string, level: string, seconds: number) => {
    const next = { ...data };
    next[stage] = { ...(next[stage] ?? {}) };
    next[stage][state] = { ...(next[stage][state] ?? { warning: 600, critical: 1200, escalation: 1800 }), [level]: seconds };
    onChange(next);
  };

  return (
    <div className="space-y-6 overflow-x-auto">
      <p className="admin-muted text-xs">
        For each stage, set how many seconds an entry can sit before an alert fires. Three escalating levels per entry
        state. 600 = 10 minutes, 3600 = 1 hour, 86400 = 1 day.
      </p>
      {STAGES.map((stage) => (
        <div key={stage} className="rounded-lg border border-[var(--admin-rule)] p-4">
          <h4 className="admin-display mb-3 text-sm">Stage {stage}</h4>
          <table className="admin-table text-xs">
            <thead>
              <tr>
                <th>Entry state</th>
                {DWELL_LEVELS.map((l) => (
                  <th key={l}>
                    <span className="capitalize">{l}</span>
                    <span className="admin-muted block text-[10px] font-normal">{DWELL_LEVEL_HELP[l]} (sec)</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ENTRY_STATES.map((state) => (
                <tr key={state}>
                  <td>{ENTRY_STATE_LABELS[state] ?? state}</td>
                  {DWELL_LEVELS.map((level) => (
                    <td key={level}>
                      <CellNumberInput
                        val={data[stage]?.[state]?.[level] ?? 0}
                        onChange={(n) => update(stage, state, level, n)}
                        min={60}
                        step={60}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function AckWindowsEditor({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const data = (typeof value === "object" && value !== null ? value : {}) as Record<string, number>;

  return (
    <div className="space-y-3">
      <p className="admin-muted text-xs">
        How long (in seconds) the system waits for an acknowledgement before firing a follow-up. 1800 = 30 minutes,
        3600 = 1 hour, 86400 = 1 day. Examples: H2 is the front-desk → housekeeping handoff; PI is the proforma
        invoice sent at S3; VIP arrival is the S5→S6 notification.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {Object.entries(ACK_WINDOW_LABELS).map(([key, label]) => (
          <label key={key} className="block space-y-1">
            <span className="admin-muted text-xs">{label}</span>
            <div className="flex items-center gap-2">
              <CellNumberInput
                className="admin-input"
                val={data[key] ?? 0}
                onChange={(n) => onChange({ ...data, [key]: n })}
                min={60}
                step={60}
              />
              <span className="admin-muted text-[10px]">sec</span>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}

function ProcessingLockEditor({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const channels = [
    { key: "EMAIL_AI", label: "Email (AI)" },
    { key: "WHATSAPP_AI", label: "WhatsApp (AI)" },
    { key: "FRONT_DESK", label: "Front desk" },
    { key: "PHONE", label: "Phone" },
  ];
  const data = (typeof value === "object" && value !== null ? value : {}) as Record<string, number>;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {channels.map((ch) => (
        <label key={ch.key} className="block space-y-1">
          <span className="admin-muted text-xs">{ch.label}</span>
          <CellNumberInput
            className="admin-input"
            val={data[ch.key] ?? 300}
            onChange={(n) => onChange({ ...data, [ch.key]: n })}
            min={30}
          />
        </label>
      ))}
    </div>
  );
}

export function ConfigFormEditor({ schema, value, onChange }: Props) {
  switch (schema.kind) {
    case "number":
      return numInput(schema.label, typeof value === "number" ? value : 0, onChange, {
        min: schema.min,
        step: schema.step,
        unit: schema.unit,
        help: schema.help,
      });
    case "percentage": {
      // Stored as decimal (0.05); user types percentage (5). Track a string draft so the user can
      // type things like "2." or empty without the input snapping back to a number mid-edit.
      const storedDecimal = typeof value === "number" ? value : 0;
      return <PercentageInput schema={schema} storedDecimal={storedDecimal} onChange={onChange} />;
    }
    case "text":
    case "cron":
      return (
        <label className="block space-y-1">
          <span className="admin-muted text-xs">{schema.label}</span>
          <input
            type="text"
            className="admin-input font-mono"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          />
          {schema.help && <span className="admin-muted text-[10px]">{schema.help}</span>}
        </label>
      );
    case "seconds":
    case "hours":
    case "days": {
      const n = typeof value === "number" ? value : 0;
      const unit = schema.kind === "seconds" ? "seconds" : schema.kind === "hours" ? "hours" : "days";
      return numInput(schema.label, n, onChange, { min: 0, unit, help: schema.help });
    }
    case "day-list": {
      const arr = Array.isArray(value) ? (value as number[]) : [];
      const text = arr.join(", ");
      return (
        <label className="block space-y-1">
          <span className="admin-muted text-xs">{schema.label}</span>
          <input
            type="text"
            className="admin-input"
            placeholder="1, 3, 7"
            value={text}
            onChange={(e) => {
              const parsed = e.target.value
                .split(",")
                .map((s) => Number.parseInt(s.trim(), 10))
                .filter((n) => Number.isFinite(n) && n > 0);
              onChange(parsed);
            }}
          />
          {schema.help && <span className="admin-muted text-[10px]">{schema.help}</span>}
        </label>
      );
    }
    case "record-seconds": {
      const data = (typeof value === "object" && value !== null ? value : {}) as Record<string, number>;
      return (
        <div className="space-y-3">
          {schema.fields.map((f) => (
            <label key={f.key} className="block space-y-1">
              <span className="admin-muted text-xs">{f.label}</span>
              <CellNumberInput
                className="admin-input max-w-[200px]"
                val={data[f.key] ?? 0}
                onChange={(n) => onChange({ ...data, [f.key]: n })}
                min={60}
              />
            </label>
          ))}
          {schema.help && <p className="admin-muted text-[10px]">{schema.help}</p>}
        </div>
      );
    }
    case "record-percent": {
      const data = (typeof value === "object" && value !== null ? value : {}) as Record<string, number>;
      return (
        <div className="space-y-3">
          {schema.fields.map((f) => (
            <label key={f.key} className="block space-y-1">
              <span className="admin-muted text-xs">{f.label}</span>
              <CellNumberInput
                className="admin-input max-w-[200px]"
                val={data[f.key] ?? 0}
                onChange={(n) => onChange({ ...data, [f.key]: n })}
                min={0}
                max={100}
                step={1}
              />
            </label>
          ))}
          {schema.help && <p className="admin-muted text-[10px]">{schema.help}</p>}
        </div>
      );
    }
    case "dispute-sla": {
      const data = (typeof value === "object" && value !== null ? value : {}) as {
        firstResponseDueMinutes?: number;
        resolutionReminderMinutes?: number;
      };
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          {numInput("First response due (minutes)", data.firstResponseDueMinutes ?? 240, (n) =>
            onChange({ ...data, firstResponseDueMinutes: n }),
          )}
          {numInput("Resolution reminder (minutes)", data.resolutionReminderMinutes ?? 1440, (n) =>
            onChange({ ...data, resolutionReminderMinutes: n }),
          )}
        </div>
      );
    }
    case "night-audit-schedule": {
      const data = (typeof value === "object" && value !== null ? value : {}) as { stayNightReminderHourUtc?: number };
      return numInput("Stay-night reminder hour (UTC, 0–23)", data.stayNightReminderHourUtc ?? 14, (n) =>
        onChange({ ...data, stayNightReminderHourUtc: Math.min(23, Math.max(0, n)) }),
      );
    }
    case "fom-override-frequency": {
      const data = (typeof value === "object" && value !== null ? value : {}) as {
        rollingWindowDays?: number;
        maxFrequency?: number;
      };
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          {numInput("Rolling window (days)", data.rollingWindowDays ?? 7, (n) => onChange({ ...data, rollingWindowDays: n }))}
          {numInput("Max overrides in window", data.maxFrequency ?? 1, (n) => onChange({ ...data, maxFrequency: n }), { min: 1 })}
        </div>
      );
    }
    case "stage-dwell":
      return <StageDwellEditor value={value} onChange={onChange} />;
    case "ack-windows":
      return <AckWindowsEditor value={value} onChange={onChange} />;
    case "processing-lock-ttl":
      return <ProcessingLockEditor value={value} onChange={onChange} />;
    case "money":
      return numInput(schema.label, typeof value === "number" ? value : 0, onChange, { min: 0, help: schema.help });
    default:
      return null;
  }
}

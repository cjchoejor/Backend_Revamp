"use client";

import {
  ACK_WINDOW_LABELS,
  DWELL_LEVELS,
  ENTRY_STATES,
  STAGES,
  type ConfigSchema,
  type StageDwellValue,
} from "@/lib/admin/config-schemas";

type Props = {
  schema: ConfigSchema;
  value: unknown;
  onChange: (value: unknown) => void;
};

function numInput(
  label: string,
  val: number,
  onChange: (n: number) => void,
  opts?: { min?: number; step?: number; unit?: string; help?: string },
) {
  return (
    <label className="block space-y-1">
      <span className="admin-muted text-xs">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="number"
          className="admin-input max-w-[200px]"
          value={Number.isFinite(val) ? val : 0}
          min={opts?.min}
          step={opts?.step ?? 1}
          onChange={(e) => onChange(Number.parseInt(e.target.value, 10) || 0)}
        />
        {opts?.unit && <span className="admin-muted text-xs">{opts.unit}</span>}
      </div>
      {opts?.help && <span className="admin-muted text-[10px]">{opts.help}</span>}
    </label>
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
                      <input
                        type="number"
                        className="admin-input w-24 py-1 text-xs"
                        min={60}
                        step={60}
                        value={data[stage]?.[state]?.[level] ?? 0}
                        onChange={(e) => update(stage, state, level, Number.parseInt(e.target.value, 10) || 0)}
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
              <input
                type="number"
                className="admin-input"
                min={60}
                step={60}
                value={data[key] ?? 0}
                onChange={(e) => onChange({ ...data, [key]: Number.parseInt(e.target.value, 10) || 0 })}
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
          <input
            type="number"
            className="admin-input"
            min={30}
            value={data[ch.key] ?? 300}
            onChange={(e) => onChange({ ...data, [ch.key]: Number.parseInt(e.target.value, 10) || 0 })}
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
              <input
                type="number"
                className="admin-input max-w-[200px]"
                min={60}
                value={data[f.key] ?? 0}
                onChange={(e) => onChange({ ...data, [f.key]: Number.parseInt(e.target.value, 10) || 0 })}
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
              <input
                type="number"
                className="admin-input max-w-[200px]"
                min={0}
                max={100}
                step={1}
                value={data[f.key] ?? 0}
                onChange={(e) => onChange({ ...data, [f.key]: Number.parseInt(e.target.value, 10) || 0 })}
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

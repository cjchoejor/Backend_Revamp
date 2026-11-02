"use client";

/**
 * Draws a setting's form from its fields (lib/admin/setting-fields.ts). A person sees days and hours,
 * percents, Nu, on and off, lists and tables; what is saved is the shape the setting already has.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/design-system";
import { DurationInput } from "@/components/admin/duration-input";
import { DateInput, TimeInput, timeInWords } from "@/components/ds/date-input";
import { Help } from "@/components/ds/help";
import { useSession } from "@/hooks/use-session";
import { listStaff } from "@/lib/api/admin";
import { codeWords, asRec, hotelHourToUtc, ownError, utcHourToHotel, type Rec, type SField } from "@/lib/admin/setting-fields";

/** A figure typed freely: cleared, half-written, then settled when the field is left. */
export function NumberBox({
  value,
  onChange,
  min,
  max,
  step,
  disabled,
  placeholder,
  className = "admin-input",
  "aria-label": ariaLabel,
}: {
  value: unknown;
  onChange: (next: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
}) {
  const asText = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" ? v : "");
  const [draft, setDraft] = useState(() => asText(value));
  const last = useRef<unknown>(value);

  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setDraft(asText(value));
    }
  }, [value]);

  return (
    <input
      type="number"
      inputMode="decimal"
      className={className}
      value={draft}
      min={min}
      max={max}
      step={step ?? "any"}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        if (text === "") {
          last.current = null;
          onChange(null);
          return;
        }
        const n = Number.parseFloat(text);
        if (!Number.isFinite(n)) return;
        last.current = n;
        onChange(n);
      }}
      onBlur={() => setDraft(asText(last.current))}
    />
  );
}

/** A percent shown as a person writes it, stored as whole or as a fraction (5 or 0.05). */
function PercentBox({ f, value, onChange, disabled }: { f: Extract<SField, { kind: "percent" }>; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const fraction = f.stored === "fraction";
  const n = typeof value === "number" ? value : null;
  const shown = n == null ? null : fraction ? Math.round(n * 100 * 1e6) / 1e6 : n;
  return (
    <span className="sf-unit">
      <NumberBox
        value={shown}
        min={f.min ?? 0}
        max={f.max ?? 100}
        step={f.step}
        disabled={disabled}
        aria-label={f.label}
        onChange={(v) => onChange(v == null ? null : fraction ? Math.round((v / 100) * 1e6) / 1e6 : v)}
      />
      <span>%</span>
    </span>
  );
}

function Toggle({ f, value, onChange, disabled }: { f: Extract<SField, { kind: "toggle" }>; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const on = value === true;
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={f.label} className="sf-toggle" disabled={disabled} onClick={() => onChange(!on)}>
      <span className="track" aria-hidden />
      <span className="word">{on ? f.on ?? "On" : f.off ?? "Off"}</span>
    </button>
  );
}

function ChoiceButtons({ f, value, onChange, disabled }: { f: Extract<SField, { kind: "choice" }>; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  return (
    <div className="filters choice">
      {f.options.map((o) => (
        <Button
          key={o.value}
          kind={o.value === value ? "secondary" : "quiet"}
          compact
          aria-pressed={o.value === value}
          state={disabled && o.value !== value ? "inert" : "default"}
          onClick={disabled ? undefined : () => onChange(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

/** Pick several; anything already saved that the list does not name is kept and shown. */
function MultiPick({ f, value, onChange, disabled }: { f: Extract<SField, { kind: "multi" }>; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const picked = (Array.isArray(value) ? value : []).map(String);
  const known = new Set(f.options.map((o) => o.value));
  const extras = picked.filter((p) => !known.has(p));
  const [other, setOther] = useState("");
  const flip = (v: string) => onChange(picked.includes(v) ? picked.filter((p) => p !== v) : [...picked, v]);
  const addOther = () => {
    const v = other.trim();
    if (!v) return;
    if (!picked.includes(v)) onChange([...picked, v]);
    setOther("");
  };
  return (
    <div className="sf-chips">
      {[...f.options, ...extras.map((e) => ({ value: e, label: e }))].map((o) => (
        <button key={o.value} type="button" className="sf-chip" aria-pressed={picked.includes(o.value)} disabled={disabled} onClick={() => flip(o.value)}>
          {o.label}
        </button>
      ))}
      {f.other ? (
        <span className="sf-add">
          <input
            className="admin-input"
            style={{ width: 200 }}
            placeholder={f.other}
            value={other}
            disabled={disabled}
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addOther();
              }
            }}
          />
          <button type="button" className="admin-btn text-[10px]" disabled={disabled || !other.trim()} onClick={addOther}>
            Add
          </button>
        </span>
      ) : null}
    </div>
  );
}

function Tags({ f, value, onChange, disabled }: { f: Extract<SField, { kind: "tags" }>; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const items = (Array.isArray(value) ? value : []).map(String);
  const [text, setText] = useState("");
  const add = () => {
    const v = text.trim();
    if (!v) return;
    if (!items.includes(v)) onChange([...items, v]);
    setText("");
  };
  return (
    <div className="sf-chips">
      {items.map((t) => (
        <span key={t} className="sf-tag">
          {t}
          <button type="button" aria-label={`Remove ${t}`} disabled={disabled} onClick={() => onChange(items.filter((x) => x !== t))}>
            ×
          </button>
        </span>
      ))}
      <span className="sf-add">
        <input
          className="admin-input"
          placeholder={f.placeholder ?? "Type and press Enter"}
          value={text}
          disabled={disabled}
          aria-label={f.label}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="admin-btn text-[10px]" disabled={disabled || !text.trim()} onClick={add}>
          {f.addLabel ?? "Add"}
        </button>
      </span>
    </div>
  );
}

function NumberList({ f, value, onChange, disabled }: { f: Extract<SField, { kind: "numberList" }>; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const items = (Array.isArray(value) ? value : []).filter((n): n is number => typeof n === "number");
  const [text, setText] = useState("");
  const add = () => {
    const n = Number.parseInt(text, 10);
    if (!Number.isFinite(n) || n <= 0) return;
    if (!items.includes(n)) onChange([...items, n].sort((a, b) => a - b));
    setText("");
  };
  return (
    <div className="sf-chips">
      {items.map((n) => (
        <span key={n} className="sf-tag">
          {n} {f.unit}
          <button type="button" aria-label={`Remove ${n} ${f.unit}`} disabled={disabled} onClick={() => onChange(items.filter((x) => x !== n))}>
            ×
          </button>
        </span>
      ))}
      <span className="sf-add">
        <input
          inputMode="numeric"
          className="admin-input"
          style={{ width: 90 }}
          placeholder={f.placeholder}
          value={text}
          disabled={disabled}
          aria-label={f.label}
          onChange={(e) => {
            if (/^\d*$/.test(e.target.value)) setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="admin-btn text-[10px]" disabled={disabled || !text} onClick={add}>
          Add
        </button>
      </span>
    </div>
  );
}

/** The people a thing can be given to. Someone on file who is no longer on the list still shows. */
function StaffPick({ f, value, onChange, disabled }: { f: Extract<SField, { kind: "staff" }>; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const { session } = useSession();
  const staff = useQuery({ queryKey: ["admin", "staff", "active"], queryFn: () => listStaff(session!), enabled: !!session, staleTime: 60_000 });
  const items = staff.data?.items ?? [];
  const current = typeof value === "string" ? value : "";
  const known = items.some((s) => s.id === current);
  return (
    <select className="admin-select sf-input" value={current} disabled={disabled} aria-label={f.label} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose…</option>
      {current && !known ? <option value={current}>{staff.isLoading ? current : "Nobody on the staff list"}</option> : null}
      {items.map((s) => (
        <option key={s.id} value={s.id}>
          {s.fullName}
        </option>
      ))}
    </select>
  );
}

function RowsTable({ f, value, onChange, disabled }: { f: Extract<SField, { kind: "rows" }>; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const rows = (Array.isArray(value) ? value : []) as unknown[];
  const fixed = f.fixedKey;
  const setRow = (i: number, next: unknown) => onChange(rows.map((r, idx) => (idx === i ? next : r)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="sf-form" style={{ gap: "var(--s2)" }}>
      {rows.length === 0 ? (
        <p className="sf-empty">{f.emptyText ?? "Nothing here yet."}</p>
      ) : (
        <div className="sf-table-wrap">
          <table className="sf-table">
            <thead>
              <tr>
                {fixed ? <th>{f.label}</th> : null}
                {f.columns.map((c) => (
                  <th key={c.key ?? c.label}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      {c.label}
                      {c.help ? <Help label={c.label}>{c.help}</Help> : null}
                    </span>
                  </th>
                ))}
                {fixed ? null : <th aria-label="Acts" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {fixed ? <td className="row-name">{f.fixedNames?.[String(asRec(row)[fixed])] ?? String(asRec(row)[fixed] ?? "")}</td> : null}
                  {f.columns.map((c) => {
                    const o = asRec(row);
                    return (
                      <td key={c.key ?? c.label}>
                        <Control f={c} value={c.key ? o[c.key] : row} disabled={disabled} onChange={(v) => setRow(i, c.key ? { ...o, [c.key]: v } : v)} />
                      </td>
                    );
                  })}
                  {fixed ? null : (
                  <td className="acts">
                    <span style={{ display: "inline-flex", gap: 4 }}>
                      {f.reorder ? (
                        <>
                          <button type="button" className="sf-icon-btn" aria-label="Move up" disabled={disabled || i === 0} onClick={() => move(i, -1)}>
                            ↑
                          </button>
                          <button type="button" className="sf-icon-btn" aria-label="Move down" disabled={disabled || i === rows.length - 1} onClick={() => move(i, 1)}>
                            ↓
                          </button>
                        </>
                      ) : null}
                      <button type="button" className="sf-icon-btn danger" aria-label="Remove this row" disabled={disabled} onClick={() => onChange(rows.filter((_, idx) => idx !== i))}>
                        ×
                      </button>
                    </span>
                  </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {fixed ? null : (
        <div>
          <button type="button" className="admin-btn text-[10px]" disabled={disabled} onClick={() => onChange([...rows, { ...f.blank }])}>
            {f.addLabel}
          </button>
        </div>
      )}
    </div>
  );
}

/** A row for every row and sub-row, with the rows' name once across the group. */
function GridTable({ f, value, onChange, disabled }: { f: Extract<SField, { kind: "grid" }>; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const o = asRec(value);
  const set = (row: string, sub: string, col: string, v: unknown) => {
    const r = asRec(o[row]);
    const s = asRec(r[sub]);
    onChange({ ...o, [row]: { ...r, [sub]: { ...s, [col]: v } } });
  };
  return (
    <div className="sf-table-wrap">
      <table className="sf-table">
        <thead>
          <tr>
            <th>{f.rowLabel}</th>
            <th>{f.subLabel}</th>
            {f.columns.map((c) => (
              <th key={c.key}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  {c.label}
                  {c.help ? <Help label={c.label}>{c.help}</Help> : null}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {f.rows.map((r) =>
            f.subRows.map((s, i) => (
              <tr key={`${r.key}-${s.key}`}>
                {i === 0 ? (
                  <td className="row-name" rowSpan={f.subRows.length} style={{ verticalAlign: "top" }}>
                    {r.label}
                  </td>
                ) : null}
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                    {s.label}
                    {s.help ? <Help label={s.label}>{s.help}</Help> : null}
                  </span>
                </td>
                {f.columns.map((c) => (
                  <td key={c.key}>
                    <Control
                      f={{ ...f.cell, label: `${r.label}, ${s.label}, ${c.label}` } as SField}
                      value={asRec(asRec(o[r.key])[s.key])[c.key]}
                      disabled={disabled}
                      onChange={(v) => set(r.key, s.key, c.key, v)}
                    />
                  </td>
                ))}
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

/** One row for each name: the rows always offered, then any others the value holds. */
function MapTable({ f, value, onChange, disabled }: { f: Extract<SField, { kind: "map" }>; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const o = asRec(value);
  const knownKeys = f.rows.map((r) => r.key);
  const extra = Object.keys(o).filter((k) => !knownKeys.includes(k));
  const [newKey, setNewKey] = useState("");
  const canAdd = !!(f.addLabel && (f.addOptions || f.addPlaceholder));
  const left = f.addOptions?.filter((a) => !knownKeys.includes(a.value) && !(a.value in o)) ?? [];
  const add = () => {
    const k = newKey.trim();
    if (!k || k in o) return;
    onChange({ ...o, [k]: f.blank ?? null });
    setNewKey("");
  };
  const nameOf = (k: string) => f.rows.find((r) => r.key === k)?.label ?? f.addOptions?.find((a) => a.value === k)?.label ?? f.nameOf?.(k) ?? (/^[A-Z][A-Z0-9_]*$/.test(k) ? codeWords(k) : k);
  const simple = (c: SField) => c.kind !== "group" && c.kind !== "rows" && c.kind !== "map" && c.kind !== "grid";
  const columns: SField[] | null = f.value.kind === "group" ? (f.value.fields.every(simple) ? f.value.fields : null) : simple(f.value) ? [f.value] : null;
  const inTable = columns !== null;
  const rows = [...knownKeys, ...extra];
  return (
    <div className="sf-form" style={{ gap: "var(--s2)" }}>
      {inTable ? (
        <div className="sf-table-wrap">
          <table className="sf-table">
            <thead>
              <tr>
                <th>{f.keyLabel ?? "For"}</th>
                {columns!.map((c) => (
                  <th key={c.key ?? c.label}>{c.label}</th>
                ))}
                {canAdd ? <th aria-label="Acts" /> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((k) => {
                const known = f.rows.find((r) => r.key === k);
                return (
                  <tr key={k}>
                    <td className="row-name">
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        {nameOf(k)}
                        {known?.help ? <Help label={nameOf(k)}>{known.help}</Help> : null}
                      </span>
                    </td>
                    {columns!.map((c) => {
                      const cell = asRec(o[k]);
                      return (
                        <td key={c.key ?? c.label}>
                          <Control
                            f={{ ...c, label: `${nameOf(k)}, ${c.label}` } as SField}
                            value={c.key ? cell[c.key] : o[k]}
                            disabled={disabled}
                            onChange={(v) => onChange({ ...o, [k]: c.key ? { ...cell, [c.key]: v } : v })}
                          />
                        </td>
                      );
                    })}
                    {canAdd ? (
                      <td className="acts">
                        {!known ? (
                          <button
                            type="button"
                            className="sf-icon-btn danger"
                            aria-label={`Remove ${nameOf(k)}`}
                            disabled={disabled}
                            onClick={() => {
                              const { [k]: _gone, ...rest } = o;
                              void _gone;
                              onChange(rest);
                            }}
                          >
                            ×
                          </button>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={columns!.length + (canAdd ? 2 : 1)} className="sf-empty">
                    Nothing here yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : (
        rows.map((k) => (
          <div key={k} className="sf-group">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span className="sf-title">{nameOf(k)}</span>
              {canAdd && !knownKeys.includes(k) ? (
                <button
                  type="button"
                  className="sf-icon-btn danger"
                  aria-label={`Remove ${nameOf(k)}`}
                  disabled={disabled}
                  onClick={() => {
                    const { [k]: _gone, ...rest } = o;
                    void _gone;
                    onChange(rest);
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
            <Control f={f.value} value={o[k]} disabled={disabled} onChange={(v) => onChange({ ...o, [k]: v })} />
          </div>
        ))
      )}
      {canAdd && (!f.addOptions || left.length > 0) ? (
        <span className="sf-add">
          {f.addOptions ? (
            <select className="admin-select" style={{ width: 220 }} value={newKey} disabled={disabled} aria-label={f.addLabel} onChange={(e) => setNewKey(e.target.value)}>
              <option value="">Choose…</option>
              {left.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="admin-input"
              placeholder={f.addPlaceholder}
              value={newKey}
              disabled={disabled}
              aria-label={f.addLabel}
              onChange={(e) => setNewKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
          )}
          <button type="button" className="admin-btn text-[10px]" disabled={disabled || !newKey.trim()} onClick={add}>
            {f.addLabel}
          </button>
        </span>
      ) : null}
    </div>
  );
}

function Group({ f, value, onChange, disabled }: { f: Extract<SField, { kind: "group" }>; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const o = asRec(value);
  if (f.when && !f.when(o)) return null;
  const body = (
    <div className={f.lines ? "sf-form" : "sf-grid"}>
      {f.fields.map((c, i) => (
        <SettingField
          key={c.key ?? `${c.label}-${i}`}
          f={c}
          value={c.key ? o[c.key] : o}
          disabled={disabled}
          onChange={(v) => onChange(c.key ? { ...o, [c.key]: v } : { ...o, ...asRec(v) })}
        />
      ))}
    </div>
  );
  return f.boxed ? <div className="sf-group">{body}</div> : body;
}

/** The control alone, with no label: what a table cell holds. */
export function Control({ f, value, onChange, disabled }: { f: SField; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }): ReactNode {
  switch (f.kind) {
    case "number":
      return (
        <span className="sf-unit">
          <NumberBox value={value} min={f.min} max={f.max} step={f.step} disabled={disabled} placeholder={f.blank} aria-label={f.label} onChange={onChange} />
          {f.unit ? <span>{f.unit}</span> : null}
        </span>
      );
    case "money":
      return (
        <span className="sf-unit">
          <span>Nu</span>
          <NumberBox value={value} min={f.min ?? 0} disabled={disabled} placeholder={f.blank} aria-label={f.label} onChange={onChange} />
        </span>
      );
    case "percent":
      return <PercentBox f={f} value={value} onChange={onChange} disabled={disabled} />;
    case "duration":
      return <DurationInput value={value} base={f.base} units={f.units} compact={f.compact} disabled={disabled} invalid={!!ownError(f, value)} aria-label={f.label} onChange={onChange} />;
    case "time":
      return <TimeInput className="admin-input sf-input" value={typeof value === "string" && /^\d{2}:\d{2}$/.test(value) ? value : ""} disabled={disabled} aria-label={f.label} onChange={(e) => onChange(e.target.value)} />;
    case "hotelHour": {
      const h = typeof value === "number" ? utcHourToHotel(value) : "";
      return (
        <select className="admin-select sf-input" value={h} disabled={disabled} aria-label={f.label} onChange={(e) => onChange(hotelHourToUtc(Number(e.target.value)))}>
          {Array.from({ length: 24 }, (_, i) => (
            <option key={i} value={i}>
              {timeInWords(`${String(i).padStart(2, "0")}:00`)}
            </option>
          ))}
        </select>
      );
    }
    case "grid":
      return <GridTable f={f} value={value} onChange={onChange} disabled={disabled} />;
    case "date":
      return <DateInput className="admin-input sf-input" value={typeof value === "string" ? value : ""} disabled={disabled} aria-label={f.label} onChange={(e) => onChange(e.target.value)} />;
    case "text":
      if (f.secret) {
        const set = !!asRec(value).__set;
        return (
          <input
            type="password"
            autoComplete="new-password"
            className="admin-input sf-input"
            placeholder={set ? "Saved · type to replace it" : f.placeholder}
            value={typeof value === "string" ? value : ""}
            disabled={disabled}
            aria-label={f.label}
            onChange={(e) => onChange(e.target.value === "" && set ? { __set: true } : e.target.value)}
          />
        );
      }
      return f.multiline ? (
        <textarea className="admin-input" rows={4} placeholder={f.placeholder} value={typeof value === "string" ? value : ""} disabled={disabled} aria-label={f.label} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className={`admin-input sf-input${f.wide ? " wide" : ""}`} placeholder={f.placeholder} value={typeof value === "string" ? value : ""} disabled={disabled} aria-label={f.label} onChange={(e) => onChange(e.target.value)} />
      );
    case "toggle":
      return <Toggle f={f} value={value} onChange={onChange} disabled={disabled} />;
    case "staff":
      return <StaffPick f={f} value={value} onChange={onChange} disabled={disabled} />;
    case "choice":
      return <ChoiceButtons f={f} value={value} onChange={onChange} disabled={disabled} />;
    case "select": {
      const known = f.options.some((o) => o.value === value);
      return (
        <select className="admin-select sf-input" value={typeof value === "string" ? value : ""} disabled={disabled} aria-label={f.label} onChange={(e) => onChange(e.target.value)}>
          <option value="">{f.placeholder ?? "Choose…"}</option>
          {!known && typeof value === "string" && value ? <option value={value}>{value}</option> : null}
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    case "multi":
      return <MultiPick f={f} value={value} onChange={onChange} disabled={disabled} />;
    case "tags":
      return <Tags f={f} value={value} onChange={onChange} disabled={disabled} />;
    case "numberList":
      return <NumberList f={f} value={value} onChange={onChange} disabled={disabled} />;
    case "group":
      return <Group f={f} value={value} onChange={onChange} disabled={disabled} />;
    case "rows":
      return <RowsTable f={f} value={value} onChange={onChange} disabled={disabled} />;
    case "map":
      return <MapTable f={f} value={value} onChange={onChange} disabled={disabled} />;
  }
}

/** A field with its name above it, its "?" beside the name and its refusal under it. */
export function SettingField({ f, value, onChange, disabled, bare }: { f: SField; value: unknown; onChange: (v: unknown) => void; disabled?: boolean; bare?: boolean }) {
  const error = ownError(f, value);
  const showLabel = !bare && !!f.label;
  if (f.kind === "group" && !f.label) return <Control f={f} value={value} onChange={onChange} disabled={disabled} />;
  return (
    <div className="sf-field">
      {showLabel ? (
        <span className={f.kind === "group" ? "sf-title" : "sf-label"}>
          {f.label}
          {f.help ? <Help label={f.label}>{f.help}</Help> : null}
        </span>
      ) : null}
      <Control f={f} value={value} onChange={onChange} disabled={disabled} />
      {error ? <span className="sf-error" role="alert">{error}</span> : null}
    </div>
  );
}

/** A whole setting's form. Its fields at the top level hold the value itself. */
export function SettingForm({ form, value, onChange, disabled }: { form: SField; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  return (
    <div className="sf-form">
      <SettingField f={form} value={value} onChange={onChange} disabled={disabled} bare={form.kind === "rows" || form.kind === "map" || form.kind === "group" || form.kind === "grid"} />
    </div>
  );
}

export type { Rec };

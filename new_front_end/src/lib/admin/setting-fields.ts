/**
 * The vocabulary a setting's form is written in (2026-11-02, operator: "if there are still some json
 * fields which is used to alter the settings, make it into proper UI UX"). A setting says what it
 * holds field by field; `components/admin/setting-form.tsx` draws it. The stored shape never changes:
 * a form only edits the fields it names and leaves everything else on the value alone.
 */
import { isoToDmy, timeInWords } from "@/components/ds/date-input";
import { durationInWords, type DurationBase, type DurationUnit } from "@/components/admin/duration-input";

export type Opt = { value: string; label: string };
export type Rec = Record<string, unknown>;

type Common = {
  /** Where the field sits on its parent. Left out, the field is the value itself. */
  key?: string;
  label: string;
  /** Behind a "?": what the field is for. */
  help?: string;
  /** A blank is allowed (it saves as nothing). */
  optional?: boolean;
  /** In a rows table: the field this row draws instead, such as Nu or a percent by the row's choice. */
  perRow?: (row: Rec) => SField | undefined;
};

export type SField =
  | (Common & { kind: "number"; unit?: string; min?: number; max?: number; step?: number; blank?: string; whole?: boolean })
  | (Common & { kind: "money"; min?: number; blank?: string })
  | (Common & { kind: "percent"; stored: "whole" | "fraction"; min?: number; max?: number; step?: number })
  | (Common & { kind: "duration"; base: DurationBase; units?: DurationUnit[]; min?: number; compact?: boolean })
  | (Common & { kind: "time" })
  | (Common & { kind: "date" })
  /** An hour stored in UTC (0–23), shown and picked on the hotel's clock. */
  | (Common & { kind: "hotelHour" })
  /** value[row][sub][column]: one table, with a row for every row and sub-row. */
  | (Common & {
      kind: "grid";
      rows: { key: string; label: string }[];
      subRows: { key: string; label: string; help?: string }[];
      columns: { key: string; label: string; help?: string }[];
      cell: SField;
      rowLabel: string;
      subLabel: string;
    })
  | (Common & { kind: "text"; placeholder?: string; multiline?: boolean; wide?: boolean; secret?: boolean })
  | (Common & { kind: "toggle"; on?: string; off?: string })
  /** A member of staff, by their id. */
  | (Common & { kind: "staff" })
  | (Common & { kind: "choice"; options: Opt[] })
  | (Common & { kind: "select"; options: Opt[]; placeholder?: string })
  | (Common & { kind: "multi"; options: Opt[]; other?: string })
  | (Common & { kind: "tags"; placeholder?: string; addLabel?: string })
  | (Common & { kind: "numberList"; unit: string; placeholder?: string })
  | (Common & { kind: "group"; fields: SField[]; boxed?: boolean; when?: (v: Rec) => boolean; lines?: boolean })
  | (Common & {
      kind: "rows";
      columns: SField[];
      blank: Rec;
      addLabel: string;
      word?: [string, string];
      reorder?: boolean;
      emptyText?: string;
      /** The rows are fixed: named by this field, none added or removed. */
      fixedKey?: string;
      fixedNames?: Record<string, string>;
    })
  | (Common & {
      kind: "map";
      /** The rows always offered, in order. */
      rows: { key: string; label: string; help?: string }[];
      value: SField;
      /** The name above the first column. */
      keyLabel?: string;
      /** Offer more rows: the words on the button, and what they may be named. */
      addLabel?: string;
      addOptions?: Opt[];
      addPlaceholder?: string;
      /** A new row's starting value. */
      blank?: unknown;
      nameOf?: (key: string) => string;
    });

/** The hotel's offset from UTC in whole hours. Bhutan does not change its clocks. */
export const HOTEL_UTC_OFFSET_HOURS = 6;
export const utcHourToHotel = (h: number) => ((h + HOTEL_UTC_OFFSET_HOURS) % 24 + 24) % 24;
export const hotelHourToUtc = (h: number) => ((h - HOTEL_UTC_OFFSET_HOURS) % 24 + 24) % 24;

/** A stored code as words: SOFT_FURNISHING reads "Soft furnishing". */
export function codeWords(code: string): string {
  const s = code.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function asRec(v: unknown): Rec {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {};
}

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const isBlank = (v: unknown) => v === null || v === undefined || v === "";

const nu = (n: number) => `Nu ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const pct = (n: number) => `${Math.round(n * 10000) / 10000}%`;

/** A field's own refusal, in words. Null when it is fine. */
export function ownError(f: SField, v: unknown): string | null {
  switch (f.kind) {
    case "number":
    case "money":
    case "percent": {
      if (isBlank(v)) return f.optional ? null : `${f.label}: enter a figure`;
      const n = num(v);
      if (n == null) return `${f.label}: that is not a figure`;
      const shown = f.kind === "percent" && f.stored === "fraction" ? n * 100 : n;
      const min = f.min ?? (f.kind === "money" || f.kind === "percent" ? 0 : undefined);
      const max = f.kind === "number" ? f.max : f.kind === "percent" ? f.max ?? 100 : undefined;
      if (min != null && shown < min) return `${f.label}: at least ${min}`;
      if (max != null && shown > max) return `${f.label}: at most ${max}`;
      if (f.kind === "number" && f.whole && !Number.isInteger(n)) return `${f.label}: a whole number`;
      return null;
    }
    case "duration": {
      const n = num(v) ?? 0;
      if (f.min != null && n < f.min) return `${f.label}: at least ${durationInWords(f.min, f.base).toLowerCase()}`;
      return null;
    }
    case "time":
      if (isBlank(v)) return f.optional ? null : `${f.label}: pick a time`;
      return null;
    case "date":
      if (isBlank(v)) return f.optional ? null : `${f.label}: pick a date`;
      return null;
    case "text":
      if (f.secret && asRec(v).__set) return null;
      if (isBlank(v) && !f.optional) return `${f.label}: fill this in`;
      return null;
    case "choice":
    case "select":
    case "staff":
      if (isBlank(v) && !f.optional) return `${f.label}: pick one`;
      return null;
    default:
      return null;
  }
}

/** Every refusal in a field and what it holds: the Save waits for none. */
export function errorsOf(f: SField, v: unknown): string[] {
  switch (f.kind) {
    case "grid": {
      const o = asRec(v);
      return f.rows.flatMap((r) =>
        f.subRows.flatMap((s) =>
          f.columns.flatMap((c) => errorsOf(f.cell, asRec(asRec(o[r.key])[s.key])[c.key]).map((m) => `${r.label}, ${s.label}, ${c.label} · ${m}`)),
        ),
      );
    }
    case "group": {
      const o = asRec(v);
      if (f.when && !f.when(o)) return [];
      return f.fields.flatMap((c) => errorsOf(c, c.key ? o[c.key] : o));
    }
    case "rows": {
      const rows = Array.isArray(v) ? v : [];
      return rows.flatMap((r, i) =>
        f.columns.flatMap((c) => errorsOf(c, c.key ? asRec(r)[c.key] : r).map((m) => `Row ${i + 1} · ${m}`)),
      );
    }
    case "map": {
      const o = asRec(v);
      const keys = [...f.rows.map((r) => r.key), ...Object.keys(o).filter((k) => !f.rows.some((r) => r.key === k))];
      return keys.flatMap((k) => {
        const label = f.rows.find((r) => r.key === k)?.label ?? f.nameOf?.(k) ?? k;
        const known = f.rows.some((r) => r.key === k);
        // A row the value does not carry yet is left out, not refused.
        if (!(k in o) && known) return [];
        return errorsOf(f.value, o[k]).map((m) => `${label} · ${m}`);
      });
    }
    default: {
      const e = ownError(f, v);
      return e ? [e] : [];
    }
  }
}

function labelOf(options: Opt[], v: unknown): string {
  return options.find((o) => o.value === v)?.label ?? String(v ?? "");
}

function listWords(items: string[], most = 3): string {
  if (items.length === 0) return "None";
  return items.length <= most ? items.join(", ") : `${items.slice(0, most).join(", ")} and ${items.length - most} more`;
}

/** The value in words, for the row it sits on. */
export function summarise(f: SField, v: unknown): string {
  switch (f.kind) {
    case "number": {
      if (isBlank(v)) return f.blank ?? "Not set";
      const n = num(v);
      return n == null ? "Not set" : f.unit ? `${n} ${f.unit}` : String(n);
    }
    case "money": {
      if (isBlank(v)) return f.blank ?? "Not set";
      const n = num(v);
      return n == null ? "Not set" : nu(n);
    }
    case "percent": {
      const n = num(v);
      if (n == null) return "Not set";
      return pct(f.stored === "fraction" ? n * 100 : n);
    }
    case "duration":
      return isBlank(v) ? "Not set" : durationInWords(v, f.base);
    case "time":
      return typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? timeInWords(v) : "Not set";
    case "date":
      return typeof v === "string" && v ? isoToDmy(v) : "Not set";
    case "hotelHour": {
      const h = num(v);
      return h == null ? "Not set" : timeInWords(`${String(utcHourToHotel(h)).padStart(2, "0")}:00`);
    }
    case "grid":
      return `${f.rows.length} ${f.rowLabel.toLowerCase()}s`;
    case "text":
      if (f.secret) return asRec(v).__set || (typeof v === "string" && v) ? "Saved" : "Not set";
      return typeof v === "string" && v ? (v.length > 60 ? `${v.slice(0, 57)}…` : v) : "Not set";
    case "toggle":
      return v === true ? f.on ?? "On" : f.off ?? "Off";
    case "staff":
      return isBlank(v) ? "Not set" : String(v);
    case "choice":
    case "select":
      return isBlank(v) ? "Not set" : labelOf(f.options, v);
    case "multi":
      return listWords((Array.isArray(v) ? v : []).map((x) => labelOf(f.options, x)));
    case "tags":
      return listWords((Array.isArray(v) ? v : []).map(String));
    case "numberList": {
      const a = Array.isArray(v) ? v : [];
      return a.length ? `${a.join(", ")} ${f.unit}` : "None";
    }
    case "group": {
      const o = asRec(v);
      if (f.when && !f.when(o)) return "";
      const toggle = f.fields.find((c) => c.kind === "toggle" && c.key === "enabled");
      if (toggle && o.enabled === false) return summarise(toggle, false);
      const said = f.fields
        .filter((c) => c !== toggle)
        .map((c) => {
          const s = summarise(c, c.key ? o[c.key] : o);
          if (!s) return "";
          return c.kind === "group" || c.kind === "rows" || c.kind === "map" || !c.label ? s : `${c.label} ${s}`;
        })
        .filter(Boolean)
        .slice(0, 3)
        .join(" · ");
      return said || (toggle ? summarise(toggle, o.enabled !== false) : "");
    }
    case "rows": {
      const n = Array.isArray(v) ? v.length : 0;
      const [one, many] = f.word ?? ["row", "rows"];
      return n === 0 ? "None" : `${n} ${n === 1 ? one : many}`;
    }
    case "map": {
      const o = asRec(v);
      const keys = [...f.rows.map((r) => r.key).filter((k) => k in o), ...Object.keys(o).filter((k) => !f.rows.some((r) => r.key === k))];
      if (keys.length === 0) return "None";
      const parts = keys.map((k) => `${f.rows.find((r) => r.key === k)?.label ?? f.addOptions?.find((a) => a.value === k)?.label ?? f.nameOf?.(k) ?? k}: ${summarise(f.value, o[k])}`);
      return parts.length <= 3 ? parts.join(" · ") : `${parts.slice(0, 3).join(" · ")} and ${parts.length - 3} more`;
    }
  }
}

/** A starting value for a setting that has nothing saved. */
export function emptyValueOf(f: SField): unknown {
  switch (f.kind) {
    case "number":
    case "money":
    case "percent":
    case "duration":
      return f.optional ? null : 0;
    case "time":
    case "date":
    case "text":
    case "choice":
    case "select":
    case "staff":
      return "";
    case "toggle":
      return false;
    case "multi":
    case "tags":
    case "numberList":
    case "rows":
      return [];
    case "hotelHour":
      return 0;
    case "group":
    case "grid":
    case "map":
      return {};
  }
}

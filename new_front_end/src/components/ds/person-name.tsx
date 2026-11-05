"use client";

import type { CSSProperties } from "react";
import { usePhoneRules } from "@/hooks/use-phone-rules";
import { splitTitle } from "@/lib/ds/person";

/**
 * The title list, wherever a name is asked (2026-11-05, operator: "we need the option to add title
 * where ever name is asked, so that user don't have to write title in the name field"). A title
 * already on a record stays on the list, whatever it is.
 */
export function TitleSelect({
  value,
  onChange,
  className = "input",
  disabled,
  ariaLabel = "Title",
  style,
}: {
  value: string | null | undefined;
  onChange: (title: string) => void;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  style?: CSSProperties;
}) {
  const { titles } = usePhoneRules();
  const v = value ?? "";
  return (
    <select className={className} style={style} aria-label={ariaLabel} value={v} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {v && !titles.includes(v) ? <option value={v}>{v}</option> : null}
      {titles.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

/**
 * A title and one Name, side by side, with their labels. The backend splits the name for its two
 * columns (three words: the first two, then the last), and one word is a whole name. A title typed
 * into the name moves to the Title box when the desk leaves the field.
 */
export function PersonName({
  title,
  name,
  onTitle,
  onName,
  nameLabel = "Name",
  namePlaceholder,
  readOnly,
  autoFocus,
  ariaLabel,
  required,
}: {
  title: string | null | undefined;
  name: string;
  onTitle: (title: string) => void;
  onName: (name: string) => void;
  nameLabel?: string;
  namePlaceholder?: string;
  readOnly?: boolean;
  autoFocus?: boolean;
  ariaLabel?: string;
  required?: boolean;
}) {
  return (
    <div className="person-name">
      <div className="field">
        <label>Title</label>
        <TitleSelect value={title} onChange={onTitle} disabled={readOnly} />
      </div>
      <div className="field">
        <label>
          {nameLabel}
          {required ? (
            <span className="stop-ink" aria-hidden style={{ fontWeight: 700, marginLeft: 2 }}>
              *
            </span>
          ) : null}
        </label>
        <input
          className="input"
          aria-label={ariaLabel}
          value={name}
          readOnly={readOnly}
          autoFocus={autoFocus}
          placeholder={namePlaceholder}
          onChange={(e) => onName(e.target.value)}
          onBlur={() => {
            const typed = splitTitle(name);
            if (!typed.title) return;
            if (!title?.trim()) onTitle(typed.title);
            onName(typed.name);
          }}
        />
      </div>
    </div>
  );
}

"use client";

import type { CSSProperties } from "react";
import { DeskTagInput, nameWithoutNote, noteInName, tidyDeskTag } from "@/components/ds/desk-tag";
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
 *
 * With `tag` (2026-11-25), the desk's own note sits at the right ("BOLD/MOA"), and a word in the name
 * that reads as such a note is offered to move there — never moved by itself.
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
  tag,
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
  tag?: { value: string; onChange: (v: string) => void; onCommit?: (v: string) => void; readOnly?: boolean; state?: "saving" | "saved" | null };
}) {
  const note = tag && !tag.readOnly && !readOnly ? noteInName(name) : null;
  return (
    <div className={`person-name${tag ? " with-tag" : ""}`}>
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
        {note ? (
          <span className="hint warn-ink name-note">
            &ldquo;{note}&rdquo; reads as a note, not a name — it would go on the papers.{" "}
            <button
              type="button"
              className="linklike"
              onClick={() => {
                const moved = tidyDeskTag([tag!.value, note.replace(/^[([]|[)\]]$/g, "")].filter((x) => x.trim()).join(" "));
                onName(nameWithoutNote(name, note));
                tag!.onChange(moved);
                tag!.onCommit?.(moved);
              }}
            >
              Move it to Tag
            </button>
          </span>
        ) : null}
      </div>
      {tag ? <DeskTagInput value={tag.value} onChange={tag.onChange} onCommit={tag.onCommit} readOnly={tag.readOnly} state={tag.state} /> : null}
    </div>
  );
}

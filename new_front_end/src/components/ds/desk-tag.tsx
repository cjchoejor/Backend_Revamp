"use client";

/**
 * The desk tag (2026-11-25, operator: "when there are people coming with the same name, the front desk
 * keeps side notes like BOLD/MOA — their company name or some sort — to remember it; it hinders our
 * name field, the system takes bold/moa as a last name, and in the future the mails may use it. Have
 * another field for such purpose, beside the name field, optional, shown on the top but greyed out,
 * and in the bookings too").
 *
 * One short note on the ENQUIRY (a trip's stays share it), the desk's own: shown greyed beside the
 * name, searched in the Bookings list, never printed on a paper or in an email. It saves itself on a
 * booking at any step (`PATCH /inquiries/:id/desk-tag`); on a new inquiry it rides on the start.
 */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Help } from "@/components/ds/help";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { setInquiryDeskTag } from "@/lib/api/inquiries";

export const DESK_TAG_MAX = 40;

/** One line, spaces folded. Mirrors the server's `cleanDeskTag` (keep the two in step). */
export function tidyDeskTag(v: string): string {
  return v.replace(/\s+/g, " ").trim();
}

/** A word typed into a name that reads as a desk note: a slash ("BOLD/MOA") or brackets ("(OTA/Expedia"). */
export function noteInName(name: string): string | null {
  const word = name.split(/\s+/).find((w) => /\//.test(w) || /^[([]/.test(w) || /[)\]]$/.test(w));
  return word ?? null;
}

/** The name without that word. */
export function nameWithoutNote(name: string, note: string): string {
  return name
    .split(/\s+/)
    .filter((w) => w !== note)
    .join(" ")
    .trim();
}

/** The tag beside a name, greyed — on the lists and the head. Nothing when there is none. */
export function DeskTagText({ tag, className }: { tag: string | null | undefined; className?: string }) {
  const t = tag?.trim();
  if (!t) return null;
  return (
    <span className={`desk-tag${className ? ` ${className}` : ""}`} title="The desk's own note — never on a paper or an email">
      {t}
    </span>
  );
}

/** The field: "Tag · only the desk sees it", with a "?" saying what it is for. */
export function DeskTagInput({
  value,
  onChange,
  onCommit,
  readOnly,
  state,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit?: (v: string) => void;
  readOnly?: boolean;
  /** "saving" / "saved" — said beside the label for a field that saves itself. */
  state?: "saving" | "saved" | null;
  autoFocus?: boolean;
}) {
  return (
    <div className="field desk-tag-field">
      <label>
        Tag
        <span className="hint-inline">{state === "saving" ? "saving…" : state === "saved" ? "saved" : "only the desk sees it"}</span>
        <Help label="About the tag">
          A short note to tell this guest apart from others of the same name — their company, group or code, like BOLD/MOA. It shows greyed beside the
          name on the desk and in the lists, and is never printed on a paper or in an email. Keep it out of the name: whatever is in the name goes on
          the papers.
        </Help>
      </label>
      <input
        className="input"
        value={value}
        readOnly={readOnly}
        autoFocus={autoFocus}
        maxLength={DESK_TAG_MAX}
        placeholder={readOnly ? undefined : "e.g. BOLD/MOA"}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => onCommit?.(tidyDeskTag(value))}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}

/**
 * The tag of a booking's enquiry, saving itself when the field is left. The value follows the record
 * unless the desk is typing in it.
 */
export function useInquiryDeskTag(inquiryId: string | null | undefined, saved: string | null | undefined, entryId?: string) {
  const { session } = useSession();
  const qc = useQueryClient();
  const [value, setValue] = useState(saved ?? "");
  const [state, setState] = useState<"saving" | "saved" | null>(null);
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) setValue(saved ?? "");
  }, [saved]);
  const commit = async (next: string) => {
    typing.current = false;
    const t = tidyDeskTag(next);
    setValue(t);
    if (!inquiryId || !session || t === (saved ?? "")) return;
    setState("saving");
    try {
      await setInquiryDeskTag(session, inquiryId, t || null);
      setState("saved");
      window.setTimeout(() => setState(null), 2000);
      if (entryId) void qc.invalidateQueries({ queryKey: ["entry", entryId] });
      void qc.invalidateQueries({ queryKey: ["entry"] });
      void qc.invalidateQueries({ queryKey: ["desk-bookings"] });
      void qc.invalidateQueries({ queryKey: ["room-chart"] });
    } catch (e) {
      setState(null);
      setValue(saved ?? "");
      toast.error(e instanceof ApiError ? e.message : "The tag was not saved");
    }
  };
  return {
    value,
    state,
    onChange: (v: string) => {
      typing.current = true;
      setValue(v);
    },
    commit,
  };
}

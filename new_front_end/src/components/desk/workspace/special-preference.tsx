"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Plus, StickyNote, X } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { updateInquiryNotes } from "@/lib/api/inquiries";
import type { EntryDetail } from "@/types/api";

/**
 * Special-preference section — pinned in the workspace's non-scrolling top bar, so it stays on
 * screen through every stage (S1…S9). Shows the currently-saved preference and lets the operator
 * add/edit it in place (never a second copy). Reads `Inquiry.notes`; saves stage-agnostically via
 * `PATCH /api/inquiries/:id/notes`. Editing the saved value in place is what prevents doubling.
 */
export function SpecialPreference({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const current = entry.inquiry?.notes?.trim() ?? "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(current);

  const save = useMutation({
    mutationFn: () => updateInquiryNotes(session!, entry.inquiryId, draft.trim()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
      void queryClient.invalidateQueries({ queryKey: ["entries"] });
      toast.success("Special preference saved.");
      setEditing(false);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't save the preference"),
  });

  const startEdit = () => {
    setDraft(current);
    setEditing(true);
  };
  const cancel = () => {
    setDraft(current);
    setEditing(false);
  };

  const wrap: React.CSSProperties = {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    padding: "7px 20px",
    borderTop: "1px solid var(--line)",
    background: "var(--warn-t)",
  };
  const label: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    color: "var(--warn)",
    marginTop: 3,
    flex: "0 0 auto",
  };

  if (editing) {
    return (
      <div style={{ ...wrap, alignItems: "stretch", flexWrap: "wrap" }}>
        <StickyNote style={{ width: 13, height: 13, color: "var(--warn)", marginTop: 3, flex: "0 0 auto" }} />
        <span style={label}>Special preference</span>
        <div style={{ flex: 1, minWidth: 240, display: "flex", flexDirection: "column", gap: 6 }}>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={2000}
            rows={2}
            placeholder="e.g. high floor, quiet room, honeymoon — allergic to nuts"
            style={{
              width: "100%",
              fontSize: 12,
              fontFamily: "inherit",
              resize: "vertical",
              padding: "5px 8px",
              borderRadius: 6,
              border: "1px solid var(--line-2)",
              background: "#fff",
              color: "var(--ink)",
            }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button
              className="btn btn-primary btn-sm"
              style={{ background: "var(--warn)" }}
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              <Check style={{ width: 13, height: 13 }} />
              {save.isPending ? "Saving…" : "Save"}
            </button>
            <button className="btn btn-ghost btn-sm" disabled={save.isPending} onClick={cancel}>
              <X style={{ width: 13, height: 13 }} />
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!current) {
    // No preference saved yet — offer a place to add one. Muted so an empty strip isn't loud.
    return (
      <div style={{ ...wrap, background: "var(--cream)" }}>
        <StickyNote style={{ width: 13, height: 13, color: "var(--ink-3)", marginTop: 2, flex: "0 0 auto" }} />
        <span style={{ ...label, color: "var(--ink-3)" }}>Special preference</span>
        <button className="btn btn-ghost btn-sm" onClick={startEdit} style={{ marginLeft: "auto" }}>
          <Plus style={{ width: 13, height: 13 }} />
          Add
        </button>
      </div>
    );
  }

  return (
    <div style={wrap} title={current}>
      <StickyNote style={{ width: 13, height: 13, color: "var(--warn)", marginTop: 2, flex: "0 0 auto" }} />
      <span style={label}>Special preference</span>
      <span
        style={{ fontSize: 12, color: "var(--ink)", lineHeight: 1.35, whiteSpace: "pre-wrap", wordBreak: "break-word", flex: 1 }}
      >
        {current}
      </span>
      <button className="btn btn-ghost btn-sm" onClick={startEdit} style={{ flex: "0 0 auto" }} title="Edit special preference">
        <Pencil style={{ width: 12, height: 12 }} />
        Edit
      </button>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  listRoomDeficiencies,
  listSpaceDeficiencies,
  reportRoomDeficiency,
  reportSpaceDeficiency,
  resolveDeficiency,
  verifyDeficiency,
  type DeficientConditionRecord,
} from "@/lib/api/rooms";

/**
 * Report / verify / resolve faults on a room or a space.
 *
 * Shared by the desk and the admin console so the two can't drift: the rules (who may verify,
 * that a rejection needs a reason, that the target leaves service the moment it is reported)
 * belong to the backend, and this only reflects them.
 *
 * STYLING: inline only, no theme classes. `admin-theme.css` is imported by the admin layout
 * alone, so `admin-input` / `admin-btn` / `admin-panel` render as nothing on `/desk/*`; the desk
 * theme's own classes are equally invisible under `/admin/*`. Inline styles are the one thing
 * both surfaces render identically, and they match the desk's existing house style.
 */

/** Mirrors the seeded `deficientCondition.categories`; the backend rejects anything deactivated. */
const CATEGORIES = [
  { code: "MAINTENANCE", label: "Maintenance" },
  { code: "CLEANLINESS", label: "Cleanliness" },
  { code: "EQUIPMENT", label: "Equipment" },
  { code: "SAFETY", label: "Safety" },
  { code: "OTHER", label: "Other" },
];

function canVerify(level?: string) {
  return level === "L2" || level === "L3" || level === "L4";
}

const S = {
  field: {
    padding: "7px 10px",
    borderRadius: 7,
    border: "1px solid rgba(128,128,128,.35)",
    background: "rgba(255,255,255,.7)",
    font: "inherit",
    fontSize: 13,
    color: "inherit",
    minWidth: 0,
  } as const,
  btn: {
    padding: "7px 13px",
    borderRadius: 7,
    border: "1px solid rgba(128,128,128,.35)",
    background: "rgba(128,128,128,.10)",
    font: "inherit",
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  } as const,
  card: {
    border: "1px solid rgba(128,128,128,.28)",
    borderRadius: 9,
    padding: "11px 13px",
    background: "rgba(128,128,128,.05)",
  } as const,
  tag: {
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: ".3px",
    borderRadius: 5,
    padding: "2px 7px",
    textTransform: "uppercase",
  } as const,
  muted: { fontSize: 11.5, opacity: 0.72, margin: 0 } as const,
};

export function DeficiencyPanel({
  target,
  targetLabel,
  onChanged,
}: {
  target: { roomId: string } | { spaceId: string };
  targetLabel: string;
  /** Refresh the caller's list — it carries the isDeficient flag this panel changes. */
  onChanged?: () => void;
}) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const isRoom = "roomId" in target;
  const targetId = isRoom ? target.roomId : target.spaceId;

  const [category, setCategory] = useState(CATEGORIES[0]!.code);
  const [description, setDescription] = useState("");
  const [rejectNotes, setRejectNotes] = useState<Record<string, string>>({});

  const queryKey = ["deficiencies", isRoom ? "room" : "space", targetId];
  const listQuery = useQuery({
    queryKey,
    queryFn: () => (isRoom ? listRoomDeficiencies(session!, targetId) : listSpaceDeficiencies(session!, targetId)),
    enabled: !!session,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey });
    onChanged?.();
  };

  const reportM = useMutation({
    mutationFn: () =>
      isRoom
        ? reportRoomDeficiency(session!, targetId, { category, description })
        : reportSpaceDeficiency(session!, targetId, { category, description }),
    onSuccess: (rec) => {
      toast.success(
        rec.verificationStatus === "VERIFIED"
          ? `${targetLabel} marked out of service`
          : `${targetLabel} out of service — awaiting supervisor verification`,
      );
      setDescription("");
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not report the fault"),
  });

  const verifyM = useMutation({
    mutationFn: (v: { id: string; accept: boolean; notes?: string }) =>
      verifyDeficiency(session!, v.id, { accept: v.accept, notes: v.notes ?? null }),
    onSuccess: (rec) => {
      toast.success(rec.verificationStatus === "VERIFIED" ? "Fault confirmed" : `Report rejected — ${targetLabel} back in service`);
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not verify"),
  });

  const resolveM = useMutation({
    mutationFn: (id: string) => resolveDeficiency(session!, id, "Fixed"),
    onSuccess: () => {
      toast.success("Fault marked fixed");
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not resolve"),
  });

  if (!session) return null;
  const items = listQuery.data?.items ?? [];
  const open = items.filter((r) => r.status !== "RESOLVED" && r.verificationStatus !== "REJECTED");
  const history = items.filter((r) => !open.includes(r));

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "grid", gap: 7 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <select style={S.field} value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c.code} value={c.code}>{c.label}</option>
            ))}
          </select>
          <input
            style={{ ...S.field, flex: 1 }}
            placeholder={`What's wrong with ${targetLabel.toLowerCase()}?`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && description.trim() && !reportM.isPending) reportM.mutate(); }}
          />
          <button
            type="button"
            style={{ ...S.btn, background: "var(--stop, #b3261e)", color: "#fff", borderColor: "transparent", opacity: reportM.isPending || !description.trim() ? 0.5 : 1 }}
            disabled={reportM.isPending || !description.trim()}
            onClick={() => reportM.mutate()}
          >
            {reportM.isPending ? "Reporting…" : "Report fault"}
          </button>
        </div>
        <p style={S.muted}>
          {canVerify(session.actorLevel) ? (
            <>{targetLabel} goes out of service immediately. Your report is confirmed on the spot.</>
          ) : (
            <>
              {targetLabel} goes out of service <b>immediately</b> — it stops being bookable the moment you
              report it. A supervisor (L2 or above) will then verify your report and either confirm it or,
              if it turns out to be nothing, put {targetLabel.toLowerCase()} back into service.
            </>
          )}
        </p>
      </div>

      {listQuery.isLoading && <p style={S.muted}>Loading faults…</p>}

      {open.map((r: DeficientConditionRecord) => (
        <div key={r.id} style={S.card}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ ...S.tag, background: "rgba(128,128,128,.18)" }}>{r.category}</span>
            {r.verificationStatus === "PENDING_VERIFICATION" ? (
              <span style={{ ...S.tag, background: "rgba(214,158,46,.20)", color: "#8a6d1d" }}>awaiting verification</span>
            ) : (
              <span style={{ ...S.tag, background: "rgba(46,160,90,.18)", color: "#1c7a43" }}>verified</span>
            )}
            <span style={S.muted}>{new Date(r.detectedAt).toLocaleString()}</span>
          </div>
          <p style={{ margin: "0 0 9px", fontSize: 13 }}>{r.description}</p>

          {r.verificationStatus === "PENDING_VERIFICATION" && canVerify(session.actorLevel) && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, alignItems: "center", padding: "9px 0", borderTop: "1px dashed rgba(128,128,128,.3)" }}>
              <button
                type="button"
                style={{ ...S.btn, background: "var(--green, #1c7a43)", color: "#fff", borderColor: "transparent" }}
                disabled={verifyM.isPending}
                onClick={() => verifyM.mutate({ id: r.id, accept: true })}
              >
                Confirm fault
              </button>
              <input
                style={{ ...S.field, flex: 1, fontSize: 12 }}
                placeholder="Reason (required to reject)"
                value={rejectNotes[r.id] ?? ""}
                onChange={(e) => setRejectNotes({ ...rejectNotes, [r.id]: e.target.value })}
              />
              <button
                type="button"
                style={{ ...S.btn, opacity: verifyM.isPending || !(rejectNotes[r.id] ?? "").trim() ? 0.5 : 1 }}
                disabled={verifyM.isPending || !(rejectNotes[r.id] ?? "").trim()}
                onClick={() => verifyM.mutate({ id: r.id, accept: false, notes: rejectNotes[r.id] })}
              >
                Reject
              </button>
            </div>
          )}

          <button type="button" style={S.btn} disabled={resolveM.isPending} onClick={() => resolveM.mutate(r.id)}>
            Mark fixed
          </button>
        </div>
      ))}

      {open.length === 0 && !listQuery.isLoading && <p style={S.muted}>No open faults on {targetLabel.toLowerCase()}.</p>}

      {history.length > 0 && (
        <details>
          <summary style={{ ...S.muted, cursor: "pointer" }}>Past reports ({history.length})</summary>
          <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
            {history.map((r) => (
              <div key={r.id} style={S.muted}>
                {new Date(r.detectedAt).toLocaleDateString()} · {r.category} · {r.description} ·{" "}
                {r.verificationStatus === "REJECTED" ? `rejected (${r.verificationNotes ?? "no reason given"})` : "resolved"}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

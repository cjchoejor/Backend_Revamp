"use client";

/**
 * Swap two guests' rows, from the booking file's Guests tab (2026-11-25, operator: "the user accidentally
 * uploaded and posted the adult to the child section and child to adult section — in this guests tab,
 * keep a swap guest feature among the rooms").
 *
 * The box names the guest being moved and lists every other row of the party, by room, with who is on
 * it. Each row says — from the server's own check (`POST …/identity-details/swap` with `dryRun`) — how
 * both people would fit their new rows, so the row that puts things right reads "both fit". One press
 * swaps everything recorded on the two rows: the details, the ID photos, the confirmation. Nothing is
 * typed again.
 */
import { useMemo, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { swapGuestRows, type GuestRowSwapOutcome } from "@/lib/api/identity-proofs";
import { DsDialog } from "@/components/ds/steps/kit";

export type SwapCandidate = {
  key: string;
  /** "Adult 5", "Child 1 (5y)" */
  row: string;
  /** The name on the row, or null. */
  person: string | null;
  /** "Room 504 · Premium Suite" or null. */
  where: string | null;
  /** "born 19/05/2022 · 4 at check-in" or null. */
  born: string | null;
  holdsSomeone: boolean;
};

function fitWords(f: GuestRowSwapOutcome["a"]["fitsAfter"]): { tone: "ok" | "warn" | "stop" | null; words: string } {
  if (!f) return { tone: null, words: "no date of birth to check" };
  if (f.ok) return { tone: "ok", words: "fits" };
  return { tone: f.blocks ? "stop" : "warn", words: f.blocks ? "does not fit" : "a year off — a warning" };
}

export function SwapGuestsDialog({
  entryId,
  from,
  others,
  open,
  onClose,
}: {
  entryId: string;
  from: SwapCandidate;
  others: SwapCandidate[];
  open: boolean;
  onClose: () => void;
}) {
  const { session } = useSession();
  const qc = useQueryClient();
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The server's check for every row at once (a party is small), so the row that puts it right shows.
  const shown = others.slice(0, 40);
  const previews = useQueries({
    queries: shown.map((o) => ({
      queryKey: ["guest-swap-preview", entryId, from.key, o.key],
      queryFn: () => swapGuestRows(session!, entryId, { a: from.key, b: o.key, dryRun: true }),
      enabled: open && !!session,
      staleTime: 0,
    })),
  });
  const byKey = useMemo(() => new Map(shown.map((o, i) => [o.key, previews[i]?.data ?? null])), [shown, previews]);
  const chosen = pick ? (byKey.get(pick) ?? null) : null;
  const other = pick ? others.find((o) => o.key === pick) ?? null : null;
  const fromName = from.person ?? from.row;

  const run = async () => {
    if (!session || !pick || !other) return;
    setBusy(true);
    try {
      const out = await swapGuestRows(session, entryId, { a: from.key, b: pick });
      void qc.invalidateQueries({ queryKey: ["identity-proofs", entryId] });
      void qc.invalidateQueries({ queryKey: ["entry", entryId] });
      void qc.invalidateQueries({ queryKey: ["guest-swap-preview", entryId] });
      void qc.invalidateQueries({ queryKey: ["entry-trace", entryId] });
      const a = `${out.a.person ?? "the guest"} is now on ${out.b.row}`;
      const b = out.b.holdsSomeone ? `${out.b.person ?? "the other guest"} on ${out.a.row}` : `${out.a.row} is empty`;
      toast.success(`Swapped — ${a}; ${b}.`, {
        description: out.verificationReset ? "The lead moved with them: record the identity check again before check-in." : undefined,
      });
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The guests were not swapped");
    } finally {
      setBusy(false);
    }
  };

  return (
    <DsDialog
      open={open}
      onClose={onClose}
      closeX
      width={560}
      title={`Swap ${fromName}'s row`}
      help="Everything recorded on the two rows changes places — the typed details, the ID photos and whether they were confirmed. Nothing is typed again. Use it when a guest's details went on another guest's row."
      caseLines={[`${fromName} · ${from.row}${from.where ? ` · ${from.where}` : ""}${from.born ? ` · ${from.born}` : ""}`]}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            kind="primary"
            className={pick && !chosen?.refusal ? "go" : undefined}
            state={busy ? "working" : pick && chosen && !chosen.refusal ? "default" : "inert"}
            reason={!pick ? "Pick the row to swap with" : chosen?.refusal ?? (!chosen ? "Checking…" : undefined)}
            workingLabel="Swapping…"
            onClick={() => void run()}
          >
            Swap them
          </Button>
        </>
      }
    >
      <p className="sm" style={{ margin: "0 0 8px" }}>
        Swap with:
      </p>
      <div className="swap-list" role="radiogroup" aria-label="The row to swap with">
        {shown.map((o) => {
          const p = byKey.get(o.key);
          const mine = p ? fitWords(p.a.fitsAfter) : null;
          const theirs = p && o.holdsSomeone ? fitWords(p.b.fitsAfter) : null;
          const both = !!p && !p.refusal && mine?.tone === "ok" && (!o.holdsSomeone || theirs?.tone === "ok" || theirs?.tone === null);
          return (
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={pick === o.key}
              className={`swap-row${pick === o.key ? " on" : ""}${both ? " fits" : ""}`}
              onClick={() => setPick(o.key)}
            >
              <span className="swap-radio" aria-hidden />
              <span className="swap-who">
                <b>{o.person ?? (o.holdsSomeone ? "Someone, no name typed" : "Nobody recorded")}</b>
                <span className="meta">
                  {o.row}
                  {o.where ? ` · ${o.where}` : ""}
                  {o.born ? ` · ${o.born}` : ""}
                </span>
              </span>
              <span className="swap-fit">
                {!p ? (
                  <span className="meta">checking…</span>
                ) : p.refusal ? (
                  <span className="stop-ink">{p.refusal}</span>
                ) : both ? (
                  <span className="ok-ink">✓ both fit their new rows</span>
                ) : (
                  <>
                    <span className={mine?.tone === "stop" ? "stop-ink" : mine?.tone === "warn" ? "warn-ink" : "meta"}>
                      {fromName}: {mine?.words}
                    </span>
                    {o.holdsSomeone && theirs ? (
                      <span className={theirs.tone === "stop" ? "stop-ink" : theirs.tone === "warn" ? "warn-ink" : "meta"}>
                        {o.person ?? "they"}: {theirs.words}
                      </span>
                    ) : null}
                  </>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {chosen && other && !chosen.refusal ? (
        <div className="swap-after" role="status">
          <b>After the swap</b>
          <span>
            {fromName} → {other.row}
            {other.where ? ` · ${other.where}` : ""}
          </span>
          {other.holdsSomeone ? (
            <span>
              {other.person ?? "the other guest"} → {from.row}
              {from.where ? ` · ${from.where}` : ""}
            </span>
          ) : (
            <span className="meta">{from.row} is left with nobody recorded</span>
          )}
          {chosen.leadMovesTo ? <span className="meta">The Lead mark moves with the guest it is on.</span> : null}
          {[chosen.a.fitsAfter, chosen.b.fitsAfter].map((f, i) =>
            f && !f.ok && f.message ? (
              <span key={i} className={f.blocks ? "stop-ink" : "warn-ink"}>
                {f.message}
              </span>
            ) : null,
          )}
        </div>
      ) : null}
    </DsDialog>
  );
}

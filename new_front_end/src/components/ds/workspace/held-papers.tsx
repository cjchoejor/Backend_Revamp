"use client";

/**
 * PAPERS WAITING FOR THE DESK (2026-10-12, operator ruling: "after switching, give the option to
 * send or not" — and no paper goes to a guest unless the desk chooses).
 *
 * Every room-change walk (a room change, a stay extension, a setup change, a seating repair, a
 * re-price, a room move from the house chart) re-issues the booking's voucher — or at Set up, its
 * proforma — and HOLDS it. This card lists what is still held and asks once, per paper: send it
 * by email, mark it sent on WhatsApp, or don't send it. The answer is recorded on the booking.
 *
 * Shown above every step of the booking (so whichever walk ran, the question is on screen), on the
 * Documents tab, and in the room move's result. Nothing is decided here — the server sends.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { Help } from "@/components/ds/help";
import { Choice as PickOne, NightsChoice, PaperDrawer, toastRefusal, type PaperRef } from "@/components/ds/steps/kit";
import { useSession } from "@/hooks/use-session";
import { decideHeldDocument, listHeldDocuments, type HeldDocument } from "@/lib/api/room-moves";
import { fmtDateTime } from "@/lib/ds/format";

const KIND_WORD: Record<HeldDocument["kind"], string> = {
  CONFIRMATION_VOUCHER: "Confirmation voucher",
  PROFORMA: "Proforma invoice",
};
const REASON_WORD: Record<string, string> = {
  ROOM_CHANGE: "after the room change",
  STAY_EXTENSION: "after the stay was extended",
  SETUP_CHANGE: "after the setup change",
  SEATING_REPAIR: "after the guests were seated again",
  REPRICE: "after the re-price",
  ROOM_MOVE: "after the room switch",
  DATE_MOVE: "after the dates were moved",
  ROOM_SPLIT: "after the rooms were split off",
  RESERVE: "made at Reserve",
  RECONFIGURE: "after the stay was changed",
  NEW_PASS: "made again for the change",
};

export function useHeldDocuments(entryId: string | null | undefined) {
  const { session } = useSession();
  return useQuery({
    queryKey: ["held-documents", entryId],
    queryFn: () => listHeldDocuments(session!, entryId!),
    enabled: !!session && !!entryId,
    staleTime: 15_000,
  });
}

function paperOf(h: HeldDocument): PaperRef {
  return h.kind === "PROFORMA"
    ? { kind: "invoice", id: h.documentId, invoiceType: "PROFORMA", label: `Proforma invoice ${h.documentNumber ?? h.documentId}` }
    : { kind: "voucher", reservationId: h.documentId, label: `Confirmation voucher ${h.documentNumber ?? h.documentId}` };
}

type Choice = "EMAIL" | "WHATSAPP" | "NONE";

export function HeldPaperRow({ h, tz, onView }: { h: HeldDocument; tz?: string; onView: () => void }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const [choice, setChoice] = useState<Choice>(h.defaultRecipient.to ? "EMAIL" : h.kind === "PROFORMA" ? "EMAIL" : "WHATSAPP");
  const [to, setTo] = useState(h.defaultRecipient.to ?? "");
  const [note, setNote] = useState("");
  // Every night named on the copy emailed (2026-10-30).
  const [nightsEach, setNightsEach] = useState(false);
  const decide = useMutation({
    mutationFn: () =>
      decideHeldDocument(session!, h.id, {
        action: choice,
        sentTo: choice === "NONE" ? null : to.trim() || null,
        note: note.trim() || null,
        nightsEach: choice === "EMAIL" && nightsEach,
      }),
    onSuccess: (r) => {
      toast.success(
        choice === "EMAIL"
          ? `${KIND_WORD[h.kind]} sent by email${r.sentTo ? ` to ${r.sentTo}` : ""}`
          : choice === "WHATSAPP"
            ? `${KIND_WORD[h.kind]} recorded as sent on WhatsApp`
            : `${KIND_WORD[h.kind]} not sent — recorded`,
      );
      for (const k of [["held-documents", h.entryId], ["entry-communications", h.entryId], ["entry-trace", h.entryId], ["entry", h.entryId]]) {
        void qc.invalidateQueries({ queryKey: k });
      }
    },
    onError: (e) => toastRefusal(e, "The answer could not be recorded"),
  });
  const emailMissing = choice === "EMAIL" && !to.trim();
  const blocked = emailMissing ? "Type the address it goes to" : null;
  return (
    <div className="heldp-row">
      <div className="heldp-what">
        <b>{KIND_WORD[h.kind]}</b>
        <span className="mono sm">{h.documentNumber ?? h.documentId}</span>
        <span className="sm muted">
          {REASON_WORD[h.reason] ?? "held"} · {fmtDateTime(h.heldAt, tz)}
        </span>
        <Button kind="quiet" compact onClick={onView}>
          View
        </Button>
      </div>
      {/* Choice buttons, as every pick-one on the desk (2026-10-29). */}
      <div aria-label={`What to do with the ${KIND_WORD[h.kind].toLowerCase()}`}>
        <PickOne<Choice>
          options={[
            ["EMAIL", "Send by email"],
            ...(h.kind === "CONFIRMATION_VOUCHER" ? ([["WHATSAPP", "Sent on WhatsApp"]] as const) : []),
            ["NONE", "Don't send"],
          ]}
          value={choice}
          onChange={setChoice}
        />
      </div>
      <div className="heldp-fields">
        {choice === "EMAIL" ? (
          <label className="field">
            <span>Send to{h.defaultRecipient.whose ? <span className="muted"> · {h.defaultRecipient.whose}</span> : null}</span>
            <input className="input" type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com" />
          </label>
        ) : null}
        {choice === "EMAIL" ? (
          <div className="paper-faces in-dialog">
            <NightsChoice each={nightsEach} onChange={setNightsEach} />
          </div>
        ) : null}
        {choice === "WHATSAPP" ? (
          <label className="field">
            <span>Number it went to · optional</span>
            <input className="input" value={to} onChange={(e) => setTo(e.target.value)} placeholder="+975…" />
          </label>
        ) : null}
        <label className="field">
          <span>{choice === "NONE" ? "Why not · optional" : "Note · optional"}</span>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <Button
          kind={choice === "NONE" ? "secondary" : "primary"}
          className={choice === "NONE" ? undefined : "go"}
          compact
          state={blocked || decide.isPending ? "inert" : "default"}
          onClick={() => !blocked && decide.mutate()}
        >
          {decide.isPending ? "Recording…" : choice === "EMAIL" ? "Send it" : choice === "WHATSAPP" ? "Record it as sent" : "Don't send it"}
        </Button>
        {blocked ? <span className="stop-ink sm">{blocked}</span> : null}
      </div>
    </div>
  );
}

/**
 * The booking's undecided held papers. `onlyIds` narrows to the papers one act produced (a room
 * move's result); renders nothing when there is nothing to answer.
 */
export function HeldPapersCard({
  entryId,
  onlyIds,
  tz,
  title,
  skip,
}: {
  entryId: string;
  onlyIds?: string[];
  tz?: string;
  title?: string;
  /** Papers answered somewhere else on the screen — Reserve's voucher is answered on its own card (2026-10-29). */
  skip?: (h: HeldDocument) => boolean;
}) {
  const q = useHeldDocuments(entryId);
  const [paper, setPaper] = useState<PaperRef | null>(null);
  const open = (q.data ?? []).filter((h) => h.decision == null && (!onlyIds || onlyIds.includes(h.id)) && !skip?.(h));
  if (open.length === 0) return null;
  return (
    <section className="heldp" aria-label="Papers waiting to be sent or not">
      <div className="heldp-head">
        <b>{title ?? (open.length === 1 ? "A paper is waiting — send it or not" : `${open.length} papers are waiting — send them or not`)}</b>
        <Help label="Why is this held?">
          <p>A change to the booking re-issued this paper. Nothing goes to the guest until you choose.</p>
          <p>Send it by email, record that you shared it on WhatsApp, or record that it was not sent. A bill is sent by email only.</p>
        </Help>
      </div>
      {open.map((h) => (
        <HeldPaperRow key={h.id} h={h} tz={tz} onView={() => setPaper(paperOf(h))} />
      ))}
      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
    </section>
  );
}

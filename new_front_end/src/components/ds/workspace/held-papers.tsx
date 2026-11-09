"use client";

/**
 * PAPERS WAITING FOR THE DESK (2026-10-12, operator ruling: "after switching, give the option to
 * send or not" — and no paper goes to a guest unless the desk chooses).
 *
 * Every room-change walk (a room change, a stay extension, a setup change, a seating repair, a
 * re-price, a room move from the house chart) re-issues the booking's voucher — or at Set up, its
 * proforma — and HOLDS it. This card lists what has not gone out: send it by email or mark it sent
 * on WhatsApp. A paper that is not to be sent is simply left (2026-11-09, operator: "if you dont send
 * it anyway why would you need that button").
 *
 * A paper not sent lives in the booking file, Papers › Sent & answers (2026-11-09, operator: the box
 * above the step "doesn't have to show here"), and Reserve's voucher section and a move's result still
 * ask it where the desk is working. Nothing is decided here — the server sends.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { Help } from "@/components/ds/help";
import { Choice as PickOne, DsDialog, NightsChoice, NotSentChip, PaperDrawer, SendPaperPanel, toastRefusal, type PaperRef } from "@/components/ds/steps/kit";
import { useSession } from "@/hooks/use-session";
import { usePhoneRules } from "@/hooks/use-phone-rules";
import { problemOfPhone } from "@/lib/ds/phone";
import { PhoneField } from "@/components/ds/phone-field";
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

type Choice = "EMAIL" | "WHATSAPP";

export function HeldPaperRow({
  h,
  tz,
  onView,
  onDone,
  onNightsEach,
}: {
  h: HeldDocument;
  tz?: string;
  onView: () => void;
  /** It has gone out. */
  onDone?: () => void;
  /** The Nights choice, for a paper shown beside this form. */
  onNightsEach?: (each: boolean) => void;
}) {
  const { session } = useSession();
  const phoneRules = usePhoneRules();
  const qc = useQueryClient();
  const rec = h.defaultRecipient;
  const [choice, setChoice] = useState<Choice>(rec.to || h.kind === "PROFORMA" || !rec.phone ? "EMAIL" : "WHATSAPP");
  // The email and the number are kept apart, each starting at whom the paper goes to by default
  // (2026-11-07): the contact person at the agency or company, else the party; on a direct booking
  // the guest. Switching between them never carries one into the other's box.
  const [email, setEmail] = useState(rec.to ?? "");
  const [phone, setPhone] = useState(rec.phone ?? "");
  const to = choice === "WHATSAPP" ? phone : email;
  const [note, setNote] = useState("");
  // Every night named on the copy emailed (2026-10-30).
  const [nightsEach, setNightsEach] = useState(false);
  const decide = useMutation({
    mutationFn: () =>
      decideHeldDocument(session!, h.id, {
        action: choice,
        sentTo: to.trim() || null,
        note: note.trim() || null,
        nightsEach: choice === "EMAIL" && nightsEach,
      }),
    onSuccess: (r) => {
      toast.success(
        choice === "EMAIL" ? `${KIND_WORD[h.kind]} sent by email${r.sentTo ? ` to ${r.sentTo}` : ""}` : `${KIND_WORD[h.kind]} recorded as sent on WhatsApp`,
      );
      for (const k of [["held-documents", h.entryId], ["entry-communications", h.entryId], ["entry-trace", h.entryId], ["entry", h.entryId]]) {
        void qc.invalidateQueries({ queryKey: k });
      }
      onDone?.();
    },
    onError: (e) => toastRefusal(e, "The answer could not be recorded"),
  });
  const emailMissing = choice === "EMAIL" && !to.trim();
  const numberBad = choice === "WHATSAPP" ? problemOfPhone(phoneRules, to) : null;
  const blocked = emailMissing ? "Type the address it goes to" : numberBad;
  return (
    <div className="heldp-row">
      <div className="heldp-what">
        <b>{KIND_WORD[h.kind]}</b>
        <span className="mono sm">{h.documentNumber ?? h.documentId}</span>
        <NotSentChip />
        <span className="sm muted">
          {REASON_WORD[h.reason] ?? "held"} · {fmtDateTime(h.heldAt, tz)}
        </span>
        {/* The paper is read before it is sent, so View is a real button (2026-11-07, operator: "the view button to be prominent"). */}
        <Button kind="secondary" compact icon="eye" className="heldp-view" onClick={onView}>
          View
        </Button>
      </div>
      {h.kind === "CONFIRMATION_VOUCHER" ? (
        <div aria-label={`How the ${KIND_WORD[h.kind].toLowerCase()} goes out`}>
          <PickOne<Choice>
            options={[
              ["EMAIL", "Send by email"],
              ["WHATSAPP", "Sent on WhatsApp"],
            ]}
            value={choice}
            onChange={setChoice}
          />
        </div>
      ) : null}
      <div className="heldp-fields">
        {choice === "EMAIL" ? (
          <label className="field">
            <span>Send to{rec.whose && email.trim() === rec.to ? <span className="muted"> · {rec.whose}</span> : null}</span>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
          </label>
        ) : null}
        {choice === "EMAIL" ? (
          <div className="paper-faces in-dialog">
            <NightsChoice
              each={nightsEach}
              onChange={(each) => {
                setNightsEach(each);
                onNightsEach?.(each);
              }}
              of={{ entryId: h.entryId }}
            />
          </div>
        ) : null}
        {choice === "WHATSAPP" ? (
          <label className="field">
            <span>Number it went to · optional{rec.phoneWhose && phone.trim() === rec.phone ? <span className="muted"> · {rec.phoneWhose}</span> : null}</span>
            <PhoneField value={phone} onChange={setPhone} ariaLabel="Number it went to" />
          </label>
        ) : null}
        <label className="field">
          <span>Note · optional</span>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <Button
          kind="primary"
          className="go"
          compact
          state={blocked || decide.isPending ? "inert" : "default"}
          onClick={() => !blocked && decide.mutate()}
        >
          {decide.isPending ? "Recording…" : choice === "EMAIL" ? "Send it" : "Record it as sent"}
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
}: {
  entryId: string;
  onlyIds?: string[];
  tz?: string;
  title?: string;
}) {
  const q = useHeldDocuments(entryId);
  const [paper, setPaper] = useState<PaperRef | null>(null);
  const open = (q.data ?? []).filter((h) => h.decision == null && (!onlyIds || onlyIds.includes(h.id)));
  if (open.length === 0) return null;
  return (
    <section className="heldp" aria-label="Papers not sent yet">
      <div className="heldp-head">
        <b>{title ?? (open.length === 1 ? "A paper has not been sent" : `${open.length} papers have not been sent`)}</b>
        <Help label="Why is this held?">
          <p>A change to the booking made this paper again. Nothing goes to the guest until you send it, and it can simply be left if it does not need to go.</p>
          <p>Send it by email, or record that you shared it on WhatsApp. A bill is sent by email only.</p>
        </Help>
      </div>
      {open.map((h) => (
        <HeldPaperRow key={h.id} h={h} tz={tz} onView={() => setPaper(paperOf(h))} />
      ))}
      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
    </section>
  );
}

/** Sending a paper not sent yet, from Papers › Sent & answers: the choices, with the paper beside them. */
export function HeldSendDialog({ h, tz, onClose }: { h: HeldDocument; tz?: string; onClose: () => void }) {
  const [paper, setPaper] = useState<PaperRef | null>(null);
  const [nightsEach, setNightsEach] = useState(false);
  return (
    <>
      <DsDialog
        open
        closeX
        onClose={onClose}
        title={`Send the ${KIND_WORD[h.kind].toLowerCase()}`}
        beside={<SendPaperPanel paper={paperOf(h)} nightsEach={nightsEach} />}
        footer={
          <Button kind="quiet" onClick={onClose}>
            Not now
          </Button>
        }
      >
        <HeldPaperRow h={h} tz={tz} onView={() => setPaper(paperOf(h))} onDone={onClose} onNightsEach={setNightsEach} />
      </DsDialog>
      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
    </>
  );
}

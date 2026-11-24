"use client";

/**
 * "Is this the same booking entered twice?" (2026-11-24, operator: "say there is a booking made by a
 * travel agent named Bhutan INC for guest name Dorji … now another user does the same kind of booking
 * … somewhere in the stages it tells the user to acknowledge that it isn't a mistake").
 *
 * The question is the server's (Policy 12's flag, raised at Wrap up when the guest named here already
 * has a booking on these nights — the same guest record, or the same name through the same agency or
 * company). It holds the move on until answered:
 *  - Both are meant — a second booking; recorded in the desk's name, and the booking moves on.
 *  - Entered twice — this booking is the copy; Cancel inquiry (or Cancel booking) ends it.
 * Reserve asks the FOM again, as it always has for the same guest.
 */
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system/components/primitives";
import { useSession } from "@/hooks/use-session";
import { answerBothMeant, getDuplicateCheck, type DuplicateQuestion } from "@/lib/api/guest-bookings";
import { openDuplicateQuestions } from "@/lib/desk/workspace";
import { StayDates } from "@/components/ds/stay-dates";
import type { EntryDetail } from "@/types/api";
import { toastRefusal, useOpenAlsoWay, useRefreshEntry } from "./kit";

function otherWords(q: DuplicateQuestion): string {
  const o = q.other;
  if (!o) return "Another booking was found for this guest on these nights.";
  return o.why === "SAME_NAME" && o.partyName
    ? `${o.partyName} already has a booking for ${o.guestName || "a guest of the same name"} on these nights.`
    : `${o.guestName || "This guest"} already has a booking on these nights.`;
}

export function DuplicateQuestions({ entry, editable, cancelWord }: { entry: EntryDetail; editable: boolean; cancelWord: string }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const openWay = useOpenAlsoWay();
  const open = openDuplicateQuestions(entry);
  const q = useQuery({
    queryKey: ["duplicate-check", entry.id, entry.updatedAt, open],
    queryFn: () => getDuplicateCheck(session!, entry.id),
    enabled: !!session && open > 0,
    staleTime: 10_000,
  });
  const [note, setNote] = useState("");
  const answer = useMutation({
    mutationFn: (flagId: string) => answerBothMeant(session!, entry.id, flagId, note.trim() || null),
    onSuccess: () => {
      toast.success("Recorded: both bookings are meant");
      setNote("");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The answer could not be recorded"),
  });
  if (!open) return null;
  const questions = q.data?.questions ?? [];
  if (!questions.length) return null;
  return (
    <>
      {questions.map((dq) => (
        <div key={dq.flagId} className="notice dup-q" role="alert" data-duplicate-question>
          <span className="dup-mark" aria-hidden>
            !
          </span>
          <div className="dup-body">
            <b>The same booking twice?</b>
            <p>{otherWords(dq)}</p>
            {dq.other ? (
              <div className="dup-other">
                <Link href={`/bookings/${dq.other.entryId}`} className="dup-link">
                  {dq.other.entryId}
                </Link>
                <StayDates checkIn={dq.other.checkInDate} checkOut={dq.other.checkOutDate} compact />
                <span className="sm">
                  at {dq.other.stageWord}
                  {dq.other.parked ? " · parked" : ""}
                </span>
              </div>
            ) : null}
            {editable ? (
              <>
                <label className="dup-note">
                  <span className="sm">Note (optional)</span>
                  <input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. two guests named Dorji, both travelling" />
                </label>
                <div className="dup-acts">
                  <Button
                    className="go"
                    state={answer.isPending ? "working" : "default"}
                    workingLabel="Recording…"
                    onClick={() => answer.mutate(dq.flagId)}
                  >
                    Both are meant
                  </Button>
                  <Button kind="secondary" className="dup-cancel" onClick={() => openWay("decline")}>
                    Entered twice — {cancelWord}
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ))}
    </>
  );
}

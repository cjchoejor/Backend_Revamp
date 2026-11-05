"use client";

/**
 * An advance paid before this booking was sent back (2026-11-05, operator: "it generated a new
 * proforma, and it has no record of the advance paid before. maybe it can prompt the user, there was
 * an advance paid before, should be incorporate it to this new proforma or refund the previous one").
 *
 * Asked once on arriving at Set up, in the middle of the screen. Closing it decides nothing: the
 * question stands on the page, and the proforma cannot go out and Reserve cannot go ahead until it is
 * answered. The backend says when it is asked and holds both gates; this only draws it.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { answerEarlierAdvance } from "@/lib/api/refunds";
import { fmtDateTime, money } from "@/lib/ds/format";
import type { EntryDetail, PaymentStatusSummary } from "@/types/api";
import { RefundCoin, REFUND_METHOD_WORD } from "../refund-bits";
import { DsDialog, PaperDrawer, toastRefusal, type PaperRef } from "./kit";

export function EarlierAdvanceQuestion({
  entry,
  status,
  tz,
  onChanged,
}: {
  entry: EntryDetail;
  status: PaymentStatusSummary | undefined;
  tz: string;
  onChanged: () => void;
}) {
  const { session } = useSession();
  const asked = status?.earlierAdvance?.asked ? status.earlierAdvance : null;
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [paper, setPaper] = useState<PaperRef | null>(null);
  // It opens once by itself, on arriving; after that the line on the page opens it.
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (asked && openedFor.current !== entry.id) {
      openedFor.current = entry.id;
      setOpen(true);
    }
  }, [asked, entry.id]);

  const answer = useMutation({
    mutationFn: (a: "CARRY" | "REFUND") => answerEarlierAdvance(session!, entry.id, { answer: a, note: note.trim() || undefined }),
    onSuccess: (out) => {
      setOpen(false);
      if (out.answer === "CARRY") {
        toast.success(`${money(out.amount)} goes on this proforma`, {
          description:
            out.requiredAmount > 0
              ? out.shortfall > 0
                ? `The advance asked is now ${money(out.requiredAmount)}, so ${money(out.shortfall)} is still to come.`
                : `The advance asked is now ${money(out.requiredAmount)}, and it is covered.`
              : "No further advance is asked.",
          duration: 9000,
        });
      } else {
        toast.success(`${money(out.amount)} is waiting to be refunded`, {
          description: `The FOM, GM and admin have been told · ${out.refundRequestId}`,
          duration: 9000,
        });
      }
      onChanged();
    },
    onError: (e) => toastRefusal(e, "That could not be saved"),
  });

  if (!asked) return null;
  const words = `${money(asked.amount)} was paid before this booking was sent back`;
  const paidOn = asked.paidOn;
  return (
    <>
      <div className="notice next" role="status" data-earlier-advance>
        <RefundCoin />
        <span>
          <b>{words}.</b> Say whether it goes on the new proforma or is refunded. The proforma cannot go out until then.
        </span>
        <Button className="go" compact onClick={() => setOpen(true)}>
          Answer it
        </Button>
      </div>
      <DsDialog
        open={open}
        closeX
        onClose={() => setOpen(false)}
        busy={answer.isPending}
        title="An advance was paid before"
        caseLines={[`${money(asked.amount)} · the booking has since gone back and been priced again`]}
        help="Closing this decides nothing. The question stays on the page, and the proforma and Reserve wait for the answer."
        footer={
          <>
            <Button kind="secondary" state={answer.isPending ? "inert" : "default"} onClick={() => answer.mutate("REFUND")}>
              Refund it
            </Button>
            <Button className="go" state={answer.isPending ? "inert" : "default"} onClick={() => answer.mutate("CARRY")}>
              Put it on the new proforma
            </Button>
          </>
        }
      >
        <div className="earlier-pay">
          {asked.payments.map((p) => (
            <div key={p.id} className="earlier-pay-row">
              <b className="money">{money(p.amount)}</b>
              <span className="sm">
                {p.method ? `${REFUND_METHOD_WORD[p.method] ?? p.method} · ` : ""}
                {fmtDateTime(p.receivedAt, tz)}
                {p.notes ? ` · ${p.notes}` : ""}
              </span>
            </div>
          ))}
          {paidOn ? (
            <div className="earlier-pay-paper sm">
              Paid on proforma {paidOn.number}
              {paidOn.version > 1 ? ` · v${paidOn.version}` : ""}
              <Button
                kind="quiet"
                compact
                icon="file"
                onClick={() => setPaper({ kind: "invoice", id: paidOn.id, invoiceType: "PROFORMA", frozen: paidOn.stored, label: `Proforma ${paidOn.number}` })}
              >
                View
              </Button>
            </div>
          ) : null}
        </div>
        <p className="sm" style={{ margin: "10px 0 4px" }}>
          <b>Put it on the new proforma:</b> it counts as received, and what was asked of the guest is worked out again on the new price.
        </p>
        <p className="sm" style={{ margin: "0 0 10px" }}>
          <b>Refund it:</b> the FOM, GM and admin are told, and it stops counting on this booking. They record the money going back.
        </p>
        <div className="field">
          <label>A note for the FOM · optional</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="what the guest said" />
        </div>
      </DsDialog>
      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
    </>
  );
}

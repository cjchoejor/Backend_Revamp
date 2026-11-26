"use client";

/**
 * "Waiting for your answer" (2026-11-26, operator, after a FOM opened a booking from the bell and found
 * nothing to act on: "as a user the fom can't see anything she has to work with when she comes into
 * the page, we need something prominent for such cases").
 *
 * The first thing in the booking's work column, for the FOM, the GM and an admin, whenever the desk
 * waits for their answer on this booking — at whatever step is on screen:
 *   - a charge to correct on a settled bill: answered right here (Correct it · Turn it down);
 *   - the guest to leave owing at Check-out, the rest of the bill paid later at Check-in, a change
 *     prepared at Negotiation: **Answer it** takes them to the card that holds the answer, which
 *     lights for a moment.
 * What waits is read off the desk list, which the bell reads again the moment something new waits.
 */
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import type { DeskListRow } from "@/lib/api/desk";
import { fmtDateTime, money } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { atLeast } from "../steps/kit";
import { ChargeCorrectionAsks, useChargeCorrections } from "../steps/charge-correction-asks";

type Go = { step: number; card: string };
type Ask = { key: string; title: string; detail: string | null; at: string; go: Go };

function asksOf(row: DeskListRow | null, entry: EntryDetail): Ask[] {
  if (!row) return [];
  const out: Ask[] = [];
  const stepNow = Number(entry.currentStage?.replace("S", "")) || 0;
  for (const o of row.leaveOwingRequests ?? []) {
    out.push({
      key: `owing:${o.id}`,
      title: "The desk asks to let the guest leave owing",
      detail: `${money(o.amountOwed)} owed · “${o.guestWords}”`,
      at: o.requestedAt,
      go: { step: 8, card: "settle" },
    });
  }
  for (const d of row.checkInPaymentDeferrals ?? []) {
    if (d.status !== "REQUESTED") continue;
    out.push({
      key: `later:${d.id}`,
      title: "The desk asks to let the guest pay the rest of the bill later",
      detail: `${money(d.stillToPay)} still to pay`,
      at: d.requestedAt,
      go: { step: stepNow === 5 ? 5 : 6, card: "advance" },
    });
  }
  for (const a of row.negotiationAmendmentRequests ?? []) {
    out.push({
      key: `change:${a.id}`,
      title: "A change to the booking waits for your approval",
      detail: a.summary,
      at: a.requestedAt,
      go: { step: 2, card: "table" },
    });
  }
  return out;
}

export function WaitingForYourAnswer({
  entry,
  row,
  tz,
  onGo,
}: {
  entry: EntryDetail;
  row: DeskListRow | null;
  tz: string;
  /** Show that step and bring its card into view. */
  onGo: (go: Go) => void;
}) {
  const { session } = useSession();
  const fom = atLeast(session?.actorLevel, "L2");
  const corrections = useChargeCorrections(entry).data?.open ?? [];
  if (!fom || entry.status !== "ACTIVE") return null;
  const asks = asksOf(row, entry);
  const count = asks.length + corrections.length;
  if (!count) return null;
  return (
    <section className="fom-wait" role="region" aria-label="Waiting for your answer" data-fom-wait={count}>
      <h3>
        <span className="fom-wait-mark" aria-hidden>
          !
        </span>
        Waiting for your answer{count > 1 ? <span className="fom-wait-n">{count}</span> : null}
      </h3>
      {corrections.length ? <ChargeCorrectionAsks entry={entry} tz={tz} live mode="band" /> : null}
      {asks.map((a) => (
        <div key={a.key} className="fom-wait-row">
          <span className="fom-wait-text">
            <b>{a.title}</b>
            {a.detail ? <span>{a.detail}</span> : null}
            <span className="sm">asked {fmtDateTime(a.at, tz)}</span>
          </span>
          <Button className="go" onClick={() => onGo(a.go)}>
            Answer it
          </Button>
        </div>
      ))}
    </section>
  );
}

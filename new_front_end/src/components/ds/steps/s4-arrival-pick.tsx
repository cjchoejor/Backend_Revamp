"use client";

import { useState } from "react";
import { Button } from "@/design-system";
import { StayDates } from "@/components/ds/stay-dates";
import { plural } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { DsDialog } from "./kit";

/**
 * Which stays go on to Arrival (2026-11-09, operator: "it can show a pop where it asks the user to
 * pick which stays move to prearrival, where you user select one or more and then move to arrival,
 * that way after s5 there will be separation of stay pages for good"). Nothing is picked until the
 * desk picks. A stay left behind carries on at Reserve on its own page.
 */
export function ArrivalPickDialog({
  stays,
  stayNoOf,
  busy,
  onClose,
  onMove,
}: {
  stays: EntryDetail[];
  stayNoOf: (id: string) => number;
  busy: boolean;
  onClose: () => void;
  onMove: (ids: string[]) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <DsDialog
      open
      closeX
      onClose={onClose}
      busy={busy}
      width={600}
      title="Which stays move to Arrival?"
      footer={
        <>
          <Button kind="quiet" onClick={onClose}>
            Not now
          </Button>
          <Button
            className="go"
            state={busy ? "working" : picked.length ? "default" : "inert"}
            reason={picked.length ? undefined : "pick at least one stay"}
            workingLabel="Moving…"
            onClick={() => onMove(picked)}
          >
            {picked.length > 1 ? `Move ${plural(picked.length, "stay")} to Arrival` : "Move to Arrival"}
          </Button>
        </>
      }
    >
      <p className="sm" style={{ marginTop: 0 }}>
        From Arrival on, each stay is worked on its own page. A stay you leave out carries on at Reserve.
      </p>
      <div className="arrival-pick">
        {stays.map((st) => {
          const on = picked.includes(st.id);
          return (
            <label key={st.id} className={`arrival-row${on ? " on" : ""}`}>
              <input type="checkbox" checked={on} onChange={() => toggle(st.id)} />
              <b>Stay {stayNoOf(st.id)}</b>
              <StayDates checkIn={st.checkInDate} checkOut={st.checkOutDate} />
              <span className="mono sm muted">{st.id}</span>
            </label>
          );
        })}
      </div>
    </DsDialog>
  );
}

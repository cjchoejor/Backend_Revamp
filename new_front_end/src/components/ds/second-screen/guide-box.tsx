"use client";

/**
 * The second screen's "Do next" (2026-10-07): the most urgent thing large — what to do, how,
 * what to say to the guest, what the next press does, and the clock it runs against — then the
 * rest of the list under "After that", then the step's checklist, ticked.
 */
import { Icon } from "@/design-system";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { fmtDateTime, span } from "@/lib/ds/format";
import type { GuideItem } from "@/lib/ds/second-screen/guide";

const KIND: Record<GuideItem["tone"], string> = {
  fix: "Put this right",
  act: "Now",
  wait: "Waiting on the guest",
  ready: "Ready",
};

export function Countdown({ at, label }: { at: string; label: string }) {
  const { now, tz } = useHotelClock(1000);
  const left = new Date(at).getTime() - now;
  return (
    <span className={`gb-clock${left <= 0 ? " late" : left <= 15 * 60_000 ? " close" : ""}`} title={fmtDateTime(at, tz)}>
      <Icon name={left <= 0 ? "alert" : "clock"} /> {label} · {left <= 0 ? `${span(-left)} late` : `${span(left)} left`}
    </span>
  );
}

export function GuideBox({
  items,
  checklist,
  lookingBack,
  onGo,
}: {
  items: GuideItem[];
  checklist: Array<{ label: string; met: boolean; card?: string }>;
  /** Set when the desk is looking at an earlier step than the booking's. */
  lookingBack?: string | null;
  /** Take the desk to a card — the board is a way to navigate too. */
  onGo?: (card: string) => void;
}) {
  const [top, ...rest] = items;
  return (
    <section className={`ib-coach ${top?.tone === "fix" ? "fix" : top?.tone === "ready" ? "ready" : top?.tone === "wait" ? "wait" : ""}`}>
      {lookingBack ? <p className="board-note">{lookingBack}</p> : null}
      {top ? (
        <>
          <span className="k">{KIND[top.tone]}</span>
          <h2>{top.now}</h2>
          {top.clock ? <Countdown at={top.clock.at} label={top.clock.label} /> : null}
          {top.how ? <p className="how">{top.how}</p> : null}
          {top.say ? (
            <blockquote className="say">
              <span className="k">Say to the guest</span>
              {top.say}
            </blockquote>
          ) : null}
          {top.then ? (
            <p className="then">
              <b>What happens next · </b>
              {top.then}
            </p>
          ) : null}
          {top.card && onGo ? <GoButton onClick={() => onGo(top.card!)} /> : null}
        </>
      ) : (
        <>
          <span className="k">Now</span>
          <h2>Nothing waiting</h2>
        </>
      )}
      <GuideRest items={rest} onGo={onGo} />
      <Checklist items={checklist} onGo={onGo} />
    </section>
  );
}

/** "Show me on the desk" — the desk opens the step and scrolls to the card. */
export function GoButton({ onClick, label = "Show me on the desk" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="btn btn-secondary compact gb-go" onClick={onClick}>
      {label} <Icon name="chev" />
    </button>
  );
}

/** The step's checklist, ticked — each open line clickable when it has a card on the desk. */
export function Checklist({ items, onGo }: { items: Array<{ label: string; met: boolean; card?: string }>; onGo?: (card: string) => void }) {
  if (!items.length) return null;
  // Numbered the way the desk numbers its cards: only the lines that have a card on the page.
  let n = 0;
  const numbers = items.map((i) => (i.card ? ++n : null));
  return (
    <ol className="ib-steps">
      {items.map((i, k) => {
        const inner = (
          <>
            <span className="mark">{i.met ? <Icon name="check" /> : numbers[k] ?? "•"}</span>
            {i.label}
          </>
        );
        return (
          <li key={`${k}-${i.label}`} className={i.met ? "met" : ""}>
            {i.card && onGo ? (
              <button type="button" className="gb-line" onClick={() => onGo(i.card!)} title="Show it on the desk">
                {inner}
              </button>
            ) : (
              inner
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The rest of the list — each as one line with its clock, under "After that". */
export function GuideRest({ items, title = "After that", onGo }: { items: GuideItem[]; title?: string; onGo?: (card: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="gb-rest">
      <span className="k">{title}</span>
      <ul>
        {items.map((i) => {
          const inner = (
            <>
              <b>{i.now}</b>
              {i.clock ? <Countdown at={i.clock.at} label={i.clock.label} /> : null}
              {i.how ? <span className="meta">{i.how}</span> : null}
            </>
          );
          return (
            <li key={i.key} className={`${i.tone}${i.card && onGo ? " go" : ""}`}>
              {i.card && onGo ? (
                <button type="button" className="gb-line col" onClick={() => onGo(i.card!)} title="Show it on the desk">
                  {inner}
                </button>
              ) : (
                inner
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

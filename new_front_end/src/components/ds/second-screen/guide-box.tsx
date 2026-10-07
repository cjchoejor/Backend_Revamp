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
}: {
  items: GuideItem[];
  checklist: Array<{ label: string; met: boolean }>;
  /** Set when the desk is looking at an earlier step than the booking's. */
  lookingBack?: string | null;
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
        </>
      ) : (
        <>
          <span className="k">Now</span>
          <h2>Nothing waiting</h2>
        </>
      )}
      <GuideRest items={rest} />
      {checklist.length ? (
        <ol className="ib-steps">
          {checklist.map((i, n) => (
            <li key={`${n}-${i.label}`} className={i.met ? "met" : ""}>
              <span className="mark">{i.met ? <Icon name="check" /> : n + 1}</span>
              {i.label}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

/** The rest of the list — each as one line with its clock, under "After that". */
export function GuideRest({ items, title = "After that" }: { items: GuideItem[]; title?: string }) {
  if (!items.length) return null;
  return (
    <div className="gb-rest">
      <span className="k">{title}</span>
      <ul>
        {items.map((i) => (
          <li key={i.key} className={i.tone}>
            <b>{i.now}</b>
            {i.clock ? <Countdown at={i.clock.at} label={i.clock.label} /> : null}
            {i.how ? <span className="meta">{i.how}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

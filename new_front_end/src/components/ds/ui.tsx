"use client";

/**
 * Small pieces every list screen shares, so a booking reads the same way wherever it appears:
 * its step chip, its status phrase, its name cell, a waiting timer, and the row that opens it.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Button, Chip, Icon } from "@/design-system";
import type { DeskListRow } from "@/lib/api/desk";
import type { WaitingText } from "@/lib/ds/attention";
import { bookerOfRow, factsFromRow, guestNameOf, isNamed, rowNameOf, standingOf, type Standing } from "@/lib/ds/status";
import { BOUNDARY_STEPS, stepName, type StepNo } from "@/lib/ds/steps";

export function bookingHref(entryId: string, step?: number) {
  return `/bookings/${encodeURIComponent(entryId)}${step ? `?step=${step}` : ""}`;
}

/** The step a booking stands at — the two commitment boundaries solid, the sealed step locked. */
export function StepChip({ step }: { step: StepNo }) {
  if (step === 9) return <Chip tone="quiet" icon="lock">{stepName(9)}</Chip>;
  return <Chip tone={BOUNDARY_STEPS.has(step) ? "solid" : "default"}>{stepName(step)}</Chip>;
}

export function StandingChip({ standing }: { standing: Standing }) {
  return (
    <Chip tone={standing.tone} qualifier={standing.qualifier || undefined}>
      {standing.word}
    </Chip>
  );
}

export function RowStanding({ row, hotelToday, balance }: { row: DeskListRow; hotelToday: string | null; balance?: number | null }) {
  return <StandingChip standing={standingOf(factsFromRow(row, balance), hotelToday)} />;
}

/** The guest's name as the row's link; italic when the agent has not named them yet. */
export function GuestLink({ row, step, href }: { row: DeskListRow; step?: number; href?: string }) {
  const name = rowNameOf(row);
  return (
    <Link className={`row-link${isNamed(row.guestProfile) ? "" : " name-i"}`} href={href ?? bookingHref(row.id, step)} aria-label={`Open ${row.id}`} onClick={(e) => e.stopPropagation()}>
      {name}
    </Link>
  );
}

/**
 * "Stay 1 of 2" beside a name when the booking is one stay of a trip (2026-11-10, operator: "show
 * stay 1 of 2 or something like that, prominently but subtle"). The server numbers the stays.
 */
export function StayOf({ row }: { row: DeskListRow }) {
  if (!row.stay) return null;
  return (
    <span className="stay-of" title={`Stay ${row.stay.no} of ${row.stay.of} on enquiry ${row.inquiryId}`}>
      Stay {row.stay.no} of {row.stay.of}
    </span>
  );
}

/** "ENT-… · KNG RESERVATION" — the grey line under a name. */
export function bookingMeta(row: DeskListRow, withRef = true): string {
  const booker = bookerOfRow(row);
  return [withRef ? row.id : null, booker && booker.kind !== "direct" ? booker.name : null].filter(Boolean).join(" · ");
}

export function TimerText({ w }: { w: WaitingText }) {
  if (!w.text) return null;
  return (
    <span className={`timer${w.tone ? ` ${w.tone}` : ""}`}>
      <Icon name={w.tone === "overdue" ? "alert" : "clock"} />
      {w.label} <span className="t">{w.value}</span>
    </span>
  );
}

/** A table row that opens a booking; the name link inside it is the keyboard target. */
export function OpenRow({ entryId, step, href, locked, selected, alt, onSelect, children }: {
  entryId: string;
  /** Every other row is shaded grey in a striped table (2026-11-10, operator). */
  alt?: boolean;
  step?: number;
  /** Open this page rather than the booking. */
  href?: string;
  locked?: boolean;
  selected?: boolean;
  /**
   * When given, a click selects (preview) and a double-click opens. The click waits a moment for a
   * second one, so a double-click opens the booking without the preview flashing up first.
   */
  onSelect?: () => void;
  children: ReactNode;
}) {
  const router = useRouter();
  const open = () => router.push(href ?? bookingHref(entryId, step));
  const waiting = useRef<number | null>(null);
  const stopWaiting = () => {
    if (waiting.current !== null) window.clearTimeout(waiting.current);
    waiting.current = null;
  };
  useEffect(() => stopWaiting, []);
  const select = (e: MouseEvent) => {
    stopWaiting();
    if (e.detail >= 2) return;
    waiting.current = window.setTimeout(() => {
      waiting.current = null;
      onSelect?.();
    }, 260);
  };
  const cls = [selected ? "selected" : "", locked ? "locked" : "", alt ? "alt" : ""].filter(Boolean).join(" ") || undefined;
  return (
    <tr
      className={cls}
      aria-selected={selected || undefined}
      onClick={onSelect ? select : open}
      onDoubleClick={
        onSelect
          ? () => {
              stopWaiting();
              open();
            }
          : undefined
      }
    >
      {children}
    </tr>
  );
}

/** Shows at most twelve rows, then a line pointing at the full list (SS01 §3.3). */
/** A list shows its first page (2026-09-25: fifteen, the operator's number) and says how many more there are. */
export const PAGE = 15;

export function foldTo<T>(rows: T[], n = PAGE): { shown: T[]; more: number } {
  return rows.length <= n ? { shown: rows, more: 0 } : { shown: rows.slice(0, n), more: rows.length - n };
}

/** The rows a list shows: the first page, and a page more each time the reader asks. */
export function usePaged<T>(rows: T[], per = PAGE): { shown: T[]; more: number; showMore: () => void } {
  const [pages, setPages] = useState(1);
  const shown = rows.slice(0, per * pages);
  return { shown, more: rows.length - shown.length, showMore: () => setPages((p) => p + 1) };
}

/**
 * The row under a list that is longer than the page. With `onMore` it shows the next page in
 * place (2026-09-25 — the desk asked for "the first 15, then 15 more", not a jump to the full
 * list); the link to the full list stays beside it when there is one.
 */
export function MoreRow({ more, href, colSpan = 9, onMore, step = PAGE }: { more: number; href?: string; colSpan?: number; onMore?: () => void; step?: number }) {
  if (!more) return null;
  return (
    <tr className="static">
      <td colSpan={colSpan} className="meta">
        {onMore ? (
          <>
            <Button kind="quiet" compact onClick={onMore}>
              Show {Math.min(step, more)} more
            </Button>{" "}
            <span>· {more} more in all</span>
            {href ? (
              <>
                {" · "}
                <Link className="row-link" href={href}>
                  open the list
                </Link>
              </>
            ) : null}
          </>
        ) : (
          <>
            and {more} more{href ? <> · <Link className="row-link" href={href}>open the list</Link></> : null}
          </>
        )}
      </td>
    </tr>
  );
}

export function LoadingBlock() {
  return (
    <div className="skeleton" aria-busy="true">
      <span style={{ width: "60%" }} />
      <span style={{ width: "100%" }} />
      <span style={{ width: "80%" }} />
    </div>
  );
}

export function LoadFailed({ what, onRetry }: { what: string; onRetry?: () => void }) {
  return (
    <div className="empty">
      <b>Couldn&apos;t load {what}</b>
      The hotel server did not answer. {onRetry ? (
        <button type="button" className="btn btn-secondary compact" style={{ marginTop: 8 }} onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

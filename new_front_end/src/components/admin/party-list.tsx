"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Party = {
  id: string;
  displayName: string;
  isActive: boolean;
  contactNumbers?: string[] | null;
  contactEmail?: string | null;
  coordinators?: Array<{ name?: string | null; phone?: string | null; email?: string | null }> | null;
};

/**
 * The list beside an agency's or a company's details (2026-11-03, operator: "they are showing too
 * big"; "keep a search"; "new agent or corporate to be fixed when the user scrolls inside the list").
 * The new button, the inactive tick and the search stay put at the top; only the rows scroll.
 */
export function PartyList<T extends Party>({
  items,
  selectedId,
  onSelect,
  onNew,
  newLabel,
  noun,
  showInactive,
  setShowInactive,
}: {
  items: T[];
  selectedId: string | null;
  onSelect: (item: T) => void;
  onNew: () => void;
  newLabel: string;
  /** "agent" or "account": the words in the count and the search box. */
  noun: string;
  showInactive: boolean;
  setShowInactive: (v: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((a) =>
      [a.displayName, a.id, a.contactEmail, ...(a.contactNumbers ?? []), ...(a.coordinators ?? []).flatMap((c) => [c.name, c.phone, c.email])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [items, query]);

  // A row chosen off screen (a link, a reload) is brought into this list's own view, not the page's.
  const listRef = useRef<HTMLUListElement | null>(null);
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(".adm-row.on");
    if (!list || !row) return;
    const top = row.offsetTop - list.offsetTop;
    if (top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top - 8;
  }, [selectedId, items.length]);

  return (
    <div className="admin-panel adm-master">
      <div className="adm-master-head">
        <div className="adm-master-acts">
          <button type="button" className="admin-btn" onClick={onNew}>
            {newLabel}
          </button>
          <label className="adm-tick">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Inactive
          </label>
        </div>
        <input
          type="search"
          className="admin-input"
          placeholder="Find by name, number or email"
          aria-label={`Find ${noun === "agent" ? "an agent" : "an account"}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
        />
        <span className="adm-master-count">
          {query.trim() ? `${shown.length} of ${items.length}` : `${items.length} ${noun}${items.length === 1 ? "" : "s"}`}
        </span>
      </div>
      <ul className="adm-master-list" ref={listRef}>
        {shown.map((a) => (
          <li key={a.id}>
            <button type="button" className={`adm-row${selectedId === a.id ? " on" : ""}`} onClick={() => onSelect(a)} title={a.displayName}>
              <span className="name">{a.displayName}</span>
              <span className="id">
                {a.id}
                {a.isActive ? "" : " · inactive"}
              </span>
            </button>
          </li>
        ))}
        {shown.length === 0 ? <li className="adm-master-none">{query.trim() ? `No ${noun} by that name.` : `No ${noun}s yet.`}</li> : null}
      </ul>
    </div>
  );
}

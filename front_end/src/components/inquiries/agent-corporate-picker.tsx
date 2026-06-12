"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import {
  searchCorporateAccountsLookup,
  searchTravelAgentsLookup,
  type LookupPartyMatch,
} from "@/lib/api/inquiries";

export type PartyKind = "NONE" | "TRAVEL_AGENT" | "CORPORATE";

export type AgentCorporateSelection =
  | { kind: "NONE" }
  | { kind: "TRAVEL_AGENT"; party: LookupPartyMatch }
  | { kind: "CORPORATE"; party: LookupPartyMatch };

/**
 * Front-desk picker for linking an inquiry to a Phase-B TravelAgent or CorporateAccount.
 * Mutually exclusive — only one of (none / agent / corporate) is selected at a time.
 *
 * When a party is picked the inquiry inherits that party's negotiated RateCard at S2 quotation
 * (see `s2-quotation-service.ts` / `resolveAgentRate`).
 */
export function AgentCorporatePicker({
  selection,
  onChange,
}: {
  selection: AgentCorporateSelection;
  onChange: (next: AgentCorporateSelection) => void;
}) {
  const { session } = useSession();
  const [kind, setKind] = useState<PartyKind>(selection.kind);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => setKind(selection.kind), [selection.kind]);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const enabled = !!session && (kind === "TRAVEL_AGENT" || kind === "CORPORATE") && debounced.length >= 1;
  const searchQuery = useQuery({
    queryKey: ["lookup", kind, debounced],
    queryFn: () =>
      kind === "TRAVEL_AGENT"
        ? searchTravelAgentsLookup(session!, debounced)
        : searchCorporateAccountsLookup(session!, debounced),
    enabled,
  });

  const isAgentSelected = selection.kind === "TRAVEL_AGENT";
  const isCorpSelected = selection.kind === "CORPORATE";
  const isNone = selection.kind === "NONE";

  const matches = searchQuery.data?.matches ?? [];

  function pickKind(next: PartyKind) {
    setKind(next);
    setQuery("");
    setDebounced("");
    if (next === "NONE") onChange({ kind: "NONE" });
  }

  function pickParty(p: LookupPartyMatch) {
    if (kind === "TRAVEL_AGENT") onChange({ kind: "TRAVEL_AGENT", party: p });
    else if (kind === "CORPORATE") onChange({ kind: "CORPORATE", party: p });
  }

  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <div>
        <h3 className="text-sm font-semibold">Agent / corporate (optional)</h3>
        <p className="text-xs text-muted-foreground">
          Link this inquiry to a travel agent or corporate account to use their negotiated rate
          card at quotation. Leave as &ldquo;None&rdquo; for direct/walk-in bookings.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2 rounded-lg border bg-background p-1">
        <KindPill label="None" active={isNone} onClick={() => pickKind("NONE")} />
        <KindPill label="Travel agent" active={isAgentSelected || (isNone && kind === "TRAVEL_AGENT")} onClick={() => pickKind("TRAVEL_AGENT")} />
        <KindPill label="Corporate" active={isCorpSelected || (isNone && kind === "CORPORATE")} onClick={() => pickKind("CORPORATE")} />
      </div>

      {selection.kind !== "NONE" && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <div className="min-w-0">
            <p className="truncate font-medium">{selection.party.displayName}</p>
            <p className="truncate text-xs text-muted-foreground">
              <span className="font-mono">{selection.party.id}</span>
              {selection.party.contactNumber && <> · {selection.party.contactNumber}</>}
              {selection.party.contactEmail && <> · {selection.party.contactEmail}</>}
            </p>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
            onClick={() => pickKind("NONE")}
            aria-label="Clear selection"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {selection.kind === "NONE" && (kind === "TRAVEL_AGENT" || kind === "CORPORATE") && (
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              className="w-full rounded-md border bg-background py-1.5 pl-7 pr-2 text-sm"
              placeholder={kind === "TRAVEL_AGENT" ? "Search travel agents by name…" : "Search corporate accounts by name…"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>
          {searchQuery.isLoading && debounced && <p className="text-xs text-muted-foreground">Searching…</p>}
          {matches.length > 0 && (
            <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border bg-background p-1">
              {matches.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => pickParty(m)}
                  >
                    <div className="font-medium">{m.displayName}</div>
                    <div className="text-xs text-muted-foreground">
                      <span className="font-mono">{m.id}</span>
                      {m.contactNumber && <> · {m.contactNumber}</>}
                      {m.contactEmail && <> · {m.contactEmail}</>}
                      {m.gstNumber && <> · GST {m.gstNumber}</>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {debounced && !searchQuery.isLoading && matches.length === 0 && (
            <p className="text-xs text-muted-foreground">No matches. (Inactive agents/accounts are hidden.)</p>
          )}
        </div>
      )}
    </div>
  );
}

function KindPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

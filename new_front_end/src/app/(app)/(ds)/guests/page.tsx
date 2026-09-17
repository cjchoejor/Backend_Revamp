"use client";

/**
 * Guests — find a person, open their record. The search is the guest registry's own (name, email,
 * phone); an empty search lists the most recently touched guests.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Chip, EmptyState, Input } from "@/design-system";
import { LoadFailed, LoadingBlock } from "@/components/ds/ui";
import { useSession } from "@/hooks/use-session";
import { guestFullName, searchGuestProfiles } from "@/lib/api/guest-profiles";
import { fmtInstantDate } from "@/lib/ds/format";

export default function GuestsPage() {
  const router = useRouter();
  const { session, isLoading } = useSession();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const list = useQuery({
    queryKey: ["guest-search", q],
    queryFn: () => searchGuestProfiles(session!, q, 50),
    enabled: !!session && !isLoading,
    placeholderData: (prev) => prev,
  });
  const items = list.data?.items ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Guests</h2>
          <div className="meta">{q ? `${items.length} matching “${q}”` : "the most recently touched · type to search"}</div>
        </div>
      </div>
      <div className="filters">
        <div className="field" style={{ width: 360 }}>
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, email or phone" aria-label="Search guests" autoFocus />
        </div>
      </div>
      {list.error && !list.data ? (
        <LoadFailed what="the guests" onRetry={() => void list.refetch()} />
      ) : list.isLoading ? (
        <LoadingBlock />
      ) : items.length ? (
        <table className="table">
          <thead>
            <tr>
              <th>Guest</th>
              <th>Phone</th>
              <th>Email</th>
              <th>Nationality</th>
              <th>Last changed</th>
            </tr>
          </thead>
          <tbody>
            {items.map((g) => (
              <tr key={g.id} onClick={() => router.push(`/guests/${g.id}`)}>
                <td>
                  <Link className="row-link" href={`/guests/${g.id}`} onClick={(e) => e.stopPropagation()}>
                    {guestFullName(g)}
                  </Link>
                  {g.vipTier ? (
                    <>
                      {" "}
                      <Chip tone="accent" tier>
                        VIP
                      </Chip>
                    </>
                  ) : null}
                </td>
                <td>{g.phone ?? <span className="dash">—</span>}</td>
                <td>{g.email ?? <span className="dash">—</span>}</td>
                <td>{g.nationality ?? <span className="dash">—</span>}</td>
                <td className="nowrap">{fmtInstantDate(g.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title={q ? "No guest matches" : "No guests yet"}>{q ? "Try part of the name, or the phone number without spaces." : null}</EmptyState>
      )}
    </div>
  );
}

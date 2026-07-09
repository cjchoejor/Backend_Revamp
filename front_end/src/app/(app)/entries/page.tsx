"use client";

import { useMemo, useState, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { GroupBadge } from "@/components/entries/group-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { stageById, stagePath } from "@/config/stages";
import { listEntries } from "@/lib/api/entries";
import { entryListGuestName, guestNameSearchText } from "@/lib/guest-display-name";
import { formatListId } from "@/lib/readable-id";
import { useSession } from "@/hooks/use-session";
import type { Stage } from "@/types/api";

function EntriesContent() {
  const { session } = useSession();
  const searchParams = useSearchParams();
  const stageFilter = searchParams.get("stage") as Stage | null;
  const [search, setSearch] = useState("");

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["entries", { limit: 200, stage: stageFilter }],
    queryFn: () =>
      listEntries(session!, {
        limit: 200,
        ...(stageFilter ? { currentStage: stageFilter } : {}),
      }),
    enabled: !!session,
  });

  const items = useMemo(() => {
    const list = data?.items ?? [];
    if (!search) return list;
    const q = search.toLowerCase();
    return list.filter(
      (e) =>
        e.id.toLowerCase().includes(q) ||
        e.inquiryId.toLowerCase().includes(q) ||
        guestNameSearchText(e.guestProfile ?? e.inquiry?.guestProfile).includes(q) ||
        entryListGuestName(e).toLowerCase().includes(q),
    );
  }, [data?.items, search]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-semibold">Entries</h2>
          <p className="text-sm text-muted-foreground">
            {stageFilter ? `Filtered: ${stageById[stageFilter]?.label ?? stageFilter}` : "All guest entries"}
          </p>
        </div>
        <Input
          placeholder="Search by id, inquiry, guest…"
          className="max-w-xs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{items.length} entries</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : isError ? (
            <p className="py-8 text-center text-sm text-destructive">
              Could not load entries{(error as Error)?.message ? `: ${(error as Error).message}` : ""}
            </p>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No entries found</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Guest</TableHead>
                  <TableHead>Entry</TableHead>
                  <TableHead>Inquiry</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="font-medium">
                      <span className="inline-flex items-center gap-2">
                        {entryListGuestName(entry)}
                        <GroupBadge groupBillingMode={entry.groupBillingMode} compact />
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{formatListId(entry.id)}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{formatListId(entry.inquiryId)}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{entry.currentStage}</Badge>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={entry.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" asChild>
                        <Link href={stagePath(entry.id, entry.currentStage)}>Workspace</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function EntriesPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <EntriesContent />
    </Suspense>
  );
}

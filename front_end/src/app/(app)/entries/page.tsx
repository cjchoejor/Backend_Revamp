"use client";

import { useMemo, useState, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
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
import { useSession } from "@/hooks/use-session";
import type { Stage } from "@/types/api";

function EntriesContent() {
  const { session } = useSession();
  const searchParams = useSearchParams();
  const stageFilter = searchParams.get("stage") as Stage | null;
  const [search, setSearch] = useState("");

  const { data, isLoading } = useQuery({
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
        e.guestProfile?.displayName?.toLowerCase().includes(q),
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
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
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
                    <TableCell className="font-mono text-xs">{entry.id.slice(0, 16)}</TableCell>
                    <TableCell className="font-mono text-xs">{entry.inquiryId.slice(0, 12)}…</TableCell>
                    <TableCell>
                      <Badge variant="outline">{entry.currentStage}</Badge>
                    </TableCell>
                    <TableCell>{entry.status}</TableCell>
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

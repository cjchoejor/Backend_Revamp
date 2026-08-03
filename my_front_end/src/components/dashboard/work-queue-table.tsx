"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { stageById, stagePath } from "@/config/stages";
import { entryListGuestName } from "@/lib/guest-display-name";
import { formatListId } from "@/lib/readable-id";
import type { EntryListItem, InquiryListItem } from "@/types/api";

type WorkQueueTableProps = {
  entries: EntryListItem[];
  inquiries: InquiryListItem[];
};

function urgencyScore(entry: EntryListItem) {
  let score = 0;
  if (entry.status === "PARKED") score += 10;
  const stageOrder = stageById[entry.currentStage]?.order ?? 0;
  score += stageOrder;
  return score;
}

export function WorkQueueTable({ entries, inquiries }: WorkQueueTableProps) {
  const inquiryMap = Object.fromEntries(inquiries.map((i) => [i.id, i]));
  const sorted = [...entries]
    .filter((e) => e.status === "ACTIVE" || e.status === "PARKED")
    .sort((a, b) => urgencyScore(b) - urgencyScore(a))
    .slice(0, 25);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Work queue</CardTitle>
        <CardDescription>Active and parked entries needing attention</CardDescription>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No active work items</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Entry</TableHead>
                <TableHead>Guest</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((entry) => {
                const inquiry = inquiryMap[entry.inquiryId];
                const guest = entryListGuestName({
                  guestProfile: entry.guestProfile ?? inquiry?.guestProfile,
                  inquiry: inquiry ? { guestProfile: inquiry.guestProfile } : null,
                });
                const stageMeta = stageById[entry.currentStage];
                return (
                  <TableRow key={entry.id}>
                    <TableCell className="font-mono text-xs">{formatListId(entry.id)}</TableCell>
                    <TableCell>{guest}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{stageMeta?.shortLabel ?? entry.currentStage}</Badge>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={entry.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={stagePath(entry.id, entry.currentStage)}>
                          Open
                          <ArrowRight className="ml-1 h-3 w-3" />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

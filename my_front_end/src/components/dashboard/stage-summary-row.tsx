"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { STAGES } from "@/config/stages";
import type { EntryListItem, Stage } from "@/types/api";

type StageSummaryRowProps = {
  entries: EntryListItem[];
};

export function StageSummaryRow({ entries }: StageSummaryRowProps) {
  const counts = STAGES.reduce(
    (acc, s) => {
      acc[s.id] = entries.filter((e) => e.currentStage === s.id && e.status === "ACTIVE").length;
      return acc;
    },
    {} as Record<Stage, number>,
  );

  return (
    <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
      {STAGES.map((stage, i) => (
        <motion.div
          key={stage.id}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.04 }}
        >
          <Link href={`/entries?stage=${stage.id}`}>
            <Card className="transition-shadow hover:shadow-md">
              <CardContent className="p-4">
                <p className="text-xs font-medium text-muted-foreground">{stage.shortLabel}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{counts[stage.id] ?? 0}</p>
                <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{stage.label}</p>
              </CardContent>
            </Card>
          </Link>
        </motion.div>
      ))}
    </div>
  );
}

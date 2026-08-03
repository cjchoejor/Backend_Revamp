import { Badge } from "@/components/ui/badge";
import { stageById } from "@/config/stages";
import type { Stage } from "@/types/api";

export function StageBadge({ stage }: { stage: Stage | string | null | undefined }) {
  if (!stage) return <Badge variant="outline">Unknown stage</Badge>;
  const meta = stageById[stage as Stage];
  return <Badge variant="outline">{meta?.label ?? stage}</Badge>;
}

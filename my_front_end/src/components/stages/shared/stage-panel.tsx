import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { StageMeta } from "@/config/stages";

type StagePanelProps = {
  meta: StageMeta;
  children?: React.ReactNode;
  actions?: React.ReactNode;
};

export function StagePanel({ meta, children, actions }: StagePanelProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>
            {meta.shortLabel} — {meta.label}
          </CardTitle>
          <CardDescription>{meta.description}</CardDescription>
        </div>
        {actions}
      </CardHeader>
      {children && <CardContent>{children}</CardContent>}
    </Card>
  );
}

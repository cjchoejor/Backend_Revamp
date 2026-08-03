import { AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { ApiError } from "@/lib/api/client";

export function PolicyGateAlert({ error }: { error: unknown }) {
  if (!(error instanceof ApiError)) return null;
  if (
    error.status !== 409 &&
    error.code !== "PolicyGateBlockedError" &&
    error.code !== "StageGateBlockedError"
  ) {
    return null;
  }

  return (
    <Card className="border-destructive/50 bg-destructive/5">
      <CardContent className="flex gap-3 p-4">
        <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
        <div>
          <p className="font-medium text-destructive">Policy gate blocked</p>
          <p className="text-sm text-muted-foreground">{error.message}</p>
          {error.body?.blockingCondition && (
            <p className="mt-1 text-xs text-muted-foreground">{error.body.blockingCondition}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

import { AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { ApiError } from "@/lib/api/client";

export function ApiErrorAlert({ error, title = "Request failed" }: { error: unknown; title?: string }) {
  if (!(error instanceof ApiError)) return null;

  const isGate =
    error.status === 409 &&
    (error.code === "PolicyGateBlockedError" || error.code === "StageGateBlockedError");

  return (
    <Card className="border-destructive/50 bg-destructive/5">
      <CardContent className="flex gap-3 p-4">
        <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
        <div>
          <p className="font-medium text-destructive">{isGate ? "Policy gate blocked" : title}</p>
          <p className="text-sm text-muted-foreground">{error.message}</p>
          {error.body?.blockingCondition && (
            <p className="mt-1 text-xs text-muted-foreground">{error.body.blockingCondition}</p>
          )}
          {error.status === 400 && error.message.includes("version") && (
            <p className="mt-2 text-xs text-muted-foreground">
              Refresh the page and try again — the entry was updated elsewhere.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

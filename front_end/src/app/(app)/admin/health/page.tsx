"use client";

import { S5ApiHealth } from "@/components/s5/s5-api-health";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function AdminHealthPage() {
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h2 className="font-display text-2xl font-semibold">System health</h2>
        <p className="text-sm text-muted-foreground">Backend connectivity check</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">API health</CardTitle>
          <CardDescription>Verifies Next.js rewrite to Express backend</CardDescription>
        </CardHeader>
        <CardContent>
          <S5ApiHealth />
        </CardContent>
      </Card>
    </div>
  );
}

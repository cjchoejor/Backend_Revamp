"use client";

import { S5ApiHealth } from "@/components/s5/s5-api-health";

export default function AdminHealthPage() {
  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Infrastructure</p>
        <h1 className="admin-display text-3xl">System health</h1>
        <p className="admin-muted mt-2 text-sm">Verifies Next.js rewrite to the Express API.</p>
      </div>
      <div className="admin-panel max-w-lg p-6">
        <S5ApiHealth />
      </div>
    </div>
  );
}

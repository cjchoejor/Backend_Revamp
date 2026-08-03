"use client";

import { useEffect, useState } from "react";

/**
 * Dev-only: LAN IP is a different browser origin than localhost (separate login/zoom).
 * Surfaces the usual “UI looks bigger” cause (per-origin zoom) without affecting production.
 */
export function DevOriginHint() {
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") return;
    if (/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
      setHint(
        `Dev: you are on ${host} (not localhost). Log in here if needed. UI looks bigger? Press Ctrl+0 to reset zoom.`,
      );
    }
  }, []);

  if (!hint) return null;

  return (
    <div
      role="status"
      className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-950 dark:text-amber-100"
    >
      {hint}
      <button
        type="button"
        className="ml-3 underline opacity-80 hover:opacity-100"
        onClick={() => setHint(null)}
      >
        Dismiss
      </button>
    </div>
  );
}

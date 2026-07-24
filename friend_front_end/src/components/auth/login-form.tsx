"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { PinPad } from "./pin-pad";
import { Logo, Wordmark } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { authenticate } from "@/lib/api/auth";
import { ApiError } from "@/lib/api/client";
import { DEFAULT_TERMINAL_ID } from "@/lib/auth/constants";
import { enrichSession } from "@/lib/auth/session-enrich";
import { clearStaleAuth, persistSessionToServer, setClientSession } from "@/lib/auth/session";
import { redirectAfterLogin, redirectToLogin } from "@/lib/auth/sign-out";
import { cn } from "@/lib/utils";
import type { Session } from "@/types/session";

export function LoginForm() {
  const searchParams = useSearchParams();

  useEffect(() => {
    if (searchParams.get("signout") === "1") {
      void clearStaleAuth().then(() => {
        window.history.replaceState(null, "", "/login");
      });
    }
  }, [searchParams]);
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: "error" | "success" | "loading"; text: string } | null>(
    null,
  );

  const handleSubmit = useCallback(
    async (completedPin: string) => {
      if (!username.trim()) {
        setStatusMessage({ type: "error", text: "Enter your username first." });
        setShake(true);
        setTimeout(() => setShake(false), 500);
        return;
      }
      if (completedPin.length < 4 || loading) return;

      setLoading(true);
      setStatusMessage({ type: "loading", text: "Signing in…" });

      try {
        const res = await authenticate(username.trim().toLowerCase(), completedPin, DEFAULT_TERMINAL_ID);
        const session: Session = enrichSession({
          sessionId: res.sessionId,
          userId: res.userId,
          username: res.username,
          actorLevel: res.actorLevel as Session["actorLevel"],
          terminalId: res.terminalId,
          jwtToken: res.jwtToken,
          authenticatedAt: res.authenticatedAt,
          // Prefer full name for the welcome toast + sidebar; falls back to username, never UUID.
          displayName: res.fullName ?? res.username,
        });
        setClientSession(session);
        await persistSessionToServer(session);

        const name = session.displayName ?? session.username ?? session.userId;
        setStatusMessage({ type: "success", text: `Welcome, ${name}` });
        toast.success(`Welcome, ${name}`);

        const from = searchParams.get("from") ?? "/desk";
        redirectAfterLogin(from.startsWith("/") ? from : "/desk");
      } catch (e) {
        setShake(true);
        setTimeout(() => setShake(false), 500);
        setPin("");

        const msg =
          e instanceof ApiError
            ? e.message
            : e instanceof TypeError && e.message.includes("fetch")
              ? "Cannot reach the server. Is the backend running on port 4000?"
              : "Invalid PIN. Please try again.";

        setStatusMessage({ type: "error", text: msg });
        toast.error(msg);
      } finally {
        setLoading(false);
      }
    },
    [loading, searchParams, username],
  );

  return (
    <div className="flex min-h-screen">
      <motion.div
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-gradient-primary p-12 text-white lg:flex"
      >
        <div className="absolute inset-0 bg-black/10" />
        <div className="relative z-10">
          <Logo width={200} height={140} priority className="brightness-110 drop-shadow-lg" />
        </div>
        <div className="relative z-10 space-y-4">
          <h1 className="font-display text-3xl font-semibold tracking-wide">LEGPHEL PMS</h1>
          <p className="max-w-sm text-sm text-white/85">
            Modern property management for front office operations — inquiries through settlement.
          </p>
        </div>
        <p className="relative z-10 text-xs text-white/60">© LEGPHEL Hotel</p>
      </motion.div>

      <div className="flex flex-1 flex-col">
        <div className="flex justify-end p-4">
          <ThemeToggle />
        </div>
        <div className="flex flex-1 flex-col items-center justify-center px-6 pb-12">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            className="w-full max-w-sm space-y-8"
          >
            <div className="flex flex-col items-center gap-4 lg:hidden">
              <Logo width={160} height={100} priority />
            </div>
            <div className="text-center">
              <h2 className="font-display text-2xl font-semibold">Staff sign in</h2>
              <p className="mt-1 text-sm text-muted-foreground">Enter your username and PIN</p>
            </div>

            <div className="space-y-2">
              <label htmlFor="username" className="block text-sm font-medium">Username</label>
              <input
                id="username"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  if (statusMessage?.type === "error") setStatusMessage(null);
                }}
                disabled={loading}
                placeholder="frontdesk / fom / gm / admin"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
              />
            </div>

            <PinPad
              value={pin}
              onChange={(next) => {
                setPin(next);
                if (statusMessage?.type === "error") setStatusMessage(null);
              }}
              onSubmit={handleSubmit}
              disabled={loading}
              shake={shake}
            />

            <div
              className="min-h-[2.5rem] text-center text-sm"
              role="status"
              aria-live="polite"
            >
              {statusMessage?.type === "loading" && (
                <p className="inline-flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {statusMessage.text}
                </p>
              )}
              {statusMessage?.type === "success" && (
                <p className="font-medium text-[var(--success)]">{statusMessage.text}</p>
              )}
              {statusMessage?.type === "error" && (
                <p className={cn("font-medium text-destructive", shake && "animate-shake")}>
                  {statusMessage.text}
                </p>
              )}
            </div>

            <Wordmark />
            <p className="text-center text-[10px] text-muted-foreground">
              Dev PINs: 1111 · 2222 · 3333 · 4444
            </p>
            <p className="text-center">
              <button
                type="button"
                className="text-xs text-muted-foreground underline hover:text-foreground"
                onClick={() => void redirectToLogin()}
              >
                Clear session &amp; sign in again
              </button>
            </p>
          </motion.div>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Eye, EyeOff, Loader2, User } from "lucide-react";
import { toast } from "sonner";
import { PinPad, type PinStatus } from "./pin-pad";
import { authenticate } from "@/lib/api/auth";
import { ApiError } from "@/lib/api/client";
import { DEFAULT_TERMINAL_ID } from "@/lib/auth/constants";
import { enrichSession } from "@/lib/auth/session-enrich";
import { clearStaleAuth, persistSessionToServer } from "@/lib/auth/session";
import { redirectAfterLogin, redirectToLogin, safeFrom } from "@/lib/auth/sign-out";
import { useSession } from "@/components/providers/session-provider";
import { cn } from "@/lib/utils";
import type { Session } from "@/types/session";

const MAROON = "radial-gradient(130% 120% at 50% 45%, #7e1723 0%, #350810 100%)";

// The form sits on a light card in both themes (like the reference), so its tokens
// are pinned to light values regardless of the app's global light/dark setting.
const cardStyle = {
  background: "#ffffff",
  border: "1px solid #efe4e4",
  boxShadow: "0 1px 2px rgba(0,0,0,0.05), 0 26px 60px -30px rgba(30,6,10,0.5)",
  "--card": "#ffffff",
  "--card-foreground": "#1a1316",
  "--foreground": "#1a1316",
  "--background": "#ffffff",
  "--primary": "#8b1a1a",
  "--primary-foreground": "#ffffff",
  "--secondary": "#f4edee",
  "--secondary-foreground": "#4a1515",
  "--muted": "#f4f4f5",
  "--muted-foreground": "#8a7f82",
  "--border": "#ecdede",
  "--input": "#e6d9d9",
  "--ring": "#b4232a",
  "--success": "#2e7d32",
  "--destructive": "#dc2626",
} as CSSProperties;

export function LoginForm() {
  const searchParams = useSearchParams();
  const reduceMotion = useReducedMotion();
  const { saveSession } = useSession();
  const logoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (searchParams.get("signout") === "1") {
      void clearStaleAuth().then(() => {
        window.history.replaceState(null, "", "/login");
      });
    }
  }, [searchParams]);

  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [reveal, setReveal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [floatFrom, setFloatFrom] = useState<{ dx: number; dy: number; scale: number } | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ type: "error" | "success" | "loading"; text: string } | null>(
    null,
  );

  const failShake = () => {
    setShake(true);
    setTimeout(() => setShake(false), 500);
  };

  const handleSubmit = useCallback(
    async (completedPin: string) => {
      if (!username.trim()) {
        setStatusMessage({ type: "error", text: "Enter your username first." });
        failShake();
        return;
      }
      if (completedPin.length < 4 || loading) return;

      setLoading(true);
      setStatusMessage({ type: "loading", text: "Checking your PIN…" });

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
        // The provider's own copy too (2026-11-12): the page left behind can still move to a desk
        // page before the hard navigation lands (a slow first load), and must not read "nobody".
        saveSession(session);
        await persistSessionToServer(session);

        const name = session.displayName ?? session.username ?? session.userId;
        setStatusMessage({ type: "success", text: `Welcome back, ${name}` });

        // Measure the card logo so the mark can "float" from it into the centre.
        const el = logoRef.current;
        if (el && typeof window !== "undefined") {
          const r = el.getBoundingClientRect();
          const cx = window.innerWidth / 2;
          const cy = window.innerHeight * 0.45;
          const startCX = r.left + r.width / 2;
          const startCY = r.top + r.height * 0.33; // the cherry sits in the logo's upper third
          const startSize = r.width * 0.62;
          setFloatFrom({ dx: startCX - cx, dy: startCY - cy, scale: startSize / 88 });
        }

        const target = safeFrom(searchParams.get("from"));
        setLeaving(name);
        setTimeout(() => redirectAfterLogin(target), reduceMotion ? 700 : 1550);
      } catch (e) {
        failShake();
        setPin("");

        const msg =
          e instanceof ApiError
            ? e.message
            : e instanceof TypeError && e.message.includes("fetch")
              ? "Cannot reach the server. Is the backend running on port 4000?"
              : "That PIN didn't match. Try again.";

        setStatusMessage({ type: "error", text: msg });
        toast.error(msg);
        setLoading(false);
      }
    },
    [loading, searchParams, username, reduceMotion, saveSession],
  );

  const status: PinStatus =
    statusMessage?.type === "success"
      ? "success"
      : statusMessage?.type === "error"
        ? "error"
        : loading
          ? "verifying"
          : "idle";

  const busy = loading || status === "success";

  return (
    <div className="relative min-h-screen w-full overflow-hidden">
      {/* Twilight base tone so the pulled-back edges are never empty */}
      <div className="absolute inset-0" style={{ background: "#0d1627" }} />
      {/* A blurred, enlarged copy fills the edges with soft atmosphere (desktop) */}
      <Image
        src="/brand/hotel-twilight.jpg"
        alt=""
        aria-hidden
        fill
        sizes="100vw"
        className="hidden object-cover lg:block"
        style={{ transform: "scale(1.12)", filter: "blur(30px)", opacity: 0.5 }}
      />
      {/* The hotel — filled on mobile, pulled back on desktop so the whole building shows */}
      <Image
        src="/brand/hotel-twilight.jpg"
        alt="Legphel Hotel at twilight"
        fill
        priority
        quality={90}
        sizes="100vw"
        className="object-cover lg:object-contain lg:object-left"
      />
      {/* Darken the left for the wordmark + tagline */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(104deg, rgba(8,5,12,0.60) 0%, rgba(8,5,12,0.26) 28%, rgba(8,5,12,0.04) 50%, rgba(8,5,12,0) 62%)",
        }}
      />
      {/* Blend the photo into the sign-in zone on the right (wide, soft frosted glass) */}
      <div
        className="absolute inset-y-0 right-0 hidden lg:block"
        style={{
          width: "62%",
          background:
            "linear-gradient(90deg, rgba(247,241,240,0) 0%, rgba(247,241,240,0.32) 18%, rgba(247,241,240,0.66) 44%, rgba(247,241,240,0.9) 72%, rgba(247,241,240,0.97) 100%)",
          backdropFilter: "blur(9px)",
          WebkitBackdropFilter: "blur(9px)",
          maskImage: "linear-gradient(90deg, transparent 0%, #000 36%)",
          WebkitMaskImage: "linear-gradient(90deg, transparent 0%, #000 36%)",
        }}
      />
      {/* Mobile: soften the whole photo so the card reads */}
      <div className="absolute inset-0 lg:hidden" style={{ background: "rgba(16,6,11,0.5)" }} />

      {/* Content */}
      <div className="relative z-10 grid min-h-screen lg:grid-cols-2">
        {/* LEFT — brand over the photo (desktop) */}
        <div className="hidden flex-col justify-between p-12 text-white lg:flex">
          <div className="flex items-center gap-3">
            <Image src="/brand/logo-mark.png" alt="" aria-hidden width={40} height={40} />
            <div className="leading-none">
              <p className="text-sm font-semibold tracking-[0.34em]">LEGPHEL</p>
              <p className="mt-1 text-[11px] tracking-[0.34em] text-white/75">HOTEL</p>
            </div>
          </div>
          <div className="max-w-md">
            <h2 className="font-display text-[2rem] font-semibold leading-tight drop-shadow-sm">
              The front desk, in good hands.
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-white/80">
              Inquiries, arrivals and settlement — every stay, from the first call to check-out.
            </p>
            <p className="mt-6 text-xs tracking-wide text-white/60">Phuentsholing · Bhutan</p>
          </div>
        </div>

        {/* RIGHT — sign in */}
        <div className="flex items-center justify-center p-6 sm:p-10">
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={leaving ? { opacity: 0, scale: 0.97 } : { opacity: 1, y: 0 }}
            transition={{ duration: leaving ? 0.3 : 0.45, ease: "easeOut" }}
            className="w-full max-w-[384px]"
          >
            <div className="rounded-[20px] px-7 py-7" style={cardStyle}>
              {/* Brand */}
              <div ref={logoRef} className="mx-auto w-fit">
                <Image
                  src="/brand/legphel-logo-full.png"
                  alt="Legphel Hotel"
                  width={88}
                  height={119}
                  quality={100}
                  priority
                />
              </div>

              <div className="mt-3 text-center">
                <h1 className="text-xl font-semibold text-foreground">Welcome back</h1>
                <p className="mt-1 text-sm text-muted-foreground">Sign in to the front desk</p>
              </div>

              <div className="mt-5 space-y-5">
                {/* Username — soft-filled, icon-led */}
                <div className="relative">
                  <User className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="username"
                    type="text"
                    aria-label="Username"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={username}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      if (statusMessage?.type === "error") setStatusMessage(null);
                    }}
                    disabled={busy}
                    placeholder="Username"
                    className="w-full rounded-[12px] bg-secondary py-3 pl-10 pr-3.5 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:bg-white focus:ring-2 focus:ring-[color-mix(in_srgb,var(--ring)_45%,transparent)] disabled:opacity-60"
                  />
                </div>

                {/* PIN */}
                <div>
                  <div className="relative mb-3 flex items-center justify-center">
                    <span className="text-xs font-medium text-muted-foreground">Enter your PIN</span>
                    <button
                      type="button"
                      onClick={() => setReveal((r) => !r)}
                      className="absolute right-0 top-1/2 inline-flex -translate-y-1/2 items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      {reveal ? "Hide" : "Show"}
                    </button>
                  </div>

                  <PinPad
                    value={pin}
                    onChange={(next) => {
                      setPin(next);
                      if (statusMessage?.type === "error") setStatusMessage(null);
                    }}
                    onSubmit={handleSubmit}
                    disabled={loading}
                    status={status}
                    reveal={reveal}
                    shake={shake}
                  />
                </div>

                {searchParams.get("ended") === "1" && !statusMessage ? (
                  <p className="mb-2 text-center text-sm font-semibold" role="status" style={{ color: "#8b1a1a" }} data-signin-ended>
                    Your sign-in has ended — sign in again, and you go back to the page you were on.
                  </p>
                ) : null}
                <div className="min-h-[1.25rem] text-center text-sm" role="status" aria-live="polite">
                  {status === "verifying" && (
                    <p className="inline-flex items-center gap-2 text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {statusMessage?.text}
                    </p>
                  )}
                  {status === "success" && (
                    <p className="font-medium" style={{ color: "var(--success)" }}>
                      {statusMessage?.text}
                    </p>
                  )}
                  {status === "error" && (
                    <p className={cn("font-medium text-destructive", shake && "animate-shake")}>{statusMessage?.text}</p>
                  )}
                </div>

                {/* Quiet helpers, on the card so they read in every context */}
                <div className="border-t pt-4 text-center" style={{ borderColor: "var(--border)" }}>
                  <p className="text-[11px] text-muted-foreground">Dev PINs · 1111 · 2222 · 3333 · 4444</p>
                  <button
                    type="button"
                    className="mt-1.5 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                    onClick={() => void redirectToLogin()}
                  >
                    Clear session &amp; sign in again
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </div>

      {/* Sign-in → app handoff: the mark floats to the centre, then a branded reveal */}
      <AnimatePresence>
        {leaving && (
          <>
            <motion.div
              key="reveal"
              className="fixed inset-0 z-50"
              style={{ background: MAROON }}
              initial={reduceMotion ? { opacity: 0 } : { clipPath: "circle(0% at 50% 45%)" }}
              animate={reduceMotion ? { opacity: 1 } : { clipPath: "circle(150% at 50% 45%)" }}
              transition={{ delay: reduceMotion ? 0 : 0.5, duration: reduceMotion ? 0.3 : 0.6, ease: [0.65, 0, 0.35, 1] }}
            />
            <motion.div
              key="welcome"
              className="pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center"
              style={{ top: "calc(45% + 76px)" }}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: reduceMotion ? 0.15 : 0.95, duration: 0.35 }}
            >
              <p className="font-medium text-white">Welcome back, {leaving}</p>
              <Loader2 className="mt-3 h-5 w-5 animate-spin text-white/75" />
            </motion.div>
            <motion.div
              key="floatmark"
              className="pointer-events-none fixed left-1/2 top-[45%] z-[61] -ml-11 -mt-11 h-[88px] w-[88px]"
              initial={
                floatFrom && !reduceMotion
                  ? { x: floatFrom.dx, y: floatFrom.dy, scale: floatFrom.scale, opacity: 1 }
                  : { scale: 0.8, opacity: 0 }
              }
              animate={{ x: 0, y: 0, scale: 1, opacity: 1 }}
              transition={{ duration: reduceMotion ? 0.25 : 0.6, ease: [0.22, 1, 0.36, 1] }}
            >
              <Image src="/brand/logo-mark.png" alt="" aria-hidden width={88} height={88} />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

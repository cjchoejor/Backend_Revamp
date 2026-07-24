"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Building2, Settings2, Sparkles } from "lucide-react";

type Zone = "admin" | "operations";

const MIN_VISIBLE_MS = 380;

type ZoneTransitionValue = {
  active: boolean;
  target: Zone | null;
  startTransition: (target: Zone) => void;
  endTransition: () => void;
};

const ZoneTransitionContext = createContext<ZoneTransitionValue | null>(null);

export function ZoneTransitionProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const [target, setTarget] = useState<Zone | null>(null);
  const startedAtRef = useRef(0);
  const endTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startTransition = useCallback((next: Zone) => {
    if (endTimerRef.current) {
      clearTimeout(endTimerRef.current);
      endTimerRef.current = null;
    }
    startedAtRef.current = Date.now();
    setTarget(next);
    setActive(true);
  }, []);

  const endTransition = useCallback(() => {
    const elapsed = Date.now() - startedAtRef.current;
    const remaining = Math.max(0, MIN_VISIBLE_MS - elapsed);
    const finish = () => {
      setActive(false);
      setTarget(null);
      endTimerRef.current = null;
    };
    if (remaining === 0) finish();
    else endTimerRef.current = setTimeout(finish, remaining);
  }, []);

  const value = useMemo(
    () => ({ active, target, startTransition, endTransition }),
    [active, target, startTransition, endTransition],
  );

  return (
    <ZoneTransitionContext.Provider value={value}>
      {children}
      <ZoneTransitionWatcher />
      <ZoneTransitionOverlay />
    </ZoneTransitionContext.Provider>
  );
}

/** Dismisses the overlay once the pathname has crossed into the target zone. */
function ZoneTransitionWatcher() {
  const ctx = useContext(ZoneTransitionContext);
  const pathname = usePathname();
  useEffect(() => {
    if (!ctx?.active || !ctx.target) return;
    const inAdmin = pathname?.startsWith("/admin") ?? false;
    const arrived = (ctx.target === "admin" && inAdmin) || (ctx.target === "operations" && !inAdmin);
    if (arrived) ctx.endTransition();
  }, [pathname, ctx]);
  return null;
}

export function useZoneTransition() {
  const ctx = useContext(ZoneTransitionContext);
  if (!ctx) throw new Error("useZoneTransition must be used within ZoneTransitionProvider");
  return ctx;
}

/** A Next Link that triggers the zone-transition overlay before the route loads. */
export function ZoneTransitionLink({
  href,
  target,
  children,
  className,
  prefetch,
}: {
  href: string;
  target: Zone;
  children: ReactNode;
  className?: string;
  prefetch?: boolean;
}) {
  const ctx = useContext(ZoneTransitionContext);
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // Skip when the user is opening in a new tab / using a modifier key.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    ctx?.startTransition(target);
  };
  return (
    <Link href={href} prefetch={prefetch} className={className} onClick={handleClick}>
      {children}
    </Link>
  );
}

const MESSAGES_TO_ADMIN = [
  "Polishing the brass…",
  "Unlocking the configuration drawer…",
  "Hanging the “do not disturb” on operations…",
  "Greasing the policy hinges…",
];

const MESSAGES_TO_OPERATIONS = [
  "Returning the keys…",
  "Re-opening the front desk…",
  "Welcoming you back to the floor…",
  "Operations is warming up…",
];

function ZoneTransitionOverlay() {
  const ctx = useContext(ZoneTransitionContext);
  const [mounted, setMounted] = useState(false);
  const [msgIndex, setMsgIndex] = useState(0);

  useEffect(() => setMounted(true), []);

  const active = ctx?.active ?? false;
  const target = ctx?.target ?? null;

  const messages = useMemo(
    () => (target === "admin" ? MESSAGES_TO_ADMIN : MESSAGES_TO_OPERATIONS),
    [target],
  );

  useEffect(() => {
    if (!active) {
      setMsgIndex(0);
      return;
    }
    const id = setInterval(() => setMsgIndex((i) => (i + 1) % messages.length), 1100);
    return () => clearInterval(id);
  }, [active, messages.length]);

  if (!mounted || !active || !target) return null;

  const title = target === "admin" ? "Admin Console" : "Operations";
  const subtitle = target === "admin" ? "Configuration authority" : "S1–S9 lifecycle";
  const fromLabel = target === "admin" ? "Operations" : "Admin Console";
  const Icon = target === "admin" ? Settings2 : Building2;
  const gradient =
    target === "admin"
      ? "from-amber-500 via-amber-400 to-amber-600"
      : "from-sky-500 via-cyan-400 to-sky-600";

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="zone-backdrop"
        role="status"
        aria-live="polite"
        aria-busy="true"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-[210] flex items-center justify-center bg-background/85 backdrop-blur-md"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.94, y: 14 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: 6 }}
          transition={{ type: "spring", stiffness: 360, damping: 26 }}
          className="relative mx-4 w-full max-w-md overflow-hidden rounded-3xl border bg-card px-10 py-12 text-center shadow-2xl"
        >
          {/* Animated glow */}
          <motion.div
            className={`pointer-events-none absolute -inset-1 rounded-3xl bg-gradient-to-tr ${gradient} blur-2xl`}
            initial={{ opacity: 0.18 }}
            animate={{ opacity: [0.18, 0.38, 0.18] }}
            transition={{ repeat: Infinity, duration: 2.5, ease: "easeInOut" }}
            aria-hidden
          />

          {/* From → To header */}
          <div className="relative mb-6 flex items-center justify-center gap-2 text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            <span>{fromLabel}</span>
            <motion.span
              animate={{ x: [0, 6, 0] }}
              transition={{ repeat: Infinity, duration: 1.4, ease: "easeInOut" }}
            >
              <ArrowRight className="h-3.5 w-3.5" />
            </motion.span>
            <span className="font-semibold text-foreground">{title}</span>
          </div>

          {/* Big animated icon */}
          <div className="relative mx-auto mb-6 h-24 w-24">
            <motion.div
              className={`absolute inset-0 rounded-full bg-gradient-to-br ${gradient} opacity-20`}
              animate={{ scale: [1, 1.15, 1] }}
              transition={{ repeat: Infinity, duration: 1.7, ease: "easeInOut" }}
            />
            <motion.div
              className="absolute inset-0"
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 6, ease: "linear" }}
            >
              <div className="h-full w-full rounded-full border-2 border-dashed border-primary/40" />
            </motion.div>
            <div className="absolute inset-0 flex items-center justify-center">
              <Icon className="h-10 w-10 text-primary" />
            </div>
            <motion.div
              className="absolute -right-1 -top-1"
              animate={{ rotate: [0, 25, -10, 0] }}
              transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
            >
              <Sparkles className="h-5 w-5 text-amber-500" />
            </motion.div>
          </div>

          {/* Title */}
          <p className="relative text-sm font-medium text-muted-foreground">You are now transitioning to</p>
          <p className={`relative mt-1 bg-gradient-to-r ${gradient} bg-clip-text text-3xl font-bold tracking-tight text-transparent`}>
            {title}
          </p>
          <p className="relative mt-1 text-xs text-muted-foreground">{subtitle}</p>

          {/* Rotating playful message */}
          <div className="relative mt-5 h-6 overflow-hidden">
            <AnimatePresence mode="wait">
              <motion.p
                key={msgIndex}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.25 }}
                className="text-sm text-muted-foreground"
              >
                {messages[msgIndex]}
              </motion.p>
            </AnimatePresence>
          </div>

          {/* Progress dots */}
          <div className="relative mt-5 flex justify-center gap-2">
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="h-2 w-2 rounded-full bg-primary"
                animate={{ y: [0, -8, 0], opacity: [0.4, 1, 0.4] }}
                transition={{ repeat: Infinity, duration: 0.7, delay: i * 0.12, ease: "easeInOut" }}
              />
            ))}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}

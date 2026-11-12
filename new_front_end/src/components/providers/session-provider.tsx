"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  clearClientSession,
  clearSessionOnServer,
  getClientSession,
  hydrateSessionFromServer,
  readServerSession,
  setClientSession,
} from "@/lib/auth/session";
import { goToSignIn } from "@/lib/auth/sign-out";
import { SIGNIN_ENDED_EVENT } from "@/lib/api/client";
import type { Session } from "@/types/session";

type SessionContextValue = {
  session: Session | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  saveSession: (s: Session) => void;
  clearSession: () => Promise<void>;
  /** Look again for a sign-in — this tab's, then the cookie's — before anyone is treated as signed out. */
  recheck: () => Promise<Session | null>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const queryClient = useQueryClient();
  const current = useRef<Session | null>(null);
  current.current = session;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      let s = getClientSession();
      if (!s) {
        s = await hydrateSessionFromServer();
      }
      if (!cancelled) {
        setSession(s);
        setIsLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveSession = useCallback((s: Session) => {
    setClientSession(s);
    setSession(s);
  }, []);

  const clearSession = useCallback(async () => {
    clearClientSession();
    await clearSessionOnServer();
    setSession(null);
  }, []);

  const recheck = useCallback(async (): Promise<Session | null> => {
    // The sign-in page writes this tab's copy as it signs in; take it if it is there.
    const local = getClientSession();
    if (local) {
      setSession(local);
      return local;
    }
    const { session: fromCookie } = await readServerSession();
    if (fromCookie) {
      setClientSession(fromCookie);
      setSession(fromCookie);
    }
    return fromCookie;
  }, []);

  // A sign-in changed under the open page: every read refused with the old one is asked again.
  const lastToken = useRef<string | null>(null);
  useEffect(() => {
    const token = session?.jwtToken ?? null;
    if (lastToken.current && token && lastToken.current !== token) void queryClient.invalidateQueries();
    lastToken.current = token;
  }, [session?.jwtToken, queryClient]);

  // The backend refused this tab's sign-in (2026-11-12). The cookie decides: a newer sign-in there
  // (made on another tab) is taken and the page goes on; the same ended sign-in, or none, means it
  // is over — this tab's copy and the cookie are cleared and the person signs in, then comes back.
  useEffect(() => {
    let busy = false;
    const onEnded = async (e: Event) => {
      const refused = (e as CustomEvent<{ token: string | null }>).detail?.token ?? null;
      const mine = current.current?.jwtToken ?? null;
      if (busy || (refused && mine && refused !== mine)) return; // an older sign-in, already replaced
      busy = true;
      try {
        const { ok, session: fromCookie } = await readServerSession();
        if (fromCookie && fromCookie.jwtToken && fromCookie.jwtToken !== refused) {
          const before = current.current;
          setClientSession(fromCookie);
          setSession(fromCookie);
          if (before && before.userId !== fromCookie.userId) {
            toast.info(`Signed in as ${fromCookie.displayName ?? fromCookie.username ?? fromCookie.userId} — the sign-in made on another tab`);
          }
          return;
        }
        if (!ok) return; // the cookie could not be read: leave things be, the next refusal asks again
        clearClientSession();
        await clearSessionOnServer();
        goToSignIn({ ended: true });
      } finally {
        busy = false;
      }
    };
    window.addEventListener(SIGNIN_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(SIGNIN_ENDED_EVENT, onEnded);
  }, []);

  const value = useMemo(
    () => ({
      session,
      isLoading,
      isAuthenticated: !!session,
      saveSession,
      clearSession,
      recheck,
    }),
    [session, isLoading, saveSession, clearSession, recheck],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSession must be used within SessionProvider");
  }
  return ctx;
}

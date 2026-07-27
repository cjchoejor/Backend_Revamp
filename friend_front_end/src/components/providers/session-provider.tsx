"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  clearClientSession,
  clearSessionOnServer,
  getClientSession,
  hydrateSessionFromServer,
  setClientSession,
} from "@/lib/auth/session";
import type { Session } from "@/types/session";

type SessionContextValue = {
  session: Session | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  saveSession: (s: Session) => void;
  clearSession: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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

  const value = useMemo(
    () => ({
      session,
      isLoading,
      isAuthenticated: !!session,
      saveSession,
      clearSession,
    }),
    [session, isLoading, saveSession, clearSession],
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

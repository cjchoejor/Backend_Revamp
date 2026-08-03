"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Stage } from "@/types/api";

/** Minimum overlay time so the animation does not flash; actual dismiss waits for data in EntryWorkspace. */
const MIN_VISIBLE_MS = 280;

export type StageTransitionOptions = {
  targetStage?: Stage;
  label?: string;
};

type StageTransitionContextValue = {
  active: boolean;
  targetStage?: Stage;
  label?: string;
  startTransition: (opts?: StageTransitionOptions) => void;
  endTransition: () => void;
};

const StageTransitionContext = createContext<StageTransitionContextValue | null>(null);

export function StageTransitionProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const [targetStage, setTargetStage] = useState<Stage | undefined>();
  const [label, setLabel] = useState<string | undefined>();
  const startedAtRef = useRef(0);
  const endTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startTransition = useCallback((opts?: StageTransitionOptions) => {
    if (endTimerRef.current) {
      clearTimeout(endTimerRef.current);
      endTimerRef.current = null;
    }
    startedAtRef.current = Date.now();
    setTargetStage(opts?.targetStage);
    setLabel(opts?.label);
    setActive(true);
  }, []);

  const endTransition = useCallback(() => {
    const elapsed = Date.now() - startedAtRef.current;
    const remaining = Math.max(0, MIN_VISIBLE_MS - elapsed);

    const finish = () => {
      setActive(false);
      setTargetStage(undefined);
      setLabel(undefined);
      endTimerRef.current = null;
    };

    if (remaining === 0) {
      finish();
      return;
    }

    endTimerRef.current = setTimeout(finish, remaining);
  }, []);

  const value = useMemo(
    () => ({ active, targetStage, label, startTransition, endTransition }),
    [active, targetStage, label, startTransition, endTransition],
  );

  return <StageTransitionContext.Provider value={value}>{children}</StageTransitionContext.Provider>;
}

export function useStageTransition() {
  const ctx = useContext(StageTransitionContext);
  if (!ctx) {
    throw new Error("useStageTransition must be used within StageTransitionProvider");
  }
  return ctx;
}

/** Safe when provider is absent (e.g. tests). */
export function useStageTransitionOptional() {
  return useContext(StageTransitionContext);
}

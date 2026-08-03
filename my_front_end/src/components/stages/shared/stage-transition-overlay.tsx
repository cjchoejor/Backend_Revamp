"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { BedDouble, Hotel, Luggage, Sparkles } from "lucide-react";
import { stageById } from "@/config/stages";
import { useStageTransitionOptional } from "./stage-transition-context";
import type { Stage } from "@/types/api";

const DEFAULT_MESSAGES = [
  "Smoothing the duvet…",
  "Asking housekeeping for a speed boost…",
  "Your stay is packing its bags for the next stage…",
  "Almost there — no minibar charges for waiting!",
];

const STAGE_MESSAGES: Partial<Record<Stage, string[]>> = {
  S1: ["Warming up the inquiry desk…", "Scanning the availability radar…"],
  S2: ["Sharpening quotation pencils…", "Negotiation mode: engaged…"],
  S3: ["Placing a committed hold on your calendar…", "Setting up the provisional folio…"],
  S4: ["Rolling out the red carpet for confirmation…", "Printing invisible confirmation vibes…"],
  S5: ["Pre-arrival checklist is doing stretches…", "Room readiness is on its way…"],
  S6: ["Guest at the desk — keys jingling…", "Opening the check-in lane…"],
  S7: ["In-stay mode: slippers activated…", "Folio is stretching before the sprint…"],
  S8: ["Checkout conveyor belt starting…", "Settling the final folio dance…"],
  S9: ["Closing the chapter with a bow…", "Settlement confetti incoming…"],
};

function messagesFor(targetStage?: Stage, label?: string): string[] {
  if (label) return [label, ...DEFAULT_MESSAGES];
  if (targetStage && STAGE_MESSAGES[targetStage]) return STAGE_MESSAGES[targetStage]!;
  return DEFAULT_MESSAGES;
}

export function StageTransitionOverlay() {
  const ctx = useStageTransitionOptional();
  const [mounted, setMounted] = useState(false);
  const [msgIndex, setMsgIndex] = useState(0);

  const active = ctx?.active ?? false;
  const targetStage = ctx?.targetStage;
  const label = ctx?.label;

  const messages = useMemo(() => messagesFor(targetStage, label), [targetStage, label]);
  const stageTitle = targetStage ? stageById[targetStage]?.label : "Next stage";

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!active) {
      setMsgIndex(0);
      return;
    }
    const id = setInterval(() => setMsgIndex((i) => (i + 1) % messages.length), 1100);
    return () => clearInterval(id);
  }, [active, messages.length]);

  if (!mounted || !active || !ctx) return null;

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="stage-transition-backdrop"
        role="status"
        aria-live="polite"
        aria-busy="true"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-[200] flex items-center justify-center bg-background/75 backdrop-blur-md"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.92, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 8 }}
          transition={{ type: "spring", stiffness: 380, damping: 28 }}
          className="relative mx-4 w-full max-w-sm overflow-hidden rounded-2xl border bg-card px-8 py-10 text-center shadow-2xl"
        >
          <div
            className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-primary/10 blur-2xl"
            aria-hidden
          />
          <div
            className="pointer-events-none absolute -bottom-10 -left-6 h-28 w-28 rounded-full bg-[var(--accent)]/15 blur-2xl"
            aria-hidden
          />

          <div className="relative mx-auto mb-6 h-28 w-28">
            <motion.div
              className="absolute inset-0"
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 4, ease: "linear" }}
            >
              <Hotel className="absolute left-1/2 top-0 h-7 w-7 -translate-x-1/2 text-primary" />
              <Luggage className="absolute bottom-1 right-0 h-6 w-6 text-[var(--accent)]" />
              <BedDouble className="absolute bottom-1 left-0 h-6 w-6 text-muted-foreground" />
            </motion.div>
            <motion.div
              className="absolute inset-0 flex items-center justify-center"
              animate={{ scale: [1, 1.12, 1] }}
              transition={{ repeat: Infinity, duration: 1.1, ease: "easeInOut" }}
            >
              <Sparkles className="h-11 w-11 text-primary" />
            </motion.div>
          </div>

          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {targetStage ? `Heading to ${targetStage}` : "Stage transition"}
          </p>
          <h3 className="mt-1 text-lg font-semibold tracking-tight">{stageTitle}</h3>

          <div className="mt-3 h-10 overflow-hidden">
            <AnimatePresence mode="wait">
              <motion.p
                key={msgIndex}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.25 }}
                className="text-sm text-muted-foreground"
              >
                {messages[msgIndex]}
              </motion.p>
            </AnimatePresence>
          </div>

          <div className="mt-6 flex justify-center gap-2">
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="h-2.5 w-2.5 rounded-full bg-primary"
                animate={{ y: [0, -10, 0], opacity: [0.5, 1, 0.5] }}
                transition={{
                  repeat: Infinity,
                  duration: 0.55,
                  delay: i * 0.12,
                  ease: "easeInOut",
                }}
              />
            ))}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}

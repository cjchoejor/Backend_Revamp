"use client";

import { useEffect, type CSSProperties } from "react";
import { motion } from "framer-motion";
import { Delete } from "lucide-react";
import { cn } from "@/lib/utils";
import { PIN_LENGTH } from "@/lib/auth/constants";

export type PinStatus = "idle" | "verifying" | "success" | "error";

type PinPadProps = {
  value: string;
  onChange: (value: string) => void;
  /** Called with the full PIN when the last digit is entered */
  onSubmit: (completedPin: string) => void;
  disabled?: boolean;
  shake?: boolean;
  maxLength?: number;
  status?: PinStatus;
  /** Show the typed digits instead of masking them */
  reveal?: boolean;
};

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"] as const;

// Designed states for each PIN tile (Video 2: "add it to each state").
function tileStyle(kind: "empty" | "active" | "filled", status: PinStatus): CSSProperties {
  if (status === "success")
    return {
      borderColor: "var(--success)",
      color: "var(--success)",
      background: "color-mix(in srgb, var(--success) 12%, transparent)",
    };
  if (status === "error")
    return {
      borderColor: "var(--destructive)",
      color: "var(--destructive)",
      background: "color-mix(in srgb, var(--destructive) 10%, transparent)",
    };
  if (kind === "filled")
    return { borderColor: "var(--primary)", color: "var(--primary)", background: "var(--secondary)" };
  if (kind === "active")
    return {
      borderColor: "var(--ring)",
      color: "var(--primary)",
      background: "var(--secondary)",
      boxShadow: "0 0 0 3px color-mix(in srgb, var(--ring) 16%, transparent)",
    };
  return { borderColor: "var(--input)", color: "var(--muted-foreground)", background: "transparent" };
}

export function PinPad({
  value,
  onChange,
  onSubmit,
  disabled,
  shake,
  maxLength = PIN_LENGTH,
  status = "idle",
  reveal = false,
}: PinPadProps) {
  const locked = Boolean(disabled) || status === "success";

  const input = (next: string) => {
    onChange(next);
    if (next.length === maxLength) {
      // Auto-submit on the last digit (Video 2). Parent state may lag, so pass it directly.
      queueMicrotask(() => onSubmit(next));
    }
  };

  const press = (key: string) => {
    if (locked) return;
    if (key === "clear") return onChange("");
    if (key === "back") return onChange(value.slice(0, -1));
    if (value.length < maxLength) input(value + key);
  };

  // Physical keyboard entry — unless the cursor is in a text field (e.g. the username).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (locked) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key >= "0" && e.key <= "9") {
        if (value.length < maxLength) {
          e.preventDefault();
          input(value + e.key);
        }
      } else if (e.key === "Backspace") {
        e.preventDefault();
        onChange(value.slice(0, -1));
      } else if (e.key === "Escape") {
        onChange("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="space-y-5">
      {/* PIN tiles */}
      <div className={cn("flex items-center justify-center gap-2", shake && "animate-shake")}>
        {Array.from({ length: maxLength }).map((_, i) => {
          const filled = i < value.length;
          const kind: "empty" | "active" | "filled" = filled
            ? "filled"
            : i === value.length && status === "idle" && !locked
              ? "active"
              : "empty";
          return (
            <div
              key={i}
              className="relative grid h-12 w-11 place-items-center rounded-[12px] border-[1.5px] text-xl font-semibold transition-colors"
              style={tileStyle(kind, status)}
            >
              {filled && (
                <motion.span
                  key={reveal ? `d-${value[i]}` : "mask"}
                  initial={{ scale: 0.2, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 520, damping: 26 }}
                >
                  {reveal ? (
                    value[i]
                  ) : (
                    <span className="block h-2.5 w-2.5 rounded-full" style={{ background: "currentColor" }} />
                  )}
                </motion.span>
              )}
              {kind === "active" && (
                <motion.span
                  className="absolute bottom-2 h-[2px] w-5 rounded-full"
                  style={{ background: "var(--ring)" }}
                  animate={{ opacity: [1, 0.25, 1] }}
                  transition={{ duration: 1.1, repeat: Infinity }}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Keypad */}
      <div className="grid grid-cols-3 gap-2">
        {KEYS.map((key) => {
          if (key === "clear")
            return (
              <motion.button
                key={key}
                type="button"
                disabled={locked}
                whileTap={{ scale: 0.95 }}
                onClick={() => press(key)}
                className="h-12 rounded-[12px] text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-40"
              >
                Clear
              </motion.button>
            );
          return (
            <motion.button
              key={key}
              type="button"
              disabled={locked}
              whileTap={{ scale: 0.95 }}
              onClick={() => press(key)}
              className="grid h-12 place-items-center rounded-[12px] bg-secondary text-lg font-semibold text-foreground transition hover:brightness-[0.96] disabled:opacity-40"
            >
              {key === "back" ? <Delete className="h-5 w-5" /> : key}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}

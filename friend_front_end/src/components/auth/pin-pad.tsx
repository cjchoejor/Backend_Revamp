"use client";

import { motion } from "framer-motion";
import { Delete } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PIN_LENGTH } from "@/lib/auth/constants";

type PinPadProps = {
  value: string;
  onChange: (value: string) => void;
  /** Called with the full PIN when the last digit is entered */
  onSubmit: (completedPin: string) => void;
  disabled?: boolean;
  shake?: boolean;
  maxLength?: number;
};

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"];

export function PinPad({
  value,
  onChange,
  onSubmit,
  disabled,
  shake,
  maxLength = PIN_LENGTH,
}: PinPadProps) {
  const handleKey = (key: string) => {
    if (disabled) return;
    if (key === "clear") {
      onChange("");
      return;
    }
    if (key === "back") {
      onChange(value.slice(0, -1));
      return;
    }
    if (value.length < maxLength) {
      const next = value + key;
      onChange(next);
      if (next.length === maxLength) {
        // Pass completed PIN directly — parent state may not have updated yet
        queueMicrotask(() => onSubmit(next));
      }
    }
  };

  return (
    <div className={cn("space-y-6", shake && "animate-shake")}>
      <div className="flex justify-center gap-3">
        {Array.from({ length: maxLength }).map((_, i) => (
          <motion.div
            key={i}
            initial={false}
            animate={{ scale: i < value.length ? 1.1 : 1 }}
            className={cn(
              "h-3 w-3 rounded-full border-2 transition-colors",
              i < value.length ? "border-primary bg-primary" : "border-muted-foreground/40 bg-transparent",
            )}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {KEYS.map((key) => (
          <Button
            key={key}
            type="button"
            variant={key === "clear" ? "ghost" : "outline"}
            size="lg"
            disabled={disabled}
            className="h-14 text-lg font-medium"
            onClick={() => handleKey(key)}
          >
            {key === "back" ? <Delete className="h-5 w-5" /> : key === "clear" ? "Clear" : key}
          </Button>
        ))}
      </div>
    </div>
  );
}

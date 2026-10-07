"use client";

/**
 * The desk's toasts — sonner's own `toast`, with one addition: every message it shows is also
 * sent to the second screen (2026-10-07), so the board's Problems and Changes columns hear what
 * the operator was just told. Import `toast` from here, never from "sonner" directly; the API is
 * identical.
 */
import { toast as sonner, type ExternalToast } from "sonner";
import { publishNotice, type NoticeTone } from "@/lib/ds/second-screen/channel";

type Message = Parameters<typeof sonner>[0];

function asText(m: unknown): string {
  if (typeof m === "string") return m;
  if (typeof m === "number") return String(m);
  return "";
}

function mirror(tone: NoticeTone, message: Message, data?: ExternalToast) {
  const text = asText(typeof message === "function" ? null : message);
  if (!text) return;
  const detail = asText(data?.description);
  publishNotice({ tone, text, detail: detail || undefined, source: "toast" });
}

function base(message: Message, data?: ExternalToast) {
  mirror("info", message, data);
  return sonner(message, data);
}

export const toast = Object.assign(base, sonner, {
  success: (message: Message, data?: ExternalToast) => {
    mirror("success", message, data);
    return sonner.success(message, data);
  },
  info: (message: Message, data?: ExternalToast) => {
    mirror("info", message, data);
    return sonner.info(message, data);
  },
  warning: (message: Message, data?: ExternalToast) => {
    mirror("warning", message, data);
    return sonner.warning(message, data);
  },
  error: (message: Message, data?: ExternalToast) => {
    mirror("error", message, data);
    return sonner.error(message, data);
  },
}) as typeof sonner;

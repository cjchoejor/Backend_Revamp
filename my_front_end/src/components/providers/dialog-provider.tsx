"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "danger";
};

type PromptOptions = {
  title: string;
  message?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  inputType?: "text" | "password";
  minLength?: number;
  multiline?: boolean;
};

type DialogState =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (value: string | null) => void }
  | null;

type DialogContextValue = {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
};

const DialogContext = createContext<DialogContextValue | null>(null);

export function useConfirm() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useConfirm must be used inside <DialogProvider>");
  return ctx.confirm;
}

export function usePrompt() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("usePrompt must be used inside <DialogProvider>");
  return ctx.prompt;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>(null);
  const [promptValue, setPromptValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => setMounted(true), []);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setError(null);
      setState({ kind: "confirm", options, resolve });
    });
  }, []);

  const prompt = useCallback((options: PromptOptions) => {
    return new Promise<string | null>((resolve) => {
      setPromptValue(options.initialValue ?? "");
      setError(null);
      setState({ kind: "prompt", options, resolve });
    });
  }, []);

  // Focus the input / primary button when a dialog opens.
  useEffect(() => {
    if (!state) return;
    const t = setTimeout(() => {
      if (state.kind === "prompt") inputRef.current?.focus();
    }, 30);
    return () => clearTimeout(t);
  }, [state]);

  // ESC closes (resolves to cancel).
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (state.kind === "confirm") state.resolve(false);
        else state.resolve(null);
        setState(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  const close = (result: boolean | string | null) => {
    if (!state) return;
    if (state.kind === "confirm") state.resolve(typeof result === "boolean" ? result : false);
    else state.resolve(typeof result === "string" ? result : null);
    setState(null);
    setError(null);
  };

  const onConfirmPrompt = () => {
    if (state?.kind !== "prompt") return;
    const trimmed = promptValue.trim();
    if (state.options.minLength !== undefined && trimmed.length < state.options.minLength) {
      setError(`Must be at least ${state.options.minLength} characters`);
      return;
    }
    close(promptValue);
  };

  const dialog =
    state &&
    (() => {
      const isPrompt = state.kind === "prompt";
      const opts = state.options as ConfirmOptions & PromptOptions;
      const confirmVariant = (state.kind === "confirm" && state.options.variant) || "default";
      const inputBase =
        "w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
      const btnBase =
        "inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
      const confirmBtnClass =
        confirmVariant === "danger"
          ? `${btnBase} bg-destructive text-white shadow-sm hover:opacity-90`
          : `${btnBase} bg-primary text-primary-foreground shadow hover:opacity-90`;
      const cancelBtnClass = `${btnBase} border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground`;
      return (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm animate-in fade-in duration-150"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close(isPrompt ? null : false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            className="w-full max-w-md rounded-lg border border-border bg-card text-card-foreground shadow-2xl animate-in zoom-in-95 duration-150"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="space-y-4 p-6">
              <div className="space-y-1.5">
                <h2 id="dialog-title" className="text-lg font-semibold leading-none tracking-tight">
                  {opts.title}
                </h2>
                {opts.message && (
                  <p className="text-sm text-muted-foreground leading-relaxed">{opts.message}</p>
                )}
              </div>

              {isPrompt && !state.options.multiline && (
                <input
                  ref={(el) => { inputRef.current = el; }}
                  type={state.options.inputType ?? "text"}
                  className={inputBase}
                  placeholder={state.options.placeholder}
                  value={promptValue}
                  onChange={(e) => {
                    setPromptValue(e.target.value);
                    if (error) setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onConfirmPrompt();
                    }
                  }}
                />
              )}
              {isPrompt && state.options.multiline && (
                <textarea
                  ref={(el) => { inputRef.current = el; }}
                  className={`${inputBase} min-h-[100px] resize-y`}
                  placeholder={state.options.placeholder}
                  value={promptValue}
                  onChange={(e) => {
                    setPromptValue(e.target.value);
                    if (error) setError(null);
                  }}
                />
              )}
              {error && <p className="text-xs text-destructive">{error}</p>}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  className={cancelBtnClass}
                  onClick={() => close(isPrompt ? null : false)}
                >
                  {opts.cancelLabel ?? "Cancel"}
                </button>
                <button
                  type="button"
                  className={confirmBtnClass}
                  onClick={() => {
                    if (isPrompt) onConfirmPrompt();
                    else close(true);
                  }}
                >
                  {opts.confirmLabel ?? (confirmVariant === "danger" ? "Delete" : "Confirm")}
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    })();

  return (
    <DialogContext.Provider value={{ confirm, prompt }}>
      {children}
      {mounted && dialog && createPortal(dialog, document.body)}
    </DialogContext.Provider>
  );
}

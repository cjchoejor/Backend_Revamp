"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState, type ReactNode } from "react";
import { Toaster } from "sonner";
import { SessionProvider } from "./session-provider";
import { DialogProvider } from "./dialog-provider";

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // 5-minute stale window: admin config doesn't change minute-to-minute, and pages that
            // need fresh reads after their own mutation already call queryClient.invalidateQueries.
            // Keeps tab switches near-instant on warm pages.
            staleTime: 5 * 60_000,
            // Keep cached data for 30 min after the last component unmounts, so navigating away
            // and back doesn't force a refetch even past the stale window.
            gcTime: 30 * 60_000,
            // Don't refetch when the browser tab regains focus — admin sessions are long and the
            // automatic refetch was forcing a network hit every time the user alt-tabbed.
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <DialogProvider>
            {children}
            <Toaster richColors position="top-right" closeButton />
          </DialogProvider>
        </SessionProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

"use client";

import { createContext, useContext } from "react";

/**
 * Signal that surrounding code is rendering inside the unified booking flow page
 * (BookingFlow at /inquiries/new). Components that would normally trigger a router.push
 * to the next stage workspace consult this context and stay put — the orchestrator
 * page advances steps inline instead.
 */
type BookingFlowContextValue = { isEmbedded: true };

const BookingFlowContext = createContext<BookingFlowContextValue | null>(null);

export function BookingFlowProvider({ children }: { children: React.ReactNode }) {
  return <BookingFlowContext.Provider value={{ isEmbedded: true }}>{children}</BookingFlowContext.Provider>;
}

export function useIsInBookingFlow(): boolean {
  return !!useContext(BookingFlowContext);
}

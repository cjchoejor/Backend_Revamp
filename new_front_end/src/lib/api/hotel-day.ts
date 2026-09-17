import type { Session } from "@/types/session";
import { apiRequest } from "./client";

/**
 * The hotel's own calendar day, as the server sees it (`GET /api/lookups/hotel-day`).
 *
 * All three dates are `YYYY-MM-DD` on the hotel's calendar (`timezone`, Asia/Thimphu by default)
 * — the same format an `<input type="date">` uses, so they drop straight into `min` / `max`.
 */
export type HotelDay = {
  timezone: string;
  today: string;
  yesterday: string;
  tomorrow: string;
  /** The server's clock when it answered. */
  now: string;
};

export async function getHotelDay(session: Session) {
  return apiRequest<HotelDay>("/api/lookups/hotel-day", { session });
}

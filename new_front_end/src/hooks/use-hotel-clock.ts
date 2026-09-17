"use client";

import { useEffect, useRef, useState } from "react";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { HOTEL_TZ_DEFAULT } from "@/lib/ds/format";

/**
 * The hotel clock for the bar and for countdowns (SS00 §6).
 *
 * It ticks locally but is anchored to the server: the offset between the server's `now` and this
 * machine's clock is taken from the hotel-day read and applied to every tick, so a desk machine
 * with a wrong clock still shows the hotel's time, in the hotel's zone. Until the server has
 * answered, the machine's own clock is used — for display only; nothing is decided on it.
 */
export function useHotelClock(stepMs = 1000): { now: number; tz: string; known: boolean } {
  const day = useHotelDay();
  const offsetRef = useRef(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!day?.now) return;
    const server = new Date(day.now).getTime();
    if (Number.isFinite(server)) offsetRef.current = server - Date.now();
  }, [day?.now]);

  useEffect(() => {
    const tick = () => setNow(Date.now() + offsetRef.current);
    tick();
    const id = setInterval(tick, stepMs);
    return () => clearInterval(id);
  }, [stepMs]);

  return { now, tz: day?.timezone ?? HOTEL_TZ_DEFAULT, known: !!day };
}

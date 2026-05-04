import { createTimerEngine, type TimerEngine } from "../lib/timer-engine.js";

let enginePromise: Promise<TimerEngine> | null = null;

export async function getTimerEngine(): Promise<TimerEngine> {
  if (enginePromise) return enginePromise;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  enginePromise = (async () => {
    const engine = createTimerEngine(connectionString);
    await engine.start();
    return engine;
  })();
  return enginePromise;
}


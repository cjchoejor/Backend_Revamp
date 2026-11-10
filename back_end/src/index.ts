import cors from "cors";
import express from "express";
import { AppError } from "./lib/errors.js";
import { apiRouter } from "./routes/api-router.js";
import { startWorkers } from "./workers/runner.js";
import { flushOutbox, outboxSize, sendEmailsAfterAnswer } from "./lib/outbox.js";

// Emails go out right after the desk's answer, not inside it (2026-11-10): see lib/outbox.ts.
sendEmailsAfterAnswer(true);

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api", apiRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.status).json(err.body);
    return;
  }
  console.error(err);
  res.status(500).json({ error: "InternalError", message: "Unexpected server error" });
});

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";
app.listen(port, host, () => {
  console.log(`PMS API listening on http://localhost:${port}/api (bind ${host})`);
  if (host === "0.0.0.0") {
    console.log("  LAN devices use the front-end URL only; /api is proxied by Next.js rewrites.");
  }
});

// An email still on its way is let finish before the server stops (up to 15 seconds).
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    const n = outboxSize();
    if (n) console.log(`[outbox] ${n} email${n === 1 ? "" : "s"} still on the way — waiting before stopping`);
    void flushOutbox(15_000).finally(() => process.exit(0));
  });
}

if (process.env.RUN_WORKERS === "true") {
  startWorkers().then(
    () => console.log("Workers started (pg-boss)."),
    (e) => console.error("Failed to start workers", e),
  );
}

import cors from "cors";
import express from "express";
import { AppError } from "./lib/errors.js";
import { apiRouter } from "./routes/api-router.js";
import { startWorkers } from "./workers/runner.js";

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

if (process.env.RUN_WORKERS === "true") {
  startWorkers().then(
    () => console.log("Workers started (pg-boss)."),
    (e) => console.error("Failed to start workers", e),
  );
}

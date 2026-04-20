import cors from "cors";
import express from "express";
import { AppError } from "./lib/errors.js";
import { s5Router } from "./routes/s5-routes.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api", s5Router);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.status).json(err.body);
    return;
  }
  console.error(err);
  res.status(500).json({ error: "InternalError", message: "Unexpected server error" });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`PMS API (S5 + S6) listening on http://localhost:${port}/api`);
});

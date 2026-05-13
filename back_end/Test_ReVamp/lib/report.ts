import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BACK_END_ROOT = path.join(__dirname, "..", "..");

export type ScenarioCheck = {
  id: string;
  title: string;
  pass: boolean;
  httpStatus: number;
  response: unknown;
  explanation: string;
  dbImpact: string;
};

export type ScenarioReport = {
  meta: {
    stage: string;
    scenarioName: string;
    reference: string;
    generatedAt: string;
    apiBaseUrl: string;
    apiAvailable: boolean;
  };
  summary: {
    passed: number;
    total: number;
    allPassed: boolean;
  };
  checks: ScenarioCheck[];
};

export function stageDir(stageNumber: number): string {
  return path.join(BACK_END_ROOT, "Test_ReVamp", `stage-${stageNumber}`);
}

export function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/** Writes one JSON report per scenario under `Test_ReVamp/stage-N/<scenarioName>.json` */
export function writeScenarioReport(stageNumber: number, scenarioName: string, report: ScenarioReport) {
  const dir = stageDir(stageNumber);
  ensureDir(dir);
  const safe = scenarioName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "scenario";
  const file = path.join(dir, `${safe}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
  return file;
}

export function writeStageIndex(stageNumber: number, index: { stage: string; scenarioFiles: string[]; note?: string }) {
  const dir = stageDir(stageNumber);
  ensureDir(dir);
  const file = path.join(dir, "index.json");
  fs.writeFileSync(file, JSON.stringify(index, null, 2), "utf8");
  return file;
}

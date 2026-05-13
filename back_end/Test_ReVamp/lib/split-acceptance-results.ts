import type { ScenarioCheck, ScenarioReport } from "./report.js";
import { writeScenarioReport, writeStageIndex } from "./report.js";

/** Normalized row from `scripts/sN-acceptance-tests.ts` (`steps` or `results`). */
export type LooseCase = {
  id: string;
  title: string;
  pass: boolean;
  status?: number;
  body?: unknown;
  notes?: string;
  explanation?: string;
  dbImpact?: string;
};

export function slugFromCaseId(id: string): string {
  const s = id
    .toLowerCase()
    .replace(/[/\\:*?"<>|]+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "case";
}

/**
 * Writes one `Test_ReVamp/stage-N/<slug>.json` per case (deduplicates slug with `-2`, `-3`, …).
 */
export function writePerCaseScenarioReports(
  stageNumber: number,
  stageLabel: string,
  reference: string,
  baseUrl: string,
  apiAvailable: boolean,
  cases: LooseCase[],
): string[] {
  const scenarioFiles: string[] = [];
  const slugCounts = new Map<string, number>();

  for (const c of cases) {
    const baseSlug = slugFromCaseId(c.id);
    const n = (slugCounts.get(baseSlug) ?? 0) + 1;
    slugCounts.set(baseSlug, n);
    const slug = n === 1 ? baseSlug : `${baseSlug}-${n}`;

    const checks: ScenarioCheck[] = [
      {
        id: c.id,
        title: c.title,
        pass: !!c.pass,
        httpStatus: typeof c.status === "number" ? c.status : c.pass ? 200 : 500,
        response: c.body ?? (c.notes ? { notes: c.notes } : null),
        explanation: c.explanation ?? c.notes ?? "",
        dbImpact: c.dbImpact ?? "See acceptance script / traces for persisted tables.",
      },
    ];

    const report: ScenarioReport = {
      meta: {
        stage: stageLabel,
        scenarioName: slug,
        reference,
        generatedAt: new Date().toISOString(),
        apiBaseUrl: baseUrl,
        apiAvailable,
      },
      summary: {
        passed: c.pass ? 1 : 0,
        total: 1,
        allPassed: !!c.pass,
      },
      checks,
    };

    writeScenarioReport(stageNumber, slug, report);
    scenarioFiles.push(`${slug}.json`);
  }

  writeStageIndex(stageNumber, {
    stage: stageLabel,
    scenarioFiles,
    note: "One JSON file per acceptance case (`id`). Produced after delegated script run.",
  });

  return scenarioFiles;
}

export function parseJsonStdout(stdout: string): unknown {
  const t = stdout.trim();
  if (!t) throw new Error("Empty stdout from acceptance script");
  return JSON.parse(t) as unknown;
}

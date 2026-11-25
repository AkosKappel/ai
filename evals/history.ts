// The weekly eval results the Worker serves at GET /evals, for the portfolio's /assistant page.

export type ModelResult = {
  model: string;
  cases: number;
  answered: number;
  passed: number;
  /** Rate limits and timeouts; left out of the pass rate. */
  errors: number;
  /** Answers that ended with the follow-up questions line. */
  followUps: number;
};
export type EvalRun = { date: string; models: ModelResult[]; pagesPicked: number };
export type History = { note: string; runs: EvalRun[] };

// A year of weekly runs is plenty for a trend and keeps the Worker bundle small.
const MAX_RUNS = 52;

/** Adds a run, replacing one from the same day, and keeps the newest MAX_RUNS. */
export function appendRun(history: History, run: EvalRun): History {
  const runs = [...history.runs.filter((r) => r.date !== run.date), run].slice(-MAX_RUNS);
  return { ...history, runs };
}

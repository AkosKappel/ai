// Asks every eval case of every model directly (no fallback) and reports a pass rate per model.
//
//   pnpm eval                          all models, all cases
//   pnpm eval --model gemini           models whose provider/model contains "gemini" (repeatable)
//   pnpm eval --case salary            cases whose id contains "salary"
//   pnpm eval --knowledge <url|file>   instead of KNOWLEDGE_URL, e.g. a local portfolio
//   pnpm eval --full                   the whole knowledge for every case, without page picking
//   pnpm eval --record <file>          also append the results to a history file (the weekly run
//                                      records to evals/history.json, which GET /evals serves)
//
// Each case's prompt is built once, like the Worker does (a page picker first), and every model
// answers from the same prompt.
//
// Secrets come from .dev.vars (CI writes it from GitHub secrets). Workers AI runs through
// Wrangler's platform proxy, so it needs `wrangler login` locally or CLOUDFLARE_API_TOKEN in CI.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { getPlatformProxy } from "wrangler";
import { prepareAnswer } from "../src/context";
import { cooldowns, MODELS, type Model, PAGE_PICKERS, ProviderError } from "../src/models";
import { sseToText } from "../src/stream";
import rawCases from "./cases.json";
import { caseMessages, checkAnswer, type EvalCase, splitFollowUps } from "./check";
import { appendRun, type History } from "./history";

const PASS_RATE_GATE = 0.9;
const ATTEMPTS = 4;
const ANSWER_TIMEOUT_MS = 60_000;
const MAX_ERRORS_IN_A_ROW = 3;

const { values: args } = parseArgs({
  options: {
    model: { type: "string", multiple: true },
    case: { type: "string" },
    knowledge: { type: "string" },
    full: { type: "boolean" },
    record: { type: "string" },
  },
});

const cases = (rawCases as EvalCase[]).filter((c) => !args.case || c.id.includes(args.case));
const models = MODELS.filter(
  (m) => !args.model || args.model.some((filter) => `${m.provider}/${m.model}`.includes(filter)),
);
const name = (model: Model) => `${model.provider}/${model.model}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Result = { id: string; answer?: string; failures: string[]; error?: string };

async function loadKnowledge(source: string) {
  if (existsSync(source)) return readFileSync(source, "utf8");
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Knowledge ${source} responded with ${response.status}`);
  return response.text();
}

// Free tiers rate-limit hard (Groq allows about one question a minute), so a 429 or a busy
// provider waits and retries instead of counting as a wrong answer.
async function ask(model: Model, env: Env, system: string, evalCase: EvalCase): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const signal = AbortSignal.timeout(ANSWER_TIMEOUT_MS);
      const body = await model.open(env, { system, messages: caseMessages(evalCase), signal });
      return await new Response(sseToText(body)).text();
    } catch (cause) {
      if (attempt >= ATTEMPTS) throw cause;
      const retryAfter = cause instanceof ProviderError ? cause.retryAfterSeconds : undefined;
      await sleep(Math.min(retryAfter ?? 20, 90) * 1000);
    }
  }
}

async function evaluate(model: Model, env: Env, systems: Map<string, string>): Promise<Result[]> {
  const results: Result[] = [];
  let errorsInARow = 0;
  for (const evalCase of cases) {
    // A model whose daily quota ran out would otherwise retry every remaining case for minutes.
    if (errorsInARow >= MAX_ERRORS_IN_A_ROW) {
      results.push({ id: evalCase.id, failures: [], error: "skipped, quota likely used up" });
      continue;
    }
    const system = systems.get(evalCase.id) ?? "";
    try {
      const answer = await ask(model, env, system, evalCase);
      results.push({ id: evalCase.id, answer, failures: checkAnswer(answer, evalCase) });
      errorsInARow = 0;
    } catch (cause) {
      results.push({ id: evalCase.id, failures: [], error: String(cause).slice(0, 160) });
      errorsInARow++;
    }
    process.stdout.write(".");
  }
  return results;
}

function summarize(model: Model, results: Result[]) {
  const answered = results.filter((r) => !r.error);
  const passed = answered.filter((r) => r.failures.length === 0);
  const rate = answered.length ? passed.length / answered.length : 0;
  // Follow-ups are a nicety, so they are counted but do not fail a case.
  const withFollowUps = answered.filter((r) => splitFollowUps(r.answer ?? "").followUps.length > 0);
  return {
    model: name(model),
    answered: answered.length,
    passed: passed.length,
    rate,
    followUps: withFollowUps.length,
    results,
  };
}

const { env, dispose } = await getPlatformProxy<Env>({ envFiles: [".dev.vars"] });
try {
  const knowledge = await loadKnowledge(args.knowledge ?? env.KNOWLEDGE_URL);
  const pickers = args.full ? [] : PAGE_PICKERS;
  const systems = new Map<string, string>();
  let picked = 0;
  for (const evalCase of cases) {
    // Cases are prepared back to back, far faster than visitors ask. Without this, one picker
    // timeout would send the next 30 seconds of cases down the whole-file path.
    cooldowns.clear();
    const { system, sources } = await prepareAnswer(
      knowledge,
      {
        messages: caseMessages(evalCase),
        locale: evalCase.locale ?? "en",
        mode: evalCase.mode ?? "chat",
        page: evalCase.page,
      },
      env,
      pickers,
    );
    systems.set(evalCase.id, system);
    if (sources.length) picked++;
  }

  console.log(
    `${cases.length} cases × ${models.length} models, knowledge ${knowledge.length} chars, pages picked for ${picked} cases`,
  );
  // Providers limit each model separately, so the models run in parallel and the cases of one
  // model one after another.
  const summaries = await Promise.all(
    models.map(async (model) => summarize(model, await evaluate(model, env, systems))),
  );
  console.log("\n");

  const lines = [
    "| Model | Passed | Rate | Errors | Follow-ups |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const s of summaries) {
    const errors = s.results.length - s.answered;
    lines.push(
      `| ${s.model} | ${s.passed}/${s.answered} | ${Math.round(s.rate * 100)} % | ${errors} | ${s.followUps}/${s.answered} |`,
    );
  }
  const details = summaries.flatMap((s) =>
    s.results
      .filter((r) => r.error || r.failures.length)
      .map((r) =>
        r.error
          ? `- **${s.model}** \`${r.id}\`: error, ${r.error}`
          : `- **${s.model}** \`${r.id}\`: ${r.failures.join("; ")}\n  > ${(r.answer ?? "").replace(/\s+/g, " ").slice(0, 240)}`,
      ),
  );
  const report = [...lines, "", details.length ? "Failures:" : "No failures.", "", ...details].join(
    "\n",
  );
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);

  if (args.record) {
    const history = JSON.parse(readFileSync(args.record, "utf8")) as History;
    const run = {
      date: new Date().toISOString().slice(0, 10),
      models: summaries.map((s) => ({
        model: s.model,
        cases: s.results.length,
        answered: s.answered,
        passed: s.passed,
        errors: s.results.length - s.answered,
        followUps: s.followUps,
      })),
      pagesPicked: picked,
    };
    writeFileSync(args.record, `${JSON.stringify(appendRun(history, run), null, 2)}\n`);
  }

  // The quality gate applies to the first model, which answers most questions in production.
  const first = summaries.find((s) => s.model === name(MODELS[0]));
  if (first && first.rate < PASS_RATE_GATE) {
    console.error(
      `\n${first.model} passed ${Math.round(first.rate * 100)} %, below the ${PASS_RATE_GATE * 100} % gate.`,
    );
    process.exitCode = 1;
  }
} finally {
  await dispose();
}

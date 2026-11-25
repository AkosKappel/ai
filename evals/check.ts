import type { ChatMessage, Locale } from "../src/chat";

/** A regular expression source, matched case-insensitively. A list matches when any entry does. */
export type Pattern = string | string[];

export type EvalCase = {
  id: string;
  /** Request locale, and the language the answer must be in. Defaults to English. */
  locale?: Locale;
  /** A single question, or a whole conversation ending with the visitor's message. */
  question?: string;
  messages?: ChatMessage[];
  /** Recruiter mode: the question is a job description. */
  mode?: "chat" | "recruiter";
  /** The page the visitor is reading, e.g. "/projects/skysense". */
  page?: string;
  /** Every pattern must match the answer. */
  includes?: Pattern[];
  /** No pattern may match the answer. */
  excludes?: string[];
};

// Common short words per language, used to spot an answer in the wrong language.
const STOPWORDS: Record<Locale, string[]> = {
  en: "the and is of in he his to a for with at on you that it not but i".split(" "),
  de: "und der die das ist er bei mit ein eine nicht sie auf für in als zu den".split(" "),
  sk: "a je v na sa pre ako s aj pracuje nie jeho som alebo pri od do".split(" "),
  cs: "a je v na se pro jako s i pracuje ne jeho jsem nebo při od do".split(" "),
  hu: "és a az egy hogy van is nem ő mint már vagy nál nél dolgozik".split(" "),
};

// Slovak and Czech share most short words, so letters only one of them uses tell them apart.
const LETTERS: Partial<Record<Locale, { required?: RegExp; forbidden?: RegExp }>> = {
  sk: { forbidden: /[ěřů]/i },
  cs: { required: /[ěřů]/i },
  hu: { required: /[áéíóöőúüű]/i },
};

/**
 * Whether the answer may be in the requested language. Lists of names ("Slovak (Native),
 * Hungarian (C2)") have few ordinary words, so this only rejects clear mistakes: an English
 * answer to a non-English question, or Slovak and Czech mixed up.
 */
export function detectsLanguage(answer: string, locale: Locale): boolean {
  if (locale === "en") return true;
  const words = new Set(answer.toLowerCase().split(/[^\p{L}]+/u));
  const hits = (l: Locale) => STOPWORDS[l].filter((word) => words.has(word)).length;
  if (hits("en") >= 4 && hits(locale) < 2) return false;
  const letters = LETTERS[locale];
  if (letters?.required && !letters.required.test(answer)) return false;
  if (letters?.forbidden?.test(answer)) return false;
  return true;
}

// Models write typographic hyphens and apostrophes ("Full‑Stack", "don’t"); patterns use ASCII.
const normalize = (text: string) =>
  text.replace(/[\u2010-\u2015\u2212]/g, "-").replace(/[\u2018\u2019\u02bc]/g, "'");

const matches = (answer: string, pattern: string) =>
  new RegExp(pattern, "iu").test(normalize(answer));

/**
 * Splits off the last line of follow-up questions (">> First? | Second?"), which the system
 * prompt asks for and the chat shows as buttons. The checks apply to the answer alone.
 */
export function splitFollowUps(answer: string): { text: string; followUps: string[] } {
  const lines = answer.trimEnd().split("\n");
  const last = lines.at(-1)?.match(/^\s*>>\s*(.+)$/);
  if (!last) return { text: answer, followUps: [] };
  const followUps = last[1]
    .split("|")
    .map((question) => question.trim())
    .filter(Boolean);
  return { text: lines.slice(0, -1).join("\n"), followUps };
}

/** Returns why the answer fails the case; an empty list means it passed. */
export function checkAnswer(fullAnswer: string, evalCase: EvalCase): string[] {
  const failures: string[] = [];
  const answer = splitFollowUps(fullAnswer).text;
  if (answer.trim() === "") return ["empty answer"];

  for (const pattern of evalCase.includes ?? []) {
    const options = Array.isArray(pattern) ? pattern : [pattern];
    if (!options.some((option) => matches(answer, option))) {
      failures.push(`missing ${options.join(" or ")}`);
    }
  }
  for (const pattern of evalCase.excludes ?? []) {
    if (matches(answer, pattern)) failures.push(`contains ${pattern}`);
  }

  const locale = evalCase.locale ?? "en";
  if (!detectsLanguage(answer, locale)) failures.push(`not in ${locale}`);

  return failures;
}

export function caseMessages(evalCase: EvalCase): ChatMessage[] {
  if (evalCase.messages) return evalCase.messages;
  if (evalCase.question) return [{ role: "user", content: evalCase.question }];
  throw new Error(`Case ${evalCase.id} has neither question nor messages`);
}

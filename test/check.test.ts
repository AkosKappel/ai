import { describe, expect, it } from "vitest";
import cases from "../evals/cases.json";
import { checkAnswer, detectsLanguage } from "../evals/check";

describe("checkAnswer", () => {
  const answer = "Ákos works at IGT Systems in Bratislava, where he builds apps with React.";

  it("passes when every pattern matches, case-insensitively", () => {
    expect(checkAnswer(answer, { id: "x", includes: ["igt", ["Vue", "react"]] })).toEqual([]);
  });

  it("reports missing and forbidden patterns", () => {
    expect(
      checkAnswer(answer, {
        id: "x",
        includes: ["Kotlin", ["Vue", "Angular"]],
        excludes: ["Bratislava"],
      }),
    ).toEqual(["missing Kotlin", "missing Vue or Angular", "contains Bratislava"]);
  });

  it("fails an empty answer", () => {
    expect(checkAnswer("  ", { id: "x" })).toEqual(["empty answer"]);
  });

  it("fails an answer in the wrong language", () => {
    expect(checkAnswer(answer, { id: "x", locale: "de" })).toEqual(["not in de"]);
  });

  it("matches typographic hyphens and apostrophes", () => {
    const typographic = "He is a Full\u2011Stack engineer, but I don\u2019t know his salary.";
    expect(checkAnswer(typographic, { id: "x", includes: ["full-stack", "n't"] })).toEqual([]);
  });
});

describe("detectsLanguage", () => {
  it("accepts answers in the requested language, including bare lists", () => {
    expect(detectsLanguage("Er arbeitet bei IGT Systems und ist Entwickler.", "de")).toBe(true);
    expect(detectsLanguage("Pracuje v IGT Systems a je full-stack vývojár.", "sk")).toBe(true);
    expect(detectsLanguage("Pracuje v IGT Systems a je full-stack vývojář.", "cs")).toBe(true);
    expect(detectsLanguage("Az IGT Systemsnél dolgozik.", "hu")).toBe(true);
    expect(detectsLanguage("Slovenčina (rodný jazyk), Maďarčina (C2)", "sk")).toBe(true);
  });

  it("rejects an English answer to a non-English question", () => {
    const english = "He works at IGT Systems and his main stack is React with TypeScript.";
    expect(detectsLanguage(english, "de")).toBe(false);
  });

  it("tells Slovak and Czech apart", () => {
    expect(detectsLanguage("Pracuje v IGT Systems a je vývojář.", "sk")).toBe(false);
    expect(
      detectsLanguage("Vyštudoval informatiku na Slovenskej technickej univerzite.", "cs"),
    ).toBe(false);
  });
});

describe("cases.json", () => {
  it("has unique ids, valid patterns and a question or conversation per case", () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of cases) {
      expect(Boolean(c.question) !== Boolean("messages" in c && c.messages), c.id).toBe(true);
      const patterns = [
        ...(c.includes ?? []).flat(),
        ...("excludes" in c ? (c.excludes ?? []) : []),
      ];
      for (const pattern of patterns) expect(() => new RegExp(pattern, "iu"), c.id).not.toThrow();
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareAnswer, sourcesHeader } from "../src/context";
import { cooldowns, type PagePicker } from "../src/models";
import { splitKnowledge, tableOfContents } from "../src/pages";

const KNOWLEDGE = `# Ákos Kappel

> Full-Stack Software Engineer based in Bratislava.

## Contact

- Contact form: https://akoskappel.dev/contact

## Experience

### Full-Stack Software Engineer, IGT Systems

Builds Core3.

## Projects

### SkySense (2025, personal)

Weather that answers questions. It uses Open-Meteo.

Stack: SvelteKit

Page: https://akoskappel.dev/projects/skysense

### Pokédex (2024, personal)

A Pokémon browser.

Page: https://akoskappel.dev/projects/pokedex
`;

const env = {} as Env;
const user = (content: string) => ({ role: "user" as const, content });
const picker = (pick: PagePicker["pick"]): PagePicker => ({ provider: "fake", model: "p", pick });

afterEach(() => {
  cooldowns.clear();
  vi.restoreAllMocks();
});

describe("splitKnowledge", () => {
  it("makes a page per section and per project, plus a project list", () => {
    const pages = splitKnowledge(KNOWLEDGE);
    expect(pages.map((p) => p.path)).toEqual([
      "/contact",
      "/experience",
      "/projects",
      "/projects/skysense",
      "/projects/pokedex",
    ]);
    expect(pages[3]).toMatchObject({
      title: "SkySense",
      summary: "Weather that answers questions.",
    });
    expect(pages[2].text).toContain(
      "- SkySense: Weather that answers questions. Stack: SvelteKit.",
    );
    expect(pages[2].text).toContain("- Pokédex: A Pokémon browser.");
    expect(pages[0].summary).toBe("Contact form");
    expect(tableOfContents(pages)).toContain(
      "/experience: Experience. Full-Stack Software Engineer, IGT Systems",
    );
  });

  it("takes paths from Page links and turns any section of linked entries into a list", () => {
    const pages = splitKnowledge(`# Jane Doe

## Who I am

Page: https://jane.example/

I grow vegetables.

## Writing

### Raised beds

How to build one.

Page: https://jane.example/blog/raised-beds
`);
    expect(pages.map(({ path, list }) => ({ path, list }))).toEqual([
      { path: "/", list: undefined },
      { path: "/blog", list: true },
      { path: "/blog/raised-beds", list: undefined },
    ]);
    expect(pages[1].text).toBe("## Writing\n\n- Raised beds: How to build one.");
  });
});

describe("prepareAnswer", () => {
  it("sends only the picked pages and the visitor's page, and names the picked ones as sources", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const pick = vi.fn<PagePicker["pick"]>(async () => ["/experience"]);
    const { system, sources } = await prepareAnswer(
      KNOWLEDGE,
      {
        messages: [user("Where does he work?")],
        locale: "en",
        mode: "chat",
        page: "/projects/pokedex",
      },
      env,
      [picker(pick)],
    );
    expect(system).toContain("Builds Core3.");
    expect(system).toContain("A Pokémon browser.");
    expect(system).toContain("Full-Stack Software Engineer based in Bratislava.");
    expect(system).not.toContain("Weather that answers questions.");
    expect(sources).toEqual([{ path: "/experience", title: "Experience" }]);
    expect(pick.mock.calls[0][1]).toMatchObject({
      paths: ["/contact", "/experience", "/projects", "/projects/skysense", "/projects/pokedex"],
    });
    expect(pick.mock.calls[0][1].system).toContain("the website of Ákos Kappel");
    expect(pick.mock.calls[0][1].system).toContain("the page that lists them all (/projects)");
  });

  it("falls back to the whole knowledge when no picker answers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = picker(async () => {
      throw new Error("down");
    });
    const { system, sources } = await prepareAnswer(
      KNOWLEDGE,
      { messages: [user("Hi")], locale: "en", mode: "chat" },
      env,
      [failing],
    );
    expect(system).toContain("Weather that answers questions.");
    expect(sources).toEqual([]);
    expect(cooldowns.get("fake/p")).toBeGreaterThan(Date.now());
  });

  it("compares a job description with everything in recruiter mode, without a picker", async () => {
    const pick = vi.fn<PagePicker["pick"]>(async () => ["/contact"]);
    const { system } = await prepareAnswer(
      KNOWLEDGE,
      { messages: [user("We need SvelteKit.")], locale: "en", mode: "recruiter" },
      env,
      [picker(pick)],
    );
    expect(system).toContain("pasted a job description");
    expect(system).toContain("Weather that answers questions.");
    expect(pick).not.toHaveBeenCalled();
  });
});

describe("sourcesHeader", () => {
  it("encodes titles with non-ASCII letters", () => {
    const header = sourcesHeader([{ path: "/projects/pokedex", title: "Pokédex" }]);
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(JSON.parse(decodeURIComponent(header))).toEqual([
      { path: "/projects/pokedex", title: "Pokédex" },
    ]);
  });
});

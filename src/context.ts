import { buildRecruiterPrompt, buildSystemPrompt, type ChatRequest, siteName } from "./chat";
import { MAX_PAGES, type PagePicker, pickPages } from "./models";
import { introduction, type Page, pagesText, splitKnowledge, tableOfContents } from "./pages";

export type Source = Pick<Page, "path" | "title">;
export type Prepared = { system: string; sources: Source[] };

function pickerPrompt(name: string, pages: Page[], page?: string) {
  const where = page ? `\nThe visitor is reading the page ${page}.\n` : "";
  const lists = pages.filter((p) => p.list).map((p) => p.path);
  const across = lists.length
    ? `For questions across several entries (a technology, a kind of project), choose the page that lists them all (${lists.join(", ")}) and any page about jobs or work experience. `
    : "";
  return `You choose which pages of the website of ${name} an assistant needs to answer the visitor's last message, taking the conversation into account. Call get_pages with 1 to ${MAX_PAGES} paths.

Pages:
${tableOfContents(pages)}
${where}
${across}For greetings, thanks, off-topic or unclear messages, choose the page that introduces ${name}. For ways to get in touch, spoken languages or availability, choose the page with the contact details.`;
}

/**
 * Builds the system prompt for one request. A chat question first goes to a page picker (a
 * function call), and the answer then sees only the picked pages and the page the visitor is
 * on, which costs a fraction of the whole file. The picked pages are the answer's sources.
 * Recruiter mode compares a job description with everything, so it skips the picker; so does
 * a question no picker could handle.
 */
export async function prepareAnswer(
  knowledge: string,
  chat: Pick<ChatRequest, "messages" | "locale" | "mode" | "page">,
  env: Env,
  pickers: PagePicker[],
): Promise<Prepared> {
  if (chat.mode === "recruiter") {
    return { system: buildRecruiterPrompt(knowledge, chat.locale), sources: [] };
  }

  const pages = splitKnowledge(knowledge);
  const current = pages.find((page) => page.path === chat.page);
  const page = chat.page ? { path: chat.page, title: current?.title } : undefined;
  const picked = pages.length
    ? await pickPages(
        pickers,
        env,
        pickerPrompt(siteName(knowledge), pages, chat.page),
        chat.messages,
        pages.map((p) => p.path),
      )
    : undefined;
  if (!picked) return { system: buildSystemPrompt(knowledge, chat.locale, { page }), sources: [] };

  const paths = new Set(current ? [current.path, ...picked.paths] : picked.paths);
  const text = `${introduction(knowledge)}\n\n${pagesText(pages, paths)}`;
  return {
    system: buildSystemPrompt(text, chat.locale, { picked: true, page }),
    sources: pages
      .filter((p) => picked.paths.includes(p.path))
      .map(({ path, title }) => ({ path, title })),
  };
}

/** The sources as a header value: URL-encoded JSON, since titles can have non-ASCII letters. */
export const sourcesHeader = (sources: Source[]) => encodeURIComponent(JSON.stringify(sources));

// The knowledge file split into the site's pages, so a model can pick the ones a question needs
// (tool calling) instead of reading the whole file with every question.

export type Page = { path: string; title: string; summary: string; text: string };

// Top-level sections of /llms-full.txt and the pages of the site that show them.
const SECTION_PATHS: Record<string, string> = {
  contact: "/contact",
  about: "/about",
  experience: "/experience",
  education: "/education",
  skills: "/skills",
};

const PROJECT_PAGE = /^Page: https?:\/\/[^/\s]+(\/projects\/[\w-]+)$/m;

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");

/** Splits Markdown into blocks that start with a heading of the given level. */
function blocks(markdown: string, level: number) {
  const marker = `${"#".repeat(level)} `;
  const parts = markdown.split(new RegExp(`^(?=${marker})`, "m"));
  return parts
    .filter((part) => part.startsWith(marker))
    .map((part) => {
      const [heading, ...rest] = part.split("\n");
      return { heading: heading.slice(marker.length).trim(), body: rest.join("\n").trim(), part };
    });
}

/**
 * Every top-level section becomes one page, except Projects: each project becomes its own page
 * (found by its "Page:" link), plus `/projects` with a one-line list of all of them.
 */
export function splitKnowledge(markdown: string): Page[] {
  const pages: Page[] = [];
  for (const section of blocks(markdown, 2)) {
    if (slug(section.heading) === "projects") {
      const projects = blocks(section.body, 3).flatMap(({ heading, body, part }) => {
        const path = body.match(PROJECT_PAGE)?.[1];
        if (!path) return [];
        const title = heading.replace(/\s*\(.*\)$/, "");
        const summary = body.split("\n")[0].split(/(?<=\.)\s/)[0];
        const stack = body.match(/^Stack: (.+)$/m)?.[1];
        return [{ path, title, summary, stack, text: part.trim() }];
      });
      pages.push(
        {
          path: "/projects",
          title: section.heading,
          summary: "Every project with one line and its stack, for questions across projects",
          text: `## ${section.heading}\n\n${projects
            .map((p) => `- ${p.title}: ${p.summary}${p.stack ? ` Stack: ${p.stack}.` : ""}`)
            .join("\n")}`,
        },
        ...projects.map(({ stack: _, ...page }) => page),
      );
      continue;
    }
    // Sections without subheadings (Contact) are summed up by their list labels instead.
    const subheadings = blocks(section.body, 3).map((block) => block.heading);
    const labels = [...section.body.matchAll(/^- ([^:\n(]+)/gm)].map((match) => match[1].trim());
    const outline = subheadings.length ? subheadings : labels;
    pages.push({
      path: SECTION_PATHS[slug(section.heading)] ?? `/${slug(section.heading)}`,
      title: section.heading,
      summary: outline.length ? outline.join("; ") : section.heading,
      text: section.part.trim(),
    });
  }
  return pages;
}

/** The name and one-line summary at the top of the file, sent with every question. */
export const introduction = (markdown: string) => markdown.split(/^## /m)[0].trim();

/** One line per page, for the model to choose from. */
export const tableOfContents = (pages: Page[]) =>
  pages.map((page) => `${page.path}: ${page.title}. ${page.summary}`).join("\n");

/** The text of the chosen pages, in the order of the knowledge file. */
export const pagesText = (pages: Page[], paths: Set<string>) =>
  pages
    .filter((page) => paths.has(page.path))
    .map((page) => page.text)
    .join("\n\n");

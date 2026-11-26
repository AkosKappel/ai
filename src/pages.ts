// The knowledge file split into the site's pages, so a model can pick the ones a question needs
// (tool calling) instead of reading the whole file with every question.

export type Page = {
  path: string;
  title: string;
  summary: string;
  text: string;
  /** A list section: one line per item, each item also being a page of its own. */
  list?: boolean;
};

// A "Page: <url>" line links a section or an item to the page of the site that shows it.
const PAGE_LINK = /^Page: https?:\/\/[^/\s]+(\/[\w\-/]*)$/m;
const pagePath = (text: string) => text.match(PAGE_LINK)?.[1];
const parentPath = (path: string) => path.replace(/\/[^/]+$/, "");

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
 * Every top-level (##) section becomes one page, at its "Page:" link or else at
 * `/<heading slug>`. A section whose items (###) have their own "Page:" links is a list, like
 * the projects of a portfolio: each item becomes a page, and the section's page (by default the
 * items' parent path, `/projects`) lists them all in one line each.
 */
export function splitKnowledge(markdown: string): Page[] {
  const pages: Page[] = [];
  for (const section of blocks(markdown, 2)) {
    const ownPath = pagePath(section.body.split(/^### /m)[0]);
    const items = blocks(section.body, 3).flatMap(({ heading, body, part }) => {
      const path = pagePath(body);
      if (!path) return [];
      const title = heading.replace(/\s*\(.*\)$/, "");
      const summary = body.split("\n")[0].split(/(?<=\.)\s/)[0];
      const stack = body.match(/^Stack: (.+)$/m)?.[1];
      return [{ path, title, summary, stack, text: part.trim() }];
    });
    if (items.length) {
      pages.push(
        {
          path: ownPath ?? (parentPath(items[0].path) || `/${slug(section.heading)}`),
          title: section.heading,
          summary: "Every entry in one line, for questions across several of them",
          text: `## ${section.heading}\n\n${items
            .map((p) => `- ${p.title}: ${p.summary}${p.stack ? ` Stack: ${p.stack}.` : ""}`)
            .join("\n")}`,
          list: true,
        },
        ...items.map(({ stack: _, ...page }) => page),
      );
      continue;
    }
    // Sections without subheadings (Contact) are summed up by their list labels instead.
    const subheadings = blocks(section.body, 3).map((block) => block.heading);
    const labels = [...section.body.matchAll(/^- ([^:\n(]+)/gm)].map((match) => match[1].trim());
    const outline = subheadings.length ? subheadings : labels;
    pages.push({
      path: ownPath ?? `/${slug(section.heading)}`,
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

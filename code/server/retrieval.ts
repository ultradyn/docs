import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import MiniSearch from "minisearch";

import type { Citation } from "../shared/index.js";
import { resolveContainedPathNoSymlinks } from "../shared/safe-path.js";

interface DocumentationRecord {
  id: string;
  path: string;
  title: string;
  content: string;
}

export interface DocumentationMatch {
  answer: string;
  citations: Citation[];
}

export interface DocumentationContextEntry {
  path: string;
  title: string;
  content: string;
}

const stopWords = new Set([
  "about",
  "after",
  "does",
  "from",
  "handle",
  "have",
  "into",
  "that",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
]);

function tokens(value: string): string[] {
  return [
    ...new Set(
      value
        .toLocaleLowerCase()
        .match(/[a-z0-9][a-z0-9_-]{2,}/gu)
        ?.filter((token) => !stopWords.has(token)) ?? [],
    ),
  ];
}

async function markdownFiles(
  repositoryRoot: string,
  root: string,
): Promise<string[]> {
  const results: string[] = [];
  async function walk(directory: string) {
    const safeDirectory = await resolveContainedPathNoSymlinks(
      repositoryRoot,
      directory,
    );
    let entries;
    try {
      entries = await readdir(safeDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name.startsWith(".")) continue;
      const path = await resolveContainedPathNoSymlinks(
        repositoryRoot,
        join(safeDirectory, entry.name),
      );
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) results.push(path);
    }
  }
  await walk(root);
  return results;
}

function titleFor(content: string, path: string): string {
  const heading = /^#\s+(.+)$/mu.exec(content)?.[1]?.trim();
  return (
    heading || path.split("/").at(-1)?.replace(/\.md$/u, "") || "Documentation"
  );
}

function bestExcerpt(
  content: string,
  queryTokens: string[],
): { text: string; line: number } {
  const paragraphs = content
    .split(/\n\s*\n/gu)
    .map((text) => text.trim())
    .filter((text) => text.length > 0 && !/^#(?:#)?\s/u.test(text));
  const ranked = paragraphs
    .map((text, index) => ({
      text,
      index,
      matches: queryTokens.filter((token) =>
        text.toLocaleLowerCase().includes(token),
      ).length,
    }))
    .sort(
      (left, right) => right.matches - left.matches || left.index - right.index,
    );
  const text = ranked[0]?.text ?? content.trim();
  const character = content.indexOf(text);
  const line =
    character < 0 ? 1 : content.slice(0, character).split("\n").length;
  return { text: text.slice(0, 1_200), line };
}

export class DocumentationIndex {
  readonly #root: string;

  constructor(repositoryRoot: string) {
    this.#root = resolve(repositoryRoot);
  }

  async context(maxCharacters = 120_000): Promise<DocumentationContextEntry[]> {
    const records = await this.#records();
    const context: DocumentationContextEntry[] = [];
    let remaining = Math.max(0, maxCharacters);
    for (const record of records) {
      if (remaining === 0) break;
      const content = record.content.slice(0, remaining);
      context.push({ path: record.path, title: record.title, content });
      remaining -= content.length;
    }
    return context;
  }

  async answer(question: string): Promise<DocumentationMatch | undefined> {
    const queryTokens = tokens(question);
    if (queryTokens.length < 2) return undefined;
    const records = await this.#records();
    if (records.length === 0) return undefined;
    const index = new MiniSearch<DocumentationRecord>({
      fields: ["title", "content"],
      storeFields: ["path", "title", "content"],
    });
    index.addAll(records);
    const candidate = index.search(question, { prefix: true, fuzzy: 0.2 })[0];
    if (!candidate) return undefined;
    const content =
      typeof candidate.content === "string" ? candidate.content : "";
    const documentTokens = new Set(
      tokens(`${String(candidate.title ?? "")} ${content}`),
    );
    const matched = queryTokens.filter((token) => documentTokens.has(token));
    const coverage = matched.length / queryTokens.length;
    if (matched.length < 2 || coverage < 0.45) return undefined;
    const excerpt = bestExcerpt(content, queryTokens);
    return {
      answer: excerpt.text,
      citations: [
        {
          path: String(candidate.path),
          title: String(candidate.title),
          line: excerpt.line,
          excerpt: excerpt.text.slice(0, 240),
        },
      ],
    };
  }

  async #records(): Promise<DocumentationRecord[]> {
    const documentationRoot = await resolveContainedPathNoSymlinks(
      this.#root,
      join(this.#root, "docs"),
    );
    return Promise.all(
      (await markdownFiles(this.#root, documentationRoot)).map(async (path) => {
        const safePath = await resolveContainedPathNoSymlinks(this.#root, path);
        const content = await readFile(safePath, "utf8");
        const relativePath = relative(this.#root, safePath)
          .split(sep)
          .join("/");
        return {
          id: relativePath,
          path: relativePath,
          title: titleFor(content, relativePath),
          content,
        } satisfies DocumentationRecord;
      }),
    );
  }
}

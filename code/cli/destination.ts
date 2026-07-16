import path from "node:path";

const EFFECTIVELY_EMPTY_ENTRIES = new Set([".git", ".DS_Store", "Thumbs.db"]);

/** Returns the destination shown in the installer's first prompt. */
export function suggestDestination(
  cwd: string,
  entries: readonly string[],
): string {
  if (entries.every((entry) => EFFECTIVELY_EMPTY_ENTRIES.has(entry)))
    return ".";

  const base = path.basename(path.resolve(cwd));
  const sanitized = base
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const projectName = sanitized && sanitized !== "work" ? sanitized : "network";
  const suffix = projectName.endsWith("-docs") ? "" : "-docs";
  return `./${projectName}${suffix}`;
}

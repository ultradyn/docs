import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Monorepo source keeps portable seed content under `scaffold/`.
 * Generated/installed repositories flatten that content to the root.
 * Prefer the monorepo path when present so source-tree tests stay exact.
 */
export function isMonorepoSourceTree(repositoryRoot: string): boolean {
  return (
    existsSync(join(repositoryRoot, "scaffold", "agents")) ||
    existsSync(join(repositoryRoot, "scaffold", ".gitignore.template"))
  );
}

/** Resolve a path under monorepo `scaffold/` or the installed root layout. */
export function resolveShippedPath(
  repositoryRoot: string,
  ...relative: string[]
): string {
  const underScaffold = join(repositoryRoot, "scaffold", ...relative);
  if (existsSync(underScaffold)) return underScaffold;
  return join(repositoryRoot, ...relative);
}

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface BundleValidationReport {
  ok: boolean;
  schemaErrors: string[];
  brokenLinks: string[];
  cycles: string[][];
  forbiddenArtifacts: string[];
}

const forbiddenSuffixes = [".minisearch", ".sqlite", ".db", ".index"];
const markdownLink = /\[[^\]]*\]\(([^)]+)\)/g;

async function filesUnder(root: string): Promise<string[]> {
  const results: string[] = [];
  async function visit(relative: string): Promise<void> {
    const entries = await readdir(path.join(root, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.posix.join(
        relative.replaceAll(path.sep, "/"),
        entry.name,
      );
      if (entry.isSymbolicLink()) {
        results.push(child);
      } else if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile()) {
        results.push(child);
      }
    }
  }
  await visit("");
  return results.sort();
}

function taskCycles(
  tasks: Array<{ id: string; dependencies?: string[] }>,
): string[][] {
  const edges = new Map(
    tasks.map((task) => [task.id, [...(task.dependencies ?? [])].sort()]),
  );
  const cycles = new Set<string>();
  const visit = (node: string, stack: string[]): void => {
    const at = stack.indexOf(node);
    if (at >= 0) {
      const cycle = [...stack.slice(at), node];
      const rotations = cycle.slice(0, -1).map((_, index, values) => {
        const rotated = [...values.slice(index), ...values.slice(0, index)];
        return [...rotated, rotated[0]].join(" -> ");
      });
      const canonical = rotations.sort()[0];
      if (canonical) cycles.add(canonical);
      return;
    }
    for (const dependency of edges.get(node) ?? [])
      visit(dependency, [...stack, node]);
  };
  for (const node of [...edges.keys()].sort()) visit(node, []);
  return [...cycles].sort().map((cycle) => cycle.split(" -> "));
}

export async function validateIngestBundle(
  root: string,
): Promise<BundleValidationReport> {
  const absoluteRoot = path.resolve(root);
  const files = await filesUnder(absoluteRoot);
  const schemaErrors: string[] = [];
  const brokenLinks: string[] = [];
  const forbiddenArtifacts = files.filter((file) =>
    forbiddenSuffixes.some((suffix) => file.toLowerCase().endsWith(suffix)),
  );

  let tasks: Array<{ id: string; dependencies?: string[] }> = [];
  for (const file of files) {
    const absolute = path.resolve(absoluteRoot, file);
    if (!absolute.startsWith(`${absoluteRoot}${path.sep}`)) {
      schemaErrors.push(`${file}: escapes bundle root`);
      continue;
    }
    if (file.endsWith(".md")) {
      const content = await readFile(absolute, "utf8");
      for (const match of content.matchAll(markdownLink)) {
        const target = match[1]?.split("#", 1)[0];
        if (!target || /^[a-z]+:/i.test(target)) continue;
        const resolved = path.resolve(path.dirname(absolute), target);
        const relative = path
          .relative(absoluteRoot, resolved)
          .replaceAll(path.sep, "/");
        if (relative.startsWith("../") || !files.includes(relative)) {
          brokenLinks.push(`${file} -> ${target}`);
        }
      }
    }
    if (file === "tasks.json") {
      try {
        const parsed: unknown = JSON.parse(await readFile(absolute, "utf8"));
        if (!Array.isArray(parsed)) throw new Error("must be an array");
        tasks = parsed.map((item, index) => {
          if (
            !item ||
            typeof item !== "object" ||
            typeof (item as { id?: unknown }).id !== "string"
          ) {
            throw new Error(`tasks.${index}.id must be a string`);
          }
          const dependencies = (item as { dependencies?: unknown })
            .dependencies;
          if (
            dependencies !== undefined &&
            (!Array.isArray(dependencies) ||
              dependencies.some((value) => typeof value !== "string"))
          ) {
            throw new Error(`tasks.${index}.dependencies must be strings`);
          }
          return dependencies === undefined
            ? { id: (item as { id: string }).id }
            : {
                id: (item as { id: string }).id,
                dependencies: dependencies as string[],
              };
        });
      } catch (error) {
        schemaErrors.push(
          `tasks.json: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const cycles = taskCycles(tasks);
  schemaErrors.sort();
  brokenLinks.sort();
  forbiddenArtifacts.sort();
  return {
    ok:
      schemaErrors.length === 0 &&
      brokenLinks.length === 0 &&
      cycles.length === 0 &&
      forbiddenArtifacts.length === 0,
    schemaErrors,
    brokenLinks,
    cycles,
    forbiddenArtifacts,
  };
}

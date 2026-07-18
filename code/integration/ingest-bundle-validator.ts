import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import {
  validateIngestRecord,
  type IngestSchemaName,
} from "../domain/ingest/index.js";
import { validateIngestManifests } from "../agents/index.js";

export type FileKind = "file" | "directory" | "symlink";

export interface FileEntry {
  name: string;
  kind: FileKind;
}

export interface FileReader {
  list(directory: string): Promise<FileEntry[]>;
  readText(file: string): Promise<string>;
  readBytes(file: string): Promise<Uint8Array>;
}

async function readWithoutFollowing(file: string): Promise<Uint8Array> {
  const stat = await lstat(file);
  if (stat.isSymbolicLink()) throw new Error("symbolic links are forbidden");
  if (!stat.isFile()) throw new Error("not a regular file");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export const nodeFileReader: FileReader = {
  async list(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.isSymbolicLink()
        ? "symlink"
        : entry.isDirectory()
          ? "directory"
          : "file",
    }));
  },
  async readText(file) {
    return new TextDecoder().decode(await readWithoutFollowing(file));
  },
  readBytes: readWithoutFollowing,
};

export interface BundleValidationReport {
  ok: boolean;
  schemaErrors: string[];
  brokenLinks: string[];
  cycles: string[][];
  forbiddenArtifacts: string[];
}

const forbiddenSuffixes = [
  ".db",
  ".faiss",
  ".gz",
  ".minisearch",
  ".mp3",
  ".npy",
  ".npz",
  ".pyc",
  ".sqlite",
  ".sqlite3",
  ".tar",
  ".wav",
  ".zip",
];
const markdownLink = /!?\[[^\]]*\]\(([^)]+)\)/g;

interface CollectedEntry {
  relative: string;
  kind: FileKind;
}

function portable(relative: string): string {
  return relative.replaceAll(path.sep, "/");
}

function displayError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function collectEntries(
  root: string,
  io: FileReader,
  schemaErrors: string[],
): Promise<CollectedEntry[]> {
  const results: CollectedEntry[] = [];
  async function visit(relative: string): Promise<void> {
    const absolute = path.join(root, relative);
    let entries: FileEntry[];
    try {
      entries = await io.list(absolute);
    } catch (error) {
      schemaErrors.push(
        `${relative ? portable(relative) : "."}: ${displayError(error)}`,
      );
      return;
    }
    for (const entry of [...entries].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const child = path.join(relative, entry.name);
      const relativeChild = portable(child);
      results.push({ relative: relativeChild, kind: entry.kind });
      if (entry.kind === "symlink") {
        schemaErrors.push(`${relativeChild}: symbolic links are forbidden`);
      } else if (entry.kind === "directory") {
        await visit(child);
      }
    }
  }
  await visit("");
  return results.sort((a, b) => a.relative.localeCompare(b.relative));
}

function taskCycles(edges: Map<string, string[]>): string[][] {
  const cycles = new Set<string>();
  const visit = (node: string, stack: string[]): void => {
    const at = stack.indexOf(node);
    if (at >= 0) {
      const cycle = [...stack.slice(at), node];
      const nodes = cycle.slice(0, -1);
      const rotations = nodes.map((_, index) => {
        const rotated = [...nodes.slice(index), ...nodes.slice(0, index)];
        return [...rotated, rotated[0]].join(" -> ");
      });
      const canonical = rotations.sort()[0];
      if (canonical) cycles.add(canonical);
      return;
    }
    for (const dependency of edges.get(node) ?? []) {
      if (edges.has(dependency)) visit(dependency, [...stack, node]);
    }
  };
  for (const node of [...edges.keys()].sort()) visit(node, []);
  return [...cycles].sort().map((cycle) => cycle.split(" -> "));
}

function safeRelativePath(candidate: string): boolean {
  if (
    !candidate ||
    candidate.includes("\\") ||
    path.posix.isAbsolute(candidate)
  ) {
    return false;
  }
  const parts = candidate.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function validationMessages(result: unknown): string[] {
  if (result === undefined || result === null || result === true) return [];
  if (result === false) return ["validation failed"];
  if (Array.isArray(result)) return result.map(String);
  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (record.success === true || record.ok === true) return [];
    for (const key of ["schemaErrors", "errors", "issues"]) {
      const errors = record[key];
      if (Array.isArray(errors)) {
        return errors.map((error) =>
          typeof error === "string" ? error : JSON.stringify(error),
        );
      }
    }
    if (record.message !== undefined) return [String(record.message)];
    if (record.error !== undefined) return [displayError(record.error)];
  }
  return [JSON.stringify(result)];
}

async function parseJson(
  root: string,
  relative: string,
  io: FileReader,
  schemaErrors: string[],
): Promise<unknown | undefined> {
  try {
    return JSON.parse(await io.readText(path.join(root, relative)));
  } catch (error) {
    schemaErrors.push(`${relative}: ${displayError(error)}`);
    return undefined;
  }
}

async function validateTasks(
  root: string,
  io: FileReader,
  schemaErrors: string[],
): Promise<Map<string, string[]>> {
  const parsed = await parseJson(root, "tasks.json", io, schemaErrors);
  const edges = new Map<string, string[]>();
  if (parsed === undefined) return edges;
  if (!Array.isArray(parsed)) {
    schemaErrors.push("tasks.json: must be an array");
    return edges;
  }
  const rows: Array<{ index: number; id: string; dependencies: string[] }> = [];
  for (const [index, item] of parsed.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      schemaErrors.push(`tasks.json[${index}]: must be an object`);
      continue;
    }
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id.length === 0) {
      schemaErrors.push(`tasks.json[${index}].id: must be a non-empty string`);
      continue;
    }
    if (
      row.dependencies !== undefined &&
      (!Array.isArray(row.dependencies) ||
        row.dependencies.some((dependency) => typeof dependency !== "string"))
    ) {
      schemaErrors.push(
        `tasks.json[${index}].dependencies: must be an array of strings`,
      );
      continue;
    }
    if (edges.has(row.id)) {
      schemaErrors.push(
        `tasks.json[${index}].id: duplicate task ID ${JSON.stringify(row.id)}`,
      );
      continue;
    }
    const dependencies = (row.dependencies as string[] | undefined) ?? [];
    edges.set(row.id, [...dependencies].sort());
    rows.push({ index, id: row.id, dependencies });
  }
  for (const row of rows) {
    row.dependencies.forEach((dependency, dependencyIndex) => {
      if (!edges.has(dependency)) {
        schemaErrors.push(
          `tasks.json[${row.index}].dependencies[${dependencyIndex}]: unknown task ID ${JSON.stringify(dependency)}`,
        );
      }
    });
  }
  return edges;
}

async function validateRecords(
  root: string,
  io: FileReader,
  schemaErrors: string[],
): Promise<void> {
  const parsed = await parseJson(root, "records.json", io, schemaErrors);
  if (parsed === undefined) return;
  if (!Array.isArray(parsed)) {
    schemaErrors.push("records.json: must be an array");
    return;
  }
  for (const [index, item] of parsed.entries()) {
    const prefix = `records.json[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      schemaErrors.push(`${prefix}: must be an object`);
      continue;
    }
    const row = item as Record<string, unknown>;
    if (typeof row.schemaName !== "string") {
      schemaErrors.push(`${prefix}.schemaName: must be a string`);
      continue;
    }
    if (typeof row.version !== "number") {
      schemaErrors.push(`${prefix}.version: must be a number`);
      continue;
    }
    try {
      const result = validateIngestRecord(
        row.schemaName as IngestSchemaName,
        row.version as 1,
        row.value,
      );
      const messages = validationMessages(result);
      messages.forEach((message) => schemaErrors.push(`${prefix}: ${message}`));
    } catch (error) {
      schemaErrors.push(`${prefix}: ${displayError(error)}`);
    }
  }
}

async function validateManifests(
  root: string,
  io: FileReader,
  schemaErrors: string[],
): Promise<void> {
  const parsed = await parseJson(root, "manifests.json", io, schemaErrors);
  if (parsed === undefined) return;
  try {
    const messages = validationMessages(
      validateIngestManifests(
        parsed as Parameters<typeof validateIngestManifests>[0],
      ),
    );
    messages.forEach((message) =>
      schemaErrors.push(`manifests.json: ${message}`),
    );
  } catch (error) {
    schemaErrors.push(`manifests.json: ${displayError(error)}`);
  }
}

async function validateChecksums(
  root: string,
  io: FileReader,
  fileKinds: Map<string, FileKind>,
  schemaErrors: string[],
): Promise<void> {
  let text: string;
  try {
    text = await io.readText(path.join(root, "MANIFEST.sha256"));
  } catch (error) {
    schemaErrors.push(`MANIFEST.sha256: ${displayError(error)}`);
    return;
  }
  const seen = new Set<string>();
  for (const [lineIndex, line] of text.split(/\r?\n/).entries()) {
    if (!line && lineIndex === text.split(/\r?\n/).length - 1) continue;
    const prefix = `MANIFEST.sha256[${lineIndex + 1}]`;
    const match = /^([0-9a-fA-F]{64}) {2}(.+)$/.exec(line);
    if (!match) {
      schemaErrors.push(
        `${prefix}: expected <64hex><two spaces><safe relative path>`,
      );
      continue;
    }
    const expected = match[1];
    const relative = match[2];
    if (!expected || !relative || !safeRelativePath(relative)) {
      schemaErrors.push(`${prefix}: unsafe path ${relative ?? ""}`);
      continue;
    }
    const duplicate = seen.has(relative);
    if (duplicate) {
      schemaErrors.push(`${prefix}: duplicate path ${relative}`);
    } else {
      seen.add(relative);
    }
    const kind = fileKinds.get(relative);
    if (kind === undefined) {
      schemaErrors.push(`${prefix}: missing path ${relative}`);
      continue;
    }
    if (kind === "symlink") {
      schemaErrors.push(`${prefix}: symbolic link path ${relative}`);
      continue;
    }
    if (kind !== "file") {
      schemaErrors.push(`${prefix}: not a regular file ${relative}`);
      continue;
    }
    try {
      const bytes = await io.readBytes(path.join(root, relative));
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== expected.toLowerCase()) {
        schemaErrors.push(`${prefix}: hash mismatch for ${relative}`);
      }
    } catch (error) {
      schemaErrors.push(`${prefix}: ${relative}: ${displayError(error)}`);
    }
  }
}

function validateDiagrams(files: string[], schemaErrors: string[]): void {
  const fileSet = new Set(files);
  for (const file of files) {
    const extension = path.posix.extname(file).toLowerCase();
    const base = file.slice(0, -extension.length);
    if (
      (extension === ".dot" || extension === ".mmd") &&
      !fileSet.has(`${base}.svg`)
    ) {
      schemaErrors.push(`${file}: missing sibling .svg render`);
    }
    if (
      extension === ".svg" &&
      !fileSet.has(`${base}.dot`) &&
      !fileSet.has(`${base}.mmd`)
    ) {
      schemaErrors.push(`${file}: missing sibling .dot or .mmd source`);
    }
  }
}

async function validateMarkdownLinks(
  root: string,
  io: FileReader,
  markdownFiles: string[],
  fileKinds: Map<string, FileKind>,
  brokenLinks: string[],
  schemaErrors: string[],
): Promise<void> {
  for (const file of markdownFiles) {
    let content: string;
    try {
      content = await io.readText(path.join(root, file));
    } catch (error) {
      schemaErrors.push(`${file}: ${displayError(error)}`);
      continue;
    }
    for (const match of content.matchAll(markdownLink)) {
      const rawTarget = match[1]?.trim();
      if (!rawTarget) continue;
      const target = rawTarget.replace(/^<|>$/g, "").split(/[?#]/, 1)[0];
      if (
        !target ||
        /^[a-z][a-z0-9+.-]*:/i.test(target) ||
        target.startsWith("//")
      ) {
        continue;
      }
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), target),
      );
      if (
        path.posix.isAbsolute(target) ||
        resolved === ".." ||
        resolved.startsWith("../")
      ) {
        brokenLinks.push(`${file} -> ${rawTarget} (escapes bundle root)`);
        continue;
      }
      const kind = fileKinds.get(resolved);
      if (kind === "symlink") {
        brokenLinks.push(`${file} -> ${rawTarget} (symbolic link)`);
      } else if (kind === undefined) {
        brokenLinks.push(`${file} -> ${rawTarget} (missing)`);
      }
    }
  }
}

export async function validateIngestBundle(
  root: string,
  io: FileReader = nodeFileReader,
): Promise<BundleValidationReport> {
  const absoluteRoot = path.resolve(root);
  const schemaErrors: string[] = [];
  const brokenLinks: string[] = [];
  const entries = await collectEntries(absoluteRoot, io, schemaErrors);
  const fileKinds = new Map(
    entries.map((entry) => [entry.relative, entry.kind]),
  );
  const files = entries
    .filter((entry) => entry.kind === "file")
    .map((entry) => entry.relative);

  const forbiddenArtifacts = entries
    .filter((entry) => {
      const basename = path.posix.basename(entry.relative).toLowerCase();
      return (
        basename === "__pycache__" ||
        forbiddenSuffixes.some((suffix) => basename.endsWith(suffix))
      );
    })
    .map((entry) => entry.relative)
    .sort();

  let taskEdges = new Map<string, string[]>();
  if (fileKinds.get("tasks.json") === "file") {
    taskEdges = await validateTasks(absoluteRoot, io, schemaErrors);
  }
  if (fileKinds.get("records.json") === "file") {
    await validateRecords(absoluteRoot, io, schemaErrors);
  }
  if (fileKinds.get("manifests.json") === "file") {
    await validateManifests(absoluteRoot, io, schemaErrors);
  }
  if (fileKinds.get("MANIFEST.sha256") === "file") {
    await validateChecksums(absoluteRoot, io, fileKinds, schemaErrors);
  }

  validateDiagrams(files, schemaErrors);
  await validateMarkdownLinks(
    absoluteRoot,
    io,
    files.filter((file) => file.toLowerCase().endsWith(".md")),
    fileKinds,
    brokenLinks,
    schemaErrors,
  );

  const cycles = taskCycles(taskEdges);
  schemaErrors.sort();
  brokenLinks.sort();
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

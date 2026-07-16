import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { simpleGit } from "simple-git";

import {
  isRawArtifactPath,
  KnowledgeRepository,
  RawArtifactIntegrityError,
} from "./knowledge-repository.js";

function canonicalArtifactKey(path: string): string | undefined {
  const match =
    /^questions\/(?:active|deferred|answered)\/([^/]+)\/(.+)$/u.exec(path);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

async function mergeBase(
  root: string,
  baseRef?: string,
): Promise<string | undefined> {
  const git = simpleGit(root);
  const candidate =
    baseRef ??
    (process.env.GITHUB_BASE_REF
      ? `origin/${process.env.GITHUB_BASE_REF}`
      : "HEAD^");
  try {
    return (await git.raw(["merge-base", "HEAD", candidate])).trim();
  } catch {
    return undefined;
  }
}

export async function checkRawArtifactsAgainstGit(options: {
  root: string;
  baseRef?: string;
}): Promise<{ base: string | null; checked: number }> {
  const base = await mergeBase(options.root, options.baseRef);
  if (!base) return { base: null, checked: 0 };
  const git = simpleGit(options.root);
  const baselinePaths = (
    await git.raw(["ls-tree", "-r", "--name-only", base, "--", "questions"])
  )
    .split(/\r?\n/u)
    .filter(isRawArtifactPath);
  for (const baselinePath of baselinePaths) {
    const key = canonicalArtifactKey(baselinePath);
    if (!key) continue;
    const separator = key.indexOf("/");
    const questionId = key.slice(0, separator);
    const suffix = key.slice(separator + 1);
    let current: Uint8Array | undefined;
    for (const bucket of ["active", "deferred", "answered"]) {
      try {
        current = await readFile(
          join(options.root, "questions", bucket, questionId, suffix),
        );
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!current)
      throw new RawArtifactIntegrityError(
        `Committed raw artifact ${key} was deleted.`,
      );
    const baseline = Buffer.from(
      await git.raw(["show", `${base}:${baselinePath}`]),
      "utf8",
    );
    if (!baseline.equals(Buffer.from(current))) {
      throw new RawArtifactIntegrityError(
        `Committed raw artifact ${key} was modified.`,
      );
    }
  }
  return { base, checked: baselinePaths.length };
}

export async function checkProjectionDrift(
  root: string,
): Promise<{ clean: true; bytes: number }> {
  const repository = new KnowledgeRepository(root);
  const expected = await repository.expectedIndex();
  let actual = "";
  try {
    actual = await readFile(join(root, "questions", "index.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (actual !== expected) {
    throw new Error(
      "questions/index.jsonl has drifted; regenerate it from canonical question records.",
    );
  }
  return { clean: true, bytes: expected.length };
}

import { lstat, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

export class UnsafeFilesystemPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeFilesystemPathError";
  }
}

function isContained(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

async function canonicalizeNearestExisting(path: string): Promise<string> {
  let cursor = resolve(path);
  const missing: string[] = [];

  while (true) {
    try {
      await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor));
      cursor = parent;
      continue;
    }
    return resolve(await realpath(cursor), ...missing);
  }
}

async function rejectExistingSymlinkComponents(
  root: string,
  target: string,
): Promise<void> {
  const relativePath = relative(root, target);
  if (!relativePath) return;

  let cursor = root;
  const components = relativePath.split(sep);
  for (const [index, component] of components.entries()) {
    cursor = resolve(cursor, component);
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) {
        throw new UnsafeFilesystemPathError(
          `Path contains a symbolic link component: ${components.slice(0, index + 1).join("/")}.`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

/**
 * Resolves a path only when its lexical and canonical locations remain below
 * root and every existing component below root is a real file or directory.
 * The root itself may be a symlink so callers can use a canonical repository
 * reached through a user-selected alias.
 */
export async function resolveContainedPathNoSymlinks(
  root: string,
  target: string,
): Promise<string> {
  const lexicalRoot = resolve(root);
  const lexicalTarget = resolve(target);
  if (!isContained(lexicalRoot, lexicalTarget)) {
    throw new UnsafeFilesystemPathError(
      "Path escapes its permitted filesystem root.",
    );
  }

  await rejectExistingSymlinkComponents(lexicalRoot, lexicalTarget);
  const canonicalRoot = await canonicalizeNearestExisting(lexicalRoot);
  const canonicalTarget = await canonicalizeNearestExisting(lexicalTarget);
  if (!isContained(canonicalRoot, canonicalTarget)) {
    throw new UnsafeFilesystemPathError(
      "Path escapes its canonical filesystem root.",
    );
  }
  return lexicalTarget;
}

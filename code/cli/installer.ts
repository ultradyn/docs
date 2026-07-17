import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile as nodeCopyFile,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

export type FileKind = "missing" | "file" | "directory" | "symlink" | "other";

export interface DirectoryEntry {
  readonly name: string;
  readonly kind: Exclude<FileKind, "missing">;
}

export interface CopyFileOptions {
  readonly exclusive?: boolean;
}

export interface NodeFileSystemOptions {
  readonly beforeCompareAndSwapCommit?: (context: {
    readonly filePath: string;
    readonly expectedContents: string;
    readonly replacementContents: string;
  }) => void | Promise<void>;
  readonly afterCompareAndSwapReplacementLink?: (context: {
    readonly filePath: string;
    readonly expectedContents: string;
    readonly replacementContents: string;
  }) => void | Promise<void>;
  readonly afterCompareAndSwapFinalDisplacedRead?: (context: {
    readonly filePath: string;
    readonly expectedContents: string;
    readonly replacementContents: string;
  }) => void | Promise<void>;
  readonly beforeCompareAndSwapDisplacedRestore?: (context: {
    readonly filePath: string;
    readonly expectedContents: string;
    readonly replacementContents: string;
  }) => void | Promise<void>;
  readonly beforeCompareAndSwapDisplacedCleanup?: (context: {
    readonly filePath: string;
    readonly expectedContents: string;
    readonly replacementContents: string;
  }) => void | Promise<void>;
  readonly afterCompareAndSwapDisplacedIdentity?: (context: {
    readonly filePath: string;
    readonly expectedContents: string;
    readonly replacementContents: string;
  }) => void | Promise<void>;
}

/** Filesystem boundary used by the package installer. */
export interface InstallerFileSystem {
  kind(targetPath: string): Promise<FileKind>;
  list(directory: string): Promise<readonly DirectoryEntry[]>;
  mode(filePath: string): Promise<number>;
  readFile(filePath: string): Promise<string>;
  mkdir(directory: string): Promise<void>;
  mkdirExclusive(directory: string): Promise<void>;
  copyFile(
    source: string,
    destination: string,
    options?: CopyFileOptions,
  ): Promise<void>;
  writeFile(filePath: string, contents: string): Promise<void>;
  compareAndSwapFile(
    filePath: string,
    expectedContents: string,
    replacementContents: string,
  ): Promise<boolean>;
  chmod(filePath: string, mode: number): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  remove(targetPath: string): Promise<void>;
  removeEmptyDirectory(directory: string): Promise<void>;
}

export interface GitClient {
  isRepository(directory: string): Promise<boolean>;
  init(directory: string): Promise<void>;
  version(): Promise<string | null>;
}

export interface PackageFile {
  readonly source: string;
  readonly relativePath: string;
  readonly mode: number;
}

export interface InitializationPlan {
  readonly destination: string;
  readonly mode: "create" | "merge";
  readonly directories: readonly string[];
  readonly files: readonly PackageFile[];
  readonly skipped: readonly string[];
  readonly gitAction: "initialize" | "preserve";
}

export interface InitializationResult {
  readonly destination: string;
  readonly written: readonly string[];
  readonly skipped: readonly string[];
  readonly gitInitialized: boolean;
}

export interface InitializeDocumentationRepositoryOptions {
  readonly destination: string;
  readonly packageRoot: string;
  readonly packageVersion: string;
  readonly fileSystem: InstallerFileSystem;
  readonly git: GitClient;
  readonly now?: () => Date;
  readonly transactionId?: () => string;
  readonly onProgress?: (event: InitializationProgress) => void;
  readonly signal?: AbortSignal;
}

export type InitializationProgress =
  | { readonly phase: "planning" }
  | {
      readonly phase: "copying";
      readonly completed: number;
      readonly total: number;
    }
  | { readonly phase: "git"; readonly action: "initialize" | "preserve" }
  | { readonly phase: "complete"; readonly destination: string };

const SOURCE_DIRECTORIES = [
  "code",
  "tauri-app",
  ".codex/skills",
  "docs",
  ".plan",
  "schemas",
  "scripts",
] as const;
const REQUIRED_SOURCE_DIRECTORIES = new Set([
  "code",
  "tauri-app",
  ".codex/skills",
  "docs",
  ".plan",
]);
const REQUIRED_TARGET_DIRECTORIES = [
  "code",
  "tauri-app",
  ".codex/skills",
] as const;
const ROOT_SOURCE_FILES = [
  "AGENTS.md",
  "BLOCKED_TASKS.md",
  "CONTEXT.md",
  "LICENSE",
  "README.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "playwright.config.ts",
  "tsconfig.json",
  "vitest.config.ts",
  "eslint.config.js",
  ".gitignore",
  ".gitattributes",
  ".prettierignore",
  ".npmignore",
  ".env.example",
  "SECURITY.md",
  "skills-lock.json",
] as const;
const MANIFEST_PATH = ".ultradyn/manifest.json";
const SCAFFOLD_GITIGNORE_TEMPLATE = ".gitignore.template";
const REQUIRED_STAGING_IGNORE_RULE = ".ultradyn/staging/";
const IGNORED_SOURCE_DIRECTORIES = new Set([
  ".git",
  ".ultradyn",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "target",
  "test-results",
]);
const MAX_VISIBLE_RECOVERY_CLAIMS = 64;

async function claimVisibleRecoveryPath(input: {
  sourcePath: string;
  directory: string;
  name: string;
  identity: { dev: number; ino: number };
  token: string;
}): Promise<string> {
  const recoveryBase = path.join(
    input.directory,
    `${input.name.replace(/^\./u, "")}.ultradyn-recovery-${input.identity.dev.toString(16)}-${input.identity.ino.toString(16)}`,
  );
  for (let attempt = 0; attempt < MAX_VISIBLE_RECOVERY_CLAIMS; attempt += 1) {
    const candidate =
      attempt === 0
        ? recoveryBase
        : `${recoveryBase}-conflict-${input.token}${attempt === 1 ? "" : `-${attempt}`}`;
    try {
      await link(input.sourcePath, candidate);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      try {
        const existing = await lstat(candidate);
        if (
          existing.dev === input.identity.dev &&
          existing.ino === input.identity.ino
        ) {
          return candidate;
        }
      } catch (inspectionError) {
        if (
          !isNodeError(inspectionError) ||
          inspectionError.code !== "ENOENT"
        ) {
          throw inspectionError;
        }
      }
      continue;
    }
    const claimed = await lstat(candidate);
    if (
      claimed.dev === input.identity.dev &&
      claimed.ino === input.identity.ino
    ) {
      return candidate;
    }
  }
  throw new Error(
    `The installer could not claim a visible recovery path after ${MAX_VISIBLE_RECOVERY_CLAIMS} exclusive attempts; the owner file remains unchanged at ${input.sourcePath}.`,
  );
}

async function recoverDisplacedOwnerAfterFailure(input: {
  filePath: string;
  previousPath: string;
  replacementPath: string;
  directory: string;
  name: string;
  identity: { dev: number; ino: number };
  replacementIdentity: { dev: number; ino: number };
  token: string;
}): Promise<void> {
  const displaced = await lstat(input.previousPath);
  if (
    displaced.dev !== input.identity.dev ||
    displaced.ino !== input.identity.ino
  ) {
    throw new Error(
      "The hidden displaced file no longer owns the inode selected for failure recovery.",
    );
  }
  let ownerVisiblePath: string | undefined;
  let visible: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    visible = await lstat(input.filePath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  if (
    visible?.dev === input.identity.dev &&
    visible.ino === input.identity.ino
  ) {
    ownerVisiblePath = input.filePath;
  } else if (
    visible?.dev === input.replacementIdentity.dev &&
    visible.ino === input.replacementIdentity.ino
  ) {
    const observedPath = path.join(
      input.directory,
      `.${input.name}.ultradyn-cas-${input.token}.failure-observed`,
    );
    await rename(input.filePath, observedPath);
    const observed = await lstat(observedPath);
    if (
      observed.dev === input.replacementIdentity.dev &&
      observed.ino === input.replacementIdentity.ino
    ) {
      try {
        await link(input.previousPath, input.filePath);
        ownerVisiblePath = input.filePath;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          ownerVisiblePath = await claimVisibleRecoveryPath({
            sourcePath: input.previousPath,
            directory: input.directory,
            name: input.name,
            identity: input.identity,
            token: input.token,
          });
        }
      } finally {
        await rm(observedPath, { force: true });
      }
    } else {
      try {
        await rename(observedPath, input.filePath);
      } catch (error) {
        const preserved = await claimVisibleRecoveryPath({
          sourcePath: observedPath,
          directory: input.directory,
          name: `${input.name.replace(/^\./u, "")}.ultradyn-preserved-${input.token}`,
          identity: observed,
          token: input.token,
        });
        const displacedPreserved = await claimVisibleRecoveryPath({
          sourcePath: input.previousPath,
          directory: input.directory,
          name: input.name,
          identity: input.identity,
          token: input.token,
        });
        await rm(input.previousPath);
        await rm(input.replacementPath, { force: true });
        await rm(observedPath);
        throw new Error(
          `A concurrent owner replaced the published installer file and remains visible at ${input.filePath} or ${preserved}; the displaced owner remains visible at ${displacedPreserved}.`,
          { cause: error },
        );
      }
    }
  } else if (!visible) {
    try {
      await link(input.previousPath, input.filePath);
      ownerVisiblePath = input.filePath;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
  }
  if (!ownerVisiblePath) {
    ownerVisiblePath = await claimVisibleRecoveryPath({
      sourcePath: input.previousPath,
      directory: input.directory,
      name: input.name,
      identity: input.identity,
      token: input.token,
    });
  }
  const visibleOwner = await lstat(ownerVisiblePath);
  if (
    visibleOwner.dev !== input.identity.dev ||
    visibleOwner.ino !== input.identity.ino
  ) {
    throw new Error(
      `The displaced owner inode could not be proved at visible path ${ownerVisiblePath}.`,
    );
  }
  await rm(input.previousPath);
  await rm(input.replacementPath, { force: true });
}

export function createNodeFileSystem(
  options: NodeFileSystemOptions = {},
): InstallerFileSystem {
  return {
    async kind(targetPath) {
      try {
        const info = await lstat(targetPath);
        if (info.isFile()) return "file";
        if (info.isDirectory()) return "directory";
        if (info.isSymbolicLink()) return "symlink";
        return "other";
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return "missing";
        throw error;
      }
    },
    async list(directory) {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        kind: entry.isFile()
          ? "file"
          : entry.isDirectory()
            ? "directory"
            : entry.isSymbolicLink()
              ? "symlink"
              : "other",
      }));
    },
    async mode(filePath) {
      return (await lstat(filePath)).mode & 0o777;
    },
    async readFile(filePath) {
      return readFile(filePath, "utf8");
    },
    async mkdir(directory) {
      await mkdir(directory, { recursive: true });
    },
    async mkdirExclusive(directory) {
      await mkdir(directory);
    },
    async copyFile(source, destination, options) {
      await nodeCopyFile(
        source,
        destination,
        options?.exclusive ? fsConstants.COPYFILE_EXCL : 0,
      );
    },
    async writeFile(filePath, contents) {
      await writeFile(filePath, contents, { flag: "wx" });
    },
    async compareAndSwapFile(filePath, expectedContents, replacementContents) {
      const release = await lockfile.lock(filePath, {
        realpath: false,
        lockfilePath: `${filePath}.ultradyn.lock`,
        stale: 30_000,
        retries: {
          retries: 20,
          factor: 1.2,
          minTimeout: 10,
          maxTimeout: 200,
        },
      });
      try {
        let currentContents: string;
        try {
          currentContents = await readFile(filePath, "utf8");
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") return false;
          throw error;
        }
        if (currentContents !== expectedContents) return false;
        const token = randomUUID();
        const directory = path.dirname(filePath);
        const name = path.basename(filePath);
        const previousPath = path.join(
          directory,
          `.${name}.ultradyn-cas-${token}.previous`,
        );
        const replacementPath = path.join(
          directory,
          `.${name}.ultradyn-cas-${token}.replacement`,
        );
        const mode = (await lstat(filePath)).mode & 0o777;
        await writeFile(replacementPath, replacementContents, {
          flag: "wx",
          mode,
        });
        const replacementIdentity = await lstat(replacementPath);
        let replacementLinked = false;
        let displacedOwnerIdentity: { dev: number; ino: number } | undefined;
        try {
          await options.beforeCompareAndSwapCommit?.({
            filePath,
            expectedContents,
            replacementContents,
          });
          const preDisplacementIdentity = await lstat(filePath);
          displacedOwnerIdentity = preDisplacementIdentity;
          let recoveryPath = await claimVisibleRecoveryPath({
            sourcePath: filePath,
            directory,
            name,
            identity: preDisplacementIdentity,
            token,
          });
          try {
            await rename(filePath, previousPath);
          } catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") return false;
            throw error;
          }
          const displacedContents = await readFile(previousPath, "utf8");
          if (displacedContents !== expectedContents) {
            try {
              await link(previousPath, filePath);
            } catch (error) {
              const preservedPath = path.join(
                directory,
                `${name.replace(/^\./u, "")}.ultradyn-preserved-${token}`,
              );
              await rename(previousPath, preservedPath);
              throw new Error(
                `The file changed during installation and both owner versions were preserved at ${filePath} and ${preservedPath}: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
              );
            }
            await options.beforeCompareAndSwapDisplacedCleanup?.({
              filePath,
              expectedContents,
              replacementContents,
            });
            const [visibleIdentity, displacedIdentity] = await Promise.all([
              lstat(filePath),
              lstat(previousPath),
            ]);
            await options.afterCompareAndSwapDisplacedIdentity?.({
              filePath,
              expectedContents,
              replacementContents,
            });
            const preservedPath = path.join(
              directory,
              `${name.replace(/^\./u, "")}.ultradyn-preserved-${token}`,
            );
            await rename(previousPath, preservedPath);
            const [finalVisibleIdentity, preservedIdentity] = await Promise.all(
              [lstat(filePath), lstat(preservedPath)],
            );
            if (
              visibleIdentity.dev !== displacedIdentity.dev ||
              visibleIdentity.ino !== displacedIdentity.ino ||
              finalVisibleIdentity.dev !== preservedIdentity.dev ||
              finalVisibleIdentity.ino !== preservedIdentity.ino
            ) {
              throw new Error(
                `The restored owner path changed during installation; both owner versions were preserved at ${filePath} and ${preservedPath}.`,
              );
            }
            return false;
          }
          try {
            await link(replacementPath, filePath);
            replacementLinked = true;
          } catch (error) {
            throw new Error(
              `The file changed during installation; its prior bytes were preserved at ${previousPath}: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
          }
          await options.afterCompareAndSwapReplacementLink?.({
            filePath,
            expectedContents,
            replacementContents,
          });
          const [committedContents, finalDisplacedContents] = await Promise.all(
            [readFile(filePath, "utf8"), readFile(previousPath, "utf8")],
          );
          await options.afterCompareAndSwapFinalDisplacedRead?.({
            filePath,
            expectedContents,
            replacementContents,
          });
          if (
            committedContents !== replacementContents ||
            finalDisplacedContents !== expectedContents
          ) {
            if (finalDisplacedContents !== expectedContents) {
              if (committedContents !== replacementContents) {
                const preservedPath = path.join(
                  directory,
                  `${name.replace(/^\./u, "")}.ultradyn-preserved-${token}`,
                );
                await rename(previousPath, preservedPath);
                replacementLinked = false;
                throw new Error(
                  `The displaced owner inode and visible file both changed during installation; both owner versions were preserved at ${filePath} and ${preservedPath}.`,
                );
              }
              await options.beforeCompareAndSwapDisplacedRestore?.({
                filePath,
                expectedContents,
                replacementContents,
              });
              const observedVisiblePath = path.join(
                directory,
                `.${name}.ultradyn-cas-${token}.observed-visible`,
              );
              await rename(filePath, observedVisiblePath);
              const [observedIdentity, replacementIdentity] = await Promise.all(
                [lstat(observedVisiblePath), lstat(replacementPath)],
              );
              if (
                observedIdentity.dev !== replacementIdentity.dev ||
                observedIdentity.ino !== replacementIdentity.ino
              ) {
                let restoreFailure: unknown;
                try {
                  await link(observedVisiblePath, filePath);
                } catch (error) {
                  restoreFailure = error;
                }
                const displacedPreservedPath = path.join(
                  directory,
                  `${name.replace(/^\./u, "")}.ultradyn-preserved-${token}-displaced`,
                );
                const visiblePreservedPath = path.join(
                  directory,
                  `${name.replace(/^\./u, "")}.ultradyn-preserved-${token}-visible`,
                );
                await rename(previousPath, displacedPreservedPath);
                await rename(observedVisiblePath, visiblePreservedPath);
                replacementLinked = false;
                throw new Error(
                  `The displaced owner inode and visible file both changed during installation; both owner versions were preserved at ${displacedPreservedPath} and ${visiblePreservedPath}${restoreFailure ? ` while ${filePath} was also preserved: ${restoreFailure instanceof Error ? restoreFailure.message : String(restoreFailure)}` : `, with the visible owner restored at ${filePath}`}.`,
                );
              }
              try {
                await link(previousPath, filePath);
              } catch (error) {
                const preservedPath = path.join(
                  directory,
                  `${name.replace(/^\./u, "")}.ultradyn-preserved-${token}`,
                );
                await rename(previousPath, preservedPath);
                await rm(observedVisiblePath, { force: true });
                replacementLinked = false;
                throw new Error(
                  `The visible file changed while the displaced owner was being restored; both owner versions were preserved at ${filePath} and ${preservedPath}: ${error instanceof Error ? error.message : String(error)}`,
                  { cause: error },
                );
              }
              await options.beforeCompareAndSwapDisplacedCleanup?.({
                filePath,
                expectedContents,
                replacementContents,
              });
              const [visibleIdentity, displacedIdentity] = await Promise.all([
                lstat(filePath),
                lstat(previousPath),
              ]);
              await options.afterCompareAndSwapDisplacedIdentity?.({
                filePath,
                expectedContents,
                replacementContents,
              });
              const preservedPath = path.join(
                directory,
                `${name.replace(/^\./u, "")}.ultradyn-preserved-${token}`,
              );
              await rename(previousPath, preservedPath);
              const [finalVisibleIdentity, preservedIdentity] =
                await Promise.all([lstat(filePath), lstat(preservedPath)]);
              if (
                visibleIdentity.dev !== displacedIdentity.dev ||
                visibleIdentity.ino !== displacedIdentity.ino ||
                finalVisibleIdentity.dev !== preservedIdentity.dev ||
                finalVisibleIdentity.ino !== preservedIdentity.ino
              ) {
                await rm(observedVisiblePath, { force: true });
                replacementLinked = false;
                throw new Error(
                  `The restored owner path changed during installation; both owner versions were preserved at ${filePath} and ${preservedPath}.`,
                );
              }
              await rm(observedVisiblePath);
              replacementLinked = false;
              return false;
            }
            throw new Error(
              `The file changed while the version-token commit was completing; preserved versions remain at ${filePath} and ${previousPath}.`,
            );
          }
          const displacedIdentity = await lstat(previousPath);
          recoveryPath = await claimVisibleRecoveryPath({
            sourcePath: previousPath,
            directory,
            name,
            identity: displacedIdentity,
            token,
          });
          const recoveryIdentity = await lstat(recoveryPath);
          if (
            recoveryIdentity.dev !== displacedIdentity.dev ||
            recoveryIdentity.ino !== displacedIdentity.ino
          ) {
            throw new Error(
              `The installer could not retain displaced bytes at the visible recovery path ${recoveryPath}.`,
            );
          }
          await rm(replacementPath);
          await rm(previousPath);
          replacementLinked = false;
          return true;
        } catch (error) {
          let recoveryError: unknown;
          try {
            let hiddenOwnerExists = false;
            try {
              await lstat(previousPath);
              hiddenOwnerExists = true;
            } catch (inspectionError) {
              if (
                !isNodeError(inspectionError) ||
                inspectionError.code !== "ENOENT"
              ) {
                throw inspectionError;
              }
            }
            if (hiddenOwnerExists && displacedOwnerIdentity) {
              await recoverDisplacedOwnerAfterFailure({
                filePath,
                previousPath,
                replacementPath,
                directory,
                name,
                identity: displacedOwnerIdentity,
                replacementIdentity,
                token,
              });
            } else {
              await rm(replacementPath, { force: true });
            }
            replacementLinked = false;
          } catch (caughtRecoveryError) {
            recoveryError = caughtRecoveryError;
          }
          if (recoveryError) {
            throw new AggregateError(
              [error, recoveryError],
              "The installer operation failed and its displaced owner could not be made fully visible",
              { cause: error },
            );
          }
          throw error;
        } finally {
          if (!replacementLinked)
            await rm(replacementPath, { force: true }).catch(() => undefined);
        }
      } finally {
        await release();
      }
    },
    chmod,
    rename,
    async remove(targetPath) {
      await rm(targetPath, { recursive: true, force: true });
    },
    async removeEmptyDirectory(directory) {
      await rmdir(directory);
    },
  };
}

/**
 * Purely combines discovered source files and destination facts into an install
 * plan. IO discovery is intentionally kept outside this function.
 */
export function buildInitializationPlan(input: {
  readonly destination: string;
  readonly destinationExists: boolean;
  readonly directories?: readonly string[];
  readonly files: readonly PackageFile[];
  readonly existingPaths: ReadonlySet<string>;
  readonly isGitRepository: boolean;
}): InitializationPlan {
  const skipped = input.files
    .map((file) => file.relativePath)
    .filter((relativePath) => input.existingPaths.has(relativePath));
  if (input.existingPaths.has(MANIFEST_PATH)) skipped.push(MANIFEST_PATH);

  return {
    destination: input.destination,
    mode: input.destinationExists ? "merge" : "create",
    directories: input.directories ?? REQUIRED_TARGET_DIRECTORIES,
    files: input.files.filter(
      (file) => !input.existingPaths.has(file.relativePath),
    ),
    skipped,
    gitAction: input.isGitRepository ? "preserve" : "initialize",
  };
}

export async function initializeDocumentationRepository(
  options: InitializeDocumentationRepositoryOptions,
): Promise<InitializationResult> {
  const fs = options.fileSystem;
  const destination = path.resolve(options.destination);
  const packageRoot = path.resolve(options.packageRoot);
  const now = options.now ?? (() => new Date());
  const transactionId = options.transactionId ?? (() => randomTransactionId());
  throwIfAborted(options.signal);
  options.onProgress?.({ phase: "planning" });

  const destinationKind = await fs.kind(destination);
  if (destinationKind !== "missing" && destinationKind !== "directory") {
    throw new Error(`Destination is not a directory: ${destination}`);
  }

  const inventory = await collectPackageInventory(fs, packageRoot);
  throwIfAborted(options.signal);
  const existingPaths = new Set<string>();
  if (destinationKind === "directory") {
    for (const directory of REQUIRED_TARGET_DIRECTORIES) {
      const kind = await fs.kind(path.join(destination, directory));
      if (kind !== "missing" && kind !== "directory") {
        throw new Error(`Cannot install: ${directory} is not a directory`);
      }
    }
    for (const file of inventory) {
      const existingKind = await fs.kind(
        path.join(destination, file.relativePath),
      );
      if (existingKind !== "missing") {
        if (file.relativePath === ".gitignore" && existingKind !== "file") {
          throw new Error("Cannot install: .gitignore is not a regular file");
        }
        existingPaths.add(file.relativePath);
      }
      await assertNoBlockingParent(fs, destination, file.relativePath);
    }
    if ((await fs.kind(path.join(destination, MANIFEST_PATH))) !== "missing") {
      existingPaths.add(MANIFEST_PATH);
    }
  }

  const isGitRepository =
    destinationKind === "directory" &&
    (await options.git.isRepository(destination));
  const plan = buildInitializationPlan({
    destination,
    destinationExists: destinationKind === "directory",
    directories: REQUIRED_TARGET_DIRECTORIES,
    files: inventory,
    existingPaths,
    isGitRepository,
  });
  const manifest = `${JSON.stringify(
    {
      schemaVersion: 1,
      package: { name: "@ultradyn/docs", version: options.packageVersion },
      installedAt: now().toISOString(),
      source: {
        copiedDirectories: [
          "code",
          "tauri-app",
          ".codex/skills",
          "docs",
          ".plan",
          "schemas",
          "scripts",
        ],
        scaffold: "scaffold",
      },
    },
    null,
    2,
  )}\n`;

  const result =
    plan.mode === "create"
      ? await createNewDestination({
          fs,
          git: options.git,
          plan,
          manifest,
          transactionId,
          onProgress: options.onProgress,
          signal: options.signal,
        })
      : await mergeIntoDestination({
          fs,
          git: options.git,
          plan,
          manifest,
          onProgress: options.onProgress,
          signal: options.signal,
        });

  options.onProgress?.({ phase: "complete", destination });
  return result;
}

async function createNewDestination(input: {
  fs: InstallerFileSystem;
  git: GitClient;
  plan: InitializationPlan;
  manifest: string;
  transactionId: () => string;
  onProgress: ((event: InitializationProgress) => void) | undefined;
  signal: AbortSignal | undefined;
}): Promise<InitializationResult> {
  const parent = path.dirname(input.plan.destination);
  const stage = path.join(
    parent,
    `.${path.basename(input.plan.destination)}.ultradyn-tmp-${safeTransactionId(input.transactionId())}`,
  );
  await input.fs.mkdir(parent);
  let ownsStage = false;

  try {
    try {
      await input.fs.mkdirExclusive(stage);
      ownsStage = true;
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        throw new Error(
          `Temporary installation directory already exists: ${stage}`,
          { cause: error },
        );
      }
      throw error;
    }
    for (const directory of input.plan.directories) {
      await input.fs.mkdir(path.join(stage, directory));
    }
    await copyFiles(
      input.fs,
      input.plan.files,
      stage,
      input.onProgress,
      input.signal,
    );
    await writeManifest(input.fs, stage, input.manifest);
    throwIfAborted(input.signal);
    input.onProgress?.({ phase: "git", action: input.plan.gitAction });
    if (input.plan.gitAction === "initialize") await input.git.init(stage);
    throwIfAborted(input.signal);
    await input.fs.rename(stage, input.plan.destination);
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (ownsStage) {
      try {
        await input.fs.remove(stage);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0)
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Installation failed and its rollback did not complete",
        { cause: error },
      );
    throw error;
  }

  return {
    destination: input.plan.destination,
    written: [
      ...input.plan.files.map((file) => file.relativePath),
      MANIFEST_PATH,
    ],
    skipped: input.plan.skipped,
    gitInitialized: input.plan.gitAction === "initialize",
  };
}

async function mergeIntoDestination(input: {
  fs: InstallerFileSystem;
  git: GitClient;
  plan: InitializationPlan;
  manifest: string;
  onProgress: ((event: InitializationProgress) => void) | undefined;
  signal: AbortSignal | undefined;
}): Promise<InitializationResult> {
  const createdFiles: string[] = [];
  const createdDirectories: string[] = [];
  const addedGitignoreRules: GitignoreRuleAddition[] = [];
  const written: string[] = [];
  const skipped = [...input.plan.skipped];
  const manifestIsSkipped = input.plan.skipped.includes(MANIFEST_PATH);
  const gitMetadataPath = path.join(input.plan.destination, ".git");
  const gitMetadataExisted =
    (await input.fs.kind(gitMetadataPath)) !== "missing";
  let gitInitializationAttempted = false;

  try {
    throwIfAborted(input.signal);
    for (const directory of input.plan.directories) {
      await ensureDirectoryPath(
        input.fs,
        input.plan.destination,
        directory,
        createdDirectories,
      );
    }
    for (const [index, file] of input.plan.files.entries()) {
      await ensureParents(
        input.fs,
        input.plan.destination,
        file.relativePath,
        createdDirectories,
      );
      const target = path.join(input.plan.destination, file.relativePath);
      try {
        await input.fs.copyFile(file.source, target, { exclusive: true });
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        skipped.push(file.relativePath);
        input.onProgress?.({
          phase: "copying",
          completed: index + 1,
          total: input.plan.files.length,
        });
        continue;
      }
      createdFiles.push(target);
      written.push(file.relativePath);
      await input.fs.chmod(target, file.mode);
      throwIfAborted(input.signal);
      input.onProgress?.({
        phase: "copying",
        completed: index + 1,
        total: input.plan.files.length,
      });
    }
    const gitignorePath = path.join(input.plan.destination, ".gitignore");
    if ((await input.fs.kind(gitignorePath)) === "file") {
      const addition = await addGitignoreRule(
        input.fs,
        gitignorePath,
        REQUIRED_STAGING_IGNORE_RULE,
      );
      if (addition) {
        addedGitignoreRules.push(addition);
        const skippedIndex = skipped.indexOf(".gitignore");
        if (skippedIndex !== -1) skipped.splice(skippedIndex, 1);
        written.push(".gitignore");
      }
    }
    if (!manifestIsSkipped) {
      await ensureParents(
        input.fs,
        input.plan.destination,
        MANIFEST_PATH,
        createdDirectories,
      );
      const manifestTarget = path.join(input.plan.destination, MANIFEST_PATH);
      try {
        await input.fs.writeFile(manifestTarget, input.manifest);
        createdFiles.push(manifestTarget);
        written.push(MANIFEST_PATH);
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        skipped.push(MANIFEST_PATH);
      }
    }
    throwIfAborted(input.signal);
    input.onProgress?.({ phase: "git", action: input.plan.gitAction });
    if (input.plan.gitAction === "initialize") {
      gitInitializationAttempted = true;
      await input.git.init(input.plan.destination);
      throwIfAborted(input.signal);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (gitInitializationAttempted && !gitMetadataExisted) {
      try {
        await input.fs.remove(gitMetadataPath);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const file of createdFiles.reverse()) {
      try {
        await input.fs.remove(file);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const addition of addedGitignoreRules.reverse()) {
      try {
        await rollbackGitignoreRule(input.fs, addition);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const directory of createdDirectories.reverse()) {
      // rmdir is intentionally non-recursive: a path raced in by another
      // process makes the directory non-empty and therefore survives rollback.
      try {
        await input.fs.removeEmptyDirectory(directory);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0)
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Installation failed and its rollback did not complete",
        { cause: error },
      );
    throw error;
  }

  return {
    destination: input.plan.destination,
    written,
    skipped,
    gitInitialized: input.plan.gitAction === "initialize",
  };
}

interface GitignoreRuleAddition {
  readonly path: string;
  readonly original: string;
  readonly installed: string;
  readonly block: string;
  readonly startMarker: string;
  readonly endMarker: string;
}

async function addGitignoreRule(
  fs: InstallerFileSystem,
  gitignorePath: string,
  rule: string,
): Promise<GitignoreRuleAddition | undefined> {
  const ownershipToken = randomUUID();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const original = await fs.readFile(gitignorePath);
    const merged = mergeGitignoreRule(original, rule, ownershipToken);
    if (!merged) return undefined;
    if (
      !(await fs.compareAndSwapFile(gitignorePath, original, merged.installed))
    )
      continue;
    return {
      path: gitignorePath,
      original,
      ...merged,
    };
  }
  throw new Error(
    "Cannot install: .gitignore kept changing while adding the staging rule",
  );
}

async function rollbackGitignoreRule(
  fs: InstallerFileSystem,
  addition: GitignoreRuleAddition,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await fs.readFile(addition.path);
    const replacement = removeAddedGitignoreRule(current, addition);
    if (replacement === current) return;
    if (await fs.compareAndSwapFile(addition.path, current, replacement))
      return;
  }
  throw new Error(
    "Cannot roll back: .gitignore kept changing while removing the staging rule",
  );
}

function removeAddedGitignoreRule(
  contents: string,
  addition: GitignoreRuleAddition,
): string {
  if (contents === addition.installed) return addition.original;
  let blockStart: number | undefined;
  let offset = 0;
  while (offset < contents.length) {
    const lineStart = offset;
    while (
      offset < contents.length &&
      contents[offset] !== "\r" &&
      contents[offset] !== "\n"
    )
      offset += 1;
    const line = contents.slice(lineStart, offset).trim();
    if (line === addition.startMarker) blockStart = lineStart;
    if (blockStart !== undefined && line === addition.endMarker) {
      if (contents[offset] === "\r" && contents[offset + 1] === "\n")
        offset += 2;
      else if (contents[offset] === "\r" || contents[offset] === "\n")
        offset += 1;
      return `${contents.slice(0, blockStart)}${contents.slice(offset)}`;
    }
    if (contents[offset] === "\r" && contents[offset + 1] === "\n") offset += 2;
    else if (contents[offset] === "\r" || contents[offset] === "\n")
      offset += 1;
  }
  return contents;
}

function mergeGitignoreRule(
  contents: string,
  rule: string,
  ownershipToken: string,
):
  | {
      installed: string;
      block: string;
      startMarker: string;
      endMarker: string;
    }
  | undefined {
  const lines = contents.split(/\r\n|\r|\n/u);
  if (lines.some((line) => line.trim() === rule)) return undefined;
  const newline = contents.includes("\r\n")
    ? "\r\n"
    : contents.includes("\r")
      ? "\r"
      : "\n";
  const separator =
    contents.length === 0 || contents.endsWith("\n") || contents.endsWith("\r")
      ? ""
      : newline;
  const marker = `ultradyn-docs managed staging ignore ${ownershipToken}`;
  const startMarker = `# >>> ${marker}`;
  const endMarker = `# <<< ${marker}`;
  const block = [startMarker, rule, endMarker, ""].join(newline);
  const contribution = `${separator}${block}`;
  return {
    installed: `${contents}${contribution}`,
    block,
    startMarker,
    endMarker,
  };
}

async function copyFiles(
  fs: InstallerFileSystem,
  files: readonly PackageFile[],
  destination: string,
  onProgress?: (event: InitializationProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  for (const [index, file] of files.entries()) {
    throwIfAborted(signal);
    const target = path.join(destination, file.relativePath);
    await fs.mkdir(path.dirname(target));
    await fs.copyFile(file.source, target);
    await fs.chmod(target, file.mode);
    throwIfAborted(signal);
    onProgress?.({
      phase: "copying",
      completed: index + 1,
      total: files.length,
    });
  }
}

async function writeManifest(
  fs: InstallerFileSystem,
  root: string,
  manifest: string,
): Promise<void> {
  const target = path.join(root, MANIFEST_PATH);
  await fs.mkdir(path.dirname(target));
  await fs.writeFile(target, manifest);
}

async function ensureParents(
  fs: InstallerFileSystem,
  destination: string,
  relativeFile: string,
  created: string[],
): Promise<void> {
  const relativeParent = path.dirname(relativeFile);
  if (relativeParent === ".") return;
  let cursor = destination;
  for (const segment of relativeParent.split(path.sep)) {
    cursor = path.join(cursor, segment);
    if ((await fs.kind(cursor)) === "missing") {
      await fs.mkdir(cursor);
      created.push(cursor);
    }
  }
}

async function ensureDirectoryPath(
  fs: InstallerFileSystem,
  destination: string,
  relativeDirectory: string,
  created: string[],
): Promise<void> {
  let cursor = destination;
  for (const segment of relativeDirectory.split(path.sep)) {
    cursor = path.join(cursor, segment);
    const kind = await fs.kind(cursor);
    if (kind === "missing") {
      await fs.mkdir(cursor);
      created.push(cursor);
    } else if (kind !== "directory") {
      throw new Error(
        `Cannot install: ${relativeDirectory} is not a directory`,
      );
    }
  }
}

async function assertNoBlockingParent(
  fs: InstallerFileSystem,
  destination: string,
  relativeFile: string,
): Promise<void> {
  const segments = relativeFile.split(path.sep).slice(0, -1);
  let cursor = destination;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const kind = await fs.kind(cursor);
    if (kind !== "missing" && kind !== "directory") {
      throw new Error(
        `Cannot install ${relativeFile}: ${path.relative(destination, cursor)} is not a directory`,
      );
    }
  }
}

async function collectPackageInventory(
  fs: InstallerFileSystem,
  packageRoot: string,
): Promise<readonly PackageFile[]> {
  const files = new Map<string, PackageFile>();

  for (const relativeDirectory of SOURCE_DIRECTORIES) {
    const source = path.join(packageRoot, relativeDirectory);
    const kind = await fs.kind(source);
    if (
      kind === "missing" &&
      REQUIRED_SOURCE_DIRECTORIES.has(relativeDirectory)
    ) {
      throw new Error(
        `Installed package is incomplete: missing ${relativeDirectory}/`,
      );
    }
    if (kind === "missing") continue;
    if (kind !== "directory")
      throw new Error(
        `Installed package path is not a directory: ${relativeDirectory}`,
      );
    await collectTree(fs, source, relativeDirectory, files);
  }

  for (const relativeFile of ROOT_SOURCE_FILES) {
    const source = path.join(packageRoot, relativeFile);
    const kind = await fs.kind(source);
    if (kind === "missing") continue;
    if (kind !== "file")
      throw new Error(`Installed package path is not a file: ${relativeFile}`);
    files.set(relativeFile, {
      source,
      relativePath: relativeFile,
      mode: await fs.mode(source),
    });
  }

  const scaffold = path.join(packageRoot, "scaffold");
  const scaffoldKind = await fs.kind(scaffold);
  if (scaffoldKind === "directory") await collectTree(fs, scaffold, "", files);
  else if (scaffoldKind !== "missing")
    throw new Error("Installed package scaffold is not a directory");

  const gitignoreTemplate = files.get(SCAFFOLD_GITIGNORE_TEMPLATE);
  if (gitignoreTemplate) {
    files.delete(SCAFFOLD_GITIGNORE_TEMPLATE);
    files.set(".gitignore", {
      ...gitignoreTemplate,
      relativePath: ".gitignore",
    });
  }

  files.delete(MANIFEST_PATH);
  return [...files.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

async function collectTree(
  fs: InstallerFileSystem,
  sourceRoot: string,
  targetRoot: string,
  output: Map<string, PackageFile>,
  sourceRelative = "",
): Promise<void> {
  const directory = path.join(sourceRoot, sourceRelative);
  const entries = [...(await fs.list(directory))].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const childSourceRelative = sourceRelative
      ? path.join(sourceRelative, entry.name)
      : entry.name;
    if (entry.kind === "directory") {
      if (IGNORED_SOURCE_DIRECTORIES.has(entry.name)) continue;
      await collectTree(
        fs,
        sourceRoot,
        targetRoot,
        output,
        childSourceRelative,
      );
      continue;
    }
    if (entry.kind !== "file") {
      throw new Error(
        `Installed package contains unsupported ${entry.kind}: ${childSourceRelative}`,
      );
    }
    const relativePath = targetRoot
      ? path.join(targetRoot, childSourceRelative)
      : childSourceRelative;
    assertSafeRelativePath(relativePath);
    const source = path.join(sourceRoot, childSourceRelative);
    output.set(relativePath, {
      source,
      relativePath,
      mode: await fs.mode(source),
    });
  }
}

function assertSafeRelativePath(relativePath: string): void {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Unsafe package path: ${relativePath}`);
  }
}

function safeTransactionId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "transaction";
}

function randomTransactionId(): string {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isAlreadyExistsError(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

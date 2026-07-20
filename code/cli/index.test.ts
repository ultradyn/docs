import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNodeFileSystem,
  createNativeGitClient,
  initializeDocumentationRepository,
  suggestDestination,
  type GitClient,
  type InstallerFileSystem,
} from "./index.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

const DOGFOOD_GITIGNORE_BLOCK = [
  "",
  "# Dogfooding: running the dev server from the source tree initializes a",
  "# knowledge repository at the root (questions/{active,answered,deferred}).",
  "# That is instance state, not tool source. Instance repos commit questions/",
  "# via their own scaffold .gitignore, which does not ignore it.",
  "questions/",
].join("\n");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ packageRoot: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ultradyn-cli-test-"));
  temporaryDirectories.push(root);
  const packageRoot = path.join(root, "package");

  await mkdir(path.join(packageRoot, "code", "server"), { recursive: true });
  await mkdir(path.join(packageRoot, "tauri-app", "src"), { recursive: true });
  await mkdir(path.join(packageRoot, ".codex", "skills", "tdd"), {
    recursive: true,
  });
  await mkdir(path.join(packageRoot, "docs"), { recursive: true });
  await mkdir(path.join(packageRoot, ".plan"), { recursive: true });
  await mkdir(path.join(packageRoot, "scaffold", "questions"), {
    recursive: true,
  });
  await writeFile(
    path.join(packageRoot, "code", "server", "index.ts"),
    "export {};\n",
  );
  await writeFile(
    path.join(packageRoot, "tauri-app", "src", "main.rs"),
    "fn main() {}\n",
  );
  await writeFile(
    path.join(packageRoot, ".codex", "skills", "tdd", "SKILL.md"),
    "# TDD\n",
  );
  await writeFile(
    path.join(packageRoot, "docs", "architecture.md"),
    "# Architecture\n",
  );
  await writeFile(
    path.join(packageRoot, ".plan", "03-specification.md"),
    "# Specification\n",
  );
  await writeFile(
    path.join(packageRoot, "scaffold", "questions", "index.jsonl"),
    "",
  );
  await writeFile(
    path.join(packageRoot, "scaffold", ".gitignore.template"),
    ".ultradyn/staging/\n",
  );
  await writeFile(
    path.join(packageRoot, "AGENTS.md"),
    "# Build this project\n",
  );
  await writeFile(path.join(packageRoot, "README.md"), "# Ultradyn Docs\n");
  await writeFile(path.join(packageRoot, ".gitattributes"), "* text=auto\n");
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "@ultradyn/docs", version: "1.2.3" }),
  );

  return { packageRoot, root };
}

function fakeGit(
  initiallyRepository = false,
): GitClient & { init: ReturnType<typeof vi.fn> } {
  let repository = initiallyRepository;
  const init = vi.fn(async (directory: string) => {
    repository = true;
    await mkdir(path.join(directory, ".git"), { recursive: true });
    await writeFile(
      path.join(directory, ".git", "HEAD"),
      "ref: refs/heads/main\n",
    );
  });

  return {
    init,
    isRepository: vi.fn(async () => repository),
    version: vi.fn(async () => "git version 2.45.2"),
  };
}

describe("installer destination", () => {
  it("suggests the current directory only when it is effectively empty", () => {
    expect(
      suggestDestination("/work/Network Protocol", [".git", ".DS_Store"]),
    ).toBe(".");
    expect(suggestDestination("/work/Network Protocol", ["notes.md"])).toBe(
      "./network-protocol-docs",
    );
    expect(suggestDestination("/work", ["notes.md"])).toBe("./network-docs");
  });
});

describe("scaffold filesystem", () => {
  it("creates a complete source-backed repository and records its package version", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "network-docs");
    const git = fakeGit();

    const result = await initializeDocumentationRepository({
      destination,
      packageRoot,
      packageVersion: "1.2.3",
      fileSystem: createNodeFileSystem(),
      git,
      now: () => new Date("2026-07-16T00:00:00.000Z"),
      transactionId: () => "test",
    });

    expect(result).toMatchObject({
      destination,
      gitInitialized: true,
      skipped: [],
    });
    expect(git.init).toHaveBeenCalledTimes(1);
    await expect(
      readFile(path.join(destination, "code", "server", "index.ts"), "utf8"),
    ).resolves.toBe("export {};\n");
    await expect(
      readFile(path.join(destination, "tauri-app", "src", "main.rs"), "utf8"),
    ).resolves.toBe("fn main() {}\n");
    await expect(
      readFile(
        path.join(destination, ".codex", "skills", "tdd", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toBe("# TDD\n");
    await expect(
      readFile(path.join(destination, "questions", "index.jsonl"), "utf8"),
    ).resolves.toBe("");
    await expect(
      readFile(path.join(destination, ".gitattributes"), "utf8"),
    ).resolves.toBe("* text=auto\n");
    await expect(
      readFile(path.join(destination, "docs", "architecture.md"), "utf8"),
    ).resolves.toBe("# Architecture\n");
    await expect(
      readFile(path.join(destination, ".plan", "03-specification.md"), "utf8"),
    ).resolves.toBe("# Specification\n");
    await expect(
      readFile(path.join(destination, ".git", "HEAD"), "utf8"),
    ).resolves.toContain("refs/heads/main");
    await expect(
      readFile(
        path.join(destination, ".ultradyn", "manifest.json"),
        "utf8",
      ).then(JSON.parse),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      package: { name: "@ultradyn/docs", version: "1.2.3" },
      installedAt: "2026-07-16T00:00:00.000Z",
    });
  });

  it("generates a repository whose question staging area is ignored by Git", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "ignored-staging-docs");
    await initializeDocumentationRepository({
      destination,
      packageRoot,
      packageVersion: "1.2.3",
      fileSystem: createNodeFileSystem(),
      git: createNativeGitClient(),
      transactionId: () => "test",
    });
    const staged = path.join(destination, ".ultradyn", "staging", "probe");
    await mkdir(path.dirname(staged), { recursive: true });
    await writeFile(staged, "transient raw-question staging\n");

    const { stdout } = await execFileAsync("git", [
      "-C",
      destination,
      "check-ignore",
      ".ultradyn/staging/probe",
    ]);
    expect(stdout.trim()).toBe(".ultradyn/staging/probe");
    const shippedTemplate = path.join(
      process.cwd(),
      "scaffold",
      ".gitignore.template",
    );
    if (existsSync(shippedTemplate)) {
      const template = await readFile(shippedTemplate, "utf8");
      const rootIgnore = await readFile(
        path.join(process.cwd(), ".gitignore"),
        "utf8",
      );
      // Instance repos must still track questions/ — template never ignores it.
      expect(template.split("\n")).not.toContain("questions/");
      // Root dogfoods a knowledge repo at cwd; ignore that instance state.
      expect(rootIgnore).toContain("questions/");
      expect(rootIgnore).toContain("# Dogfooding:");
      // Shared required rules: every non-empty template line is in root.
      for (const line of template.split("\n")) {
        if (line.length === 0) continue;
        expect(rootIgnore.split("\n")).toContain(line);
      }
      // Only allowed divergence is the documented dogfood block appended.
      expect(rootIgnore).toBe(
        `${template.trimEnd()}\n${DOGFOOD_GITIGNORE_BLOCK}\n`,
      );
    }

    const { stdout: questionsIgnored } = await execFileAsync("git", [
      "-C",
      process.cwd(),
      "check-ignore",
      "questions/",
    ]);
    expect(questionsIgnored.trim()).toBe("questions/");
  });

  it("retains required source roots even while one is empty", async () => {
    const { packageRoot, root } = await fixture();
    await rm(path.join(packageRoot, "tauri-app"), { recursive: true });
    await mkdir(path.join(packageRoot, "tauri-app"));
    const destination = path.join(root, "network-docs");

    await initializeDocumentationRepository({
      destination,
      packageRoot,
      packageVersion: "1.2.3",
      fileSystem: createNodeFileSystem(),
      git: fakeGit(),
      transactionId: () => "test",
    });

    await expect(
      stat(path.join(destination, "tauri-app")),
    ).resolves.toMatchObject({});
  });

  it("never packages dependency, build, or Rust target directories from the source checkout", async () => {
    const { packageRoot, root } = await fixture();
    await mkdir(path.join(packageRoot, "tauri-app", "node_modules", ".bin"), {
      recursive: true,
    });
    await symlink(
      "../@tauri-apps/cli",
      path.join(packageRoot, "tauri-app", "node_modules", ".bin", "tauri"),
    );
    await mkdir(path.join(packageRoot, "tauri-app", "target", "debug"), {
      recursive: true,
    });
    await writeFile(
      path.join(packageRoot, "tauri-app", "target", "debug", "ultradyn-docs"),
      "binary",
    );
    const destination = path.join(root, "clean-docs");

    await initializeDocumentationRepository({
      destination,
      packageRoot,
      packageVersion: "1.2.3",
      fileSystem: createNodeFileSystem(),
      git: fakeGit(),
      transactionId: () => "test",
    });

    await expect(
      stat(path.join(destination, "tauri-app", "src", "main.rs")),
    ).resolves.toMatchObject({});
    await expect(
      stat(path.join(destination, "tauri-app", "node_modules")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(path.join(destination, "tauri-app", "target")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves existing files and an existing Git repository", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "existing-docs");
    await mkdir(path.join(destination, ".git"), { recursive: true });
    await writeFile(path.join(destination, "README.md"), "# Keep me\n");
    const git = fakeGit(true);

    const result = await initializeDocumentationRepository({
      destination,
      packageRoot,
      packageVersion: "1.2.3",
      fileSystem: createNodeFileSystem(),
      git,
      transactionId: () => "test",
    });

    expect(result.gitInitialized).toBe(false);
    expect(result.skipped).toContain("README.md");
    expect(git.init).not.toHaveBeenCalled();
    await expect(
      readFile(path.join(destination, "README.md"), "utf8"),
    ).resolves.toBe("# Keep me\n");
    await expect(
      readFile(path.join(destination, "code", "server", "index.ts"), "utf8"),
    ).resolves.toBe("export {};\n");
  });

  it("merges the staging ignore rule into existing repositories exactly once", async () => {
    const { packageRoot, root } = await fixture();
    const missingRule = path.join(root, "existing-ignore-missing");
    await mkdir(missingRule);
    const originalMissingRule = "node_modules/\r\n# keep this comment";
    await writeFile(path.join(missingRule, ".gitignore"), originalMissingRule);
    const options = {
      packageRoot,
      packageVersion: "1.2.3",
      fileSystem: createNodeFileSystem(),
      git: fakeGit(true),
      transactionId: () => "test",
    };

    await initializeDocumentationRepository({
      ...options,
      destination: missingRule,
    });
    const merged = await readFile(path.join(missingRule, ".gitignore"), "utf8");
    expect(merged).toMatch(
      /^node_modules\/\r\n# keep this comment\r\n# >>> ultradyn-docs managed staging ignore [0-9a-f-]{36}\r\n\.ultradyn\/staging\/\r\n# <<< ultradyn-docs managed staging ignore [0-9a-f-]{36}\r\n$/u,
    );
    const recoveryNames = (await readdir(missingRule)).filter((name) =>
      name.startsWith("gitignore.ultradyn-recovery-"),
    );
    expect(recoveryNames).toHaveLength(1);
    await expect(
      readFile(path.join(missingRule, recoveryNames[0]!), "utf8"),
    ).resolves.toBe(originalMissingRule);
    await initializeDocumentationRepository({
      ...options,
      destination: missingRule,
    });
    await expect(
      readFile(path.join(missingRule, ".gitignore"), "utf8"),
    ).resolves.toBe(merged);
    expect(
      (await readdir(missingRule)).filter((name) =>
        name.startsWith("gitignore.ultradyn-recovery-"),
      ),
    ).toEqual(recoveryNames);

    const existingRule = path.join(root, "existing-ignore-present");
    await mkdir(existingRule);
    const original = "node_modules/\n.ultradyn/staging/\n";
    await writeFile(path.join(existingRule, ".gitignore"), original);
    await initializeDocumentationRepository({
      ...options,
      destination: existingRule,
    });
    await expect(
      readFile(path.join(existingRule, ".gitignore"), "utf8"),
    ).resolves.toBe(original);
  });

  it("retries the .gitignore merge without overwriting an owner edit made after its read", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "existing-ignore-race");
    const gitignorePath = path.join(destination, ".gitignore");
    await mkdir(destination);
    await writeFile(
      gitignorePath,
      "node_modules/\r\n# keep without a final newline",
    );
    const base = createNodeFileSystem();
    let raced = false;
    const racingFileSystem: InstallerFileSystem = {
      ...base,
      async readFile(target) {
        const contents = await base.readFile(target);
        if (target === gitignorePath && !raced) {
          raced = true;
          await writeFile(target, `${contents}\r\nconcurrent-owner/`);
        }
        return contents;
      },
    };

    await initializeDocumentationRepository({
      destination,
      packageRoot,
      packageVersion: "1.2.3",
      fileSystem: racingFileSystem,
      git: fakeGit(true),
      transactionId: () => "test",
    });

    await expect(readFile(gitignorePath, "utf8")).resolves.toMatch(
      /^node_modules\/\r\n# keep without a final newline\r\nconcurrent-owner\/\r\n# >>> ultradyn-docs managed staging ignore [0-9a-f-]{36}\r\n\.ultradyn\/staging\/\r\n# <<< ultradyn-docs managed staging ignore [0-9a-f-]{36}\r\n$/u,
    );
  });

  it("preserves an owner replacement detected in the last precommit window", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "existing-ignore-last-window");
    const gitignorePath = path.join(destination, ".gitignore");
    await mkdir(destination);
    await writeFile(gitignorePath, "node_modules/\n# owner baseline\n");
    let injected = false;
    const fileSystem = createNodeFileSystem({
      async beforeCompareAndSwapCommit(context) {
        if (context.filePath !== gitignorePath || injected) return;
        injected = true;
        const ownerReplacement = `${gitignorePath}.owner-replacement`;
        await writeFile(
          ownerReplacement,
          `${context.expectedContents}last-window-owner/\n`,
        );
        await rename(ownerReplacement, gitignorePath);
      },
    });

    await initializeDocumentationRepository({
      destination,
      packageRoot,
      packageVersion: "1.2.3",
      fileSystem,
      git: fakeGit(true),
      transactionId: () => "test",
    });

    const installed = await readFile(gitignorePath, "utf8");
    expect(injected).toBe(true);
    expect(installed).toContain("last-window-owner/\n");
    expect(installed).toContain(".ultradyn/staging/\n");
    const preservedPaths = (await readdir(destination))
      .filter((name) => name.startsWith("gitignore.ultradyn-preserved-"))
      .map((name) => path.join(destination, name));
    expect(preservedPaths).toHaveLength(1);
    await expect(readFile(preservedPaths[0]!, "utf8")).resolves.toContain(
      "last-window-owner/\n",
    );
  });

  it("restores and visibly preserves bytes written through the displaced inode", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "existing-ignore-displaced-inode");
    const gitignorePath = path.join(destination, ".gitignore");
    await mkdir(destination);
    await writeFile(gitignorePath, "node_modules/\n# owner baseline\n");
    const ownerHandle = await open(gitignorePath, "r+");
    let wroteThroughDisplacedInode = false;
    const fileSystem = createNodeFileSystem({
      async afterCompareAndSwapReplacementLink(context) {
        if (context.filePath !== gitignorePath || wroteThroughDisplacedInode)
          return;
        wroteThroughDisplacedInode = true;
        await ownerHandle.truncate(0);
        await ownerHandle.writeFile(
          `${context.expectedContents}fd-held-owner/\n`,
        );
        await ownerHandle.sync();
      },
    });

    try {
      await initializeDocumentationRepository({
        destination,
        packageRoot,
        packageVersion: "1.2.3",
        fileSystem,
        git: fakeGit(true),
        transactionId: () => "test",
      });
    } finally {
      await ownerHandle.close();
    }

    expect(wroteThroughDisplacedInode).toBe(true);
    const installed = await readFile(gitignorePath, "utf8");
    expect(installed).toContain("fd-held-owner/\n");
    expect(installed).toContain(".ultradyn/staging/\n");
    const preservedPaths = (await readdir(destination))
      .filter((name) => name.startsWith("gitignore.ultradyn-preserved-"))
      .map((name) => path.join(destination, name));
    expect(preservedPaths).toHaveLength(1);
    await expect(readFile(preservedPaths[0]!, "utf8")).resolves.toContain(
      "fd-held-owner/\n",
    );
  });

  it("keeps late displaced-inode bytes visibly recoverable after a successful install", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "existing-ignore-final-cleanup-race");
    const gitignorePath = path.join(destination, ".gitignore");
    await mkdir(destination);
    await writeFile(gitignorePath, "node_modules/\n# owner baseline\n");
    const displacedOwner = await open(gitignorePath, "r+");
    let expectedContents = "";
    let wroteBeforeCleanup = false;
    const fileSystem = createNodeFileSystem({
      async afterCompareAndSwapFinalDisplacedRead(context) {
        if (context.filePath !== gitignorePath || wroteBeforeCleanup) return;
        expectedContents = context.expectedContents;
        await displacedOwner.truncate(0);
        await displacedOwner.writeFile(
          `${context.expectedContents}before-cleanup-owner/\n`,
        );
        await displacedOwner.sync();
        wroteBeforeCleanup = true;
      },
    });

    let result;
    try {
      result = await initializeDocumentationRepository({
        destination,
        packageRoot,
        packageVersion: "1.2.3",
        fileSystem,
        git: fakeGit(true),
        transactionId: () => "test",
      });
      await displacedOwner.truncate(0);
      await displacedOwner.writeFile(
        `${expectedContents}after-success-owner/\n`,
      );
      await displacedOwner.sync();
    } finally {
      await displacedOwner.close();
    }

    expect(result.destination).toBe(destination);
    expect(wroteBeforeCleanup).toBe(true);
    await expect(readFile(gitignorePath, "utf8")).resolves.toContain(
      ".ultradyn/staging/\n",
    );
    const recoveryPaths = (await readdir(destination))
      .filter((name) => name.startsWith("gitignore.ultradyn-recovery-"))
      .map((name) => path.join(destination, name));
    expect(recoveryPaths).toHaveLength(1);
    await expect(readFile(recoveryPaths[0]!, "utf8")).resolves.toContain(
      "after-success-owner/\n",
    );
  });

  it("claims a visible recovery path before publish despite multiple symlink collisions", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "existing-ignore-recovery-collisions");
    const gitignorePath = path.join(destination, ".gitignore");
    const collisionTarget = path.join(destination, "collision-owner.txt");
    await mkdir(destination);
    await writeFile(gitignorePath, "node_modules/\n# owner baseline\n");
    await writeFile(collisionTarget, "collision owner must remain untouched\n");
    const originalIdentity = await lstat(gitignorePath);
    const ownerHandle = await open(gitignorePath, "r+");
    let collisionsCreated = 0;
    let lateOwnerWrite = false;
    const fileSystem = createNodeFileSystem({
      async beforeCompareAndSwapCommit(context) {
        if (context.filePath !== gitignorePath || collisionsCreated > 0) return;
        const replacementName = (await readdir(destination)).find((name) =>
          /^\.\.gitignore\.ultradyn-cas-.+\.replacement$/u.test(name),
        );
        expect(replacementName).toBeDefined();
        const token = replacementName!.slice(
          "..gitignore.ultradyn-cas-".length,
          -".replacement".length,
        );
        const recoveryBase = path.join(
          destination,
          `gitignore.ultradyn-recovery-${originalIdentity.dev.toString(16)}-${originalIdentity.ino.toString(16)}`,
        );
        const conflictBase = `${recoveryBase}-conflict-${token}`;
        for (const collisionPath of [
          recoveryBase,
          conflictBase,
          `${conflictBase}-2`,
          `${conflictBase}-3`,
        ]) {
          await symlink(collisionTarget, collisionPath);
          collisionsCreated += 1;
        }
      },
      async afterCompareAndSwapFinalDisplacedRead(context) {
        if (context.filePath !== gitignorePath || lateOwnerWrite) return;
        await ownerHandle.truncate(0);
        await ownerHandle.writeFile(
          `${context.expectedContents}late-fd-owner/\n`,
        );
        await ownerHandle.sync();
        lateOwnerWrite = true;
      },
    });

    try {
      await expect(
        initializeDocumentationRepository({
          destination,
          packageRoot,
          packageVersion: "1.2.3",
          fileSystem,
          git: fakeGit(true),
          transactionId: () => "test",
        }),
      ).resolves.toMatchObject({ destination });
    } finally {
      await ownerHandle.close();
    }

    expect(collisionsCreated).toBe(4);
    expect(lateOwnerWrite).toBe(true);
    await expect(readFile(gitignorePath, "utf8")).resolves.toMatch(
      /ultradyn-docs managed staging ignore[\s\S]*\.ultradyn\/staging\//u,
    );
    const recoveryPaths = (await readdir(destination))
      .filter((name) => name.startsWith("gitignore.ultradyn-recovery-"))
      .map((name) => path.join(destination, name));
    const recoveryIdentities = await Promise.all(
      recoveryPaths.map(async (recoveryPath) => ({
        path: recoveryPath,
        identity: await lstat(recoveryPath),
      })),
    );
    const ownerRecovery = recoveryIdentities.find(
      ({ identity }) =>
        identity.dev === originalIdentity.dev &&
        identity.ino === originalIdentity.ino,
    );
    expect(ownerRecovery?.path).toMatch(/gitignore\.ultradyn-recovery-/u);
    await expect(readFile(ownerRecovery!.path, "utf8")).resolves.toContain(
      "late-fd-owner/\n",
    );
    await expect(readFile(collisionTarget, "utf8")).resolves.toBe(
      "collision owner must remain untouched\n",
    );
    expect(
      (await readdir(destination)).some((name) =>
        /^\.\.gitignore\.ultradyn-cas-.+\.previous$/u.test(name),
      ),
    ).toBe(false);
  });

  it("recovers visibly when the recovery claim is removed after publication fails", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "existing-ignore-publish-failure");
    const gitignorePath = path.join(destination, ".gitignore");
    const collisionTarget = path.join(destination, "collision-owner.txt");
    await mkdir(destination);
    await writeFile(gitignorePath, "node_modules/\n# owner baseline\n");
    await writeFile(collisionTarget, "collision owner must remain untouched\n");
    const originalIdentity = await lstat(gitignorePath);
    const ownerHandle = await open(gitignorePath, "r+");
    let injected = false;
    const fileSystem = createNodeFileSystem({
      async afterCompareAndSwapReplacementLink(context) {
        if (context.filePath !== gitignorePath || injected) return;
        injected = true;
        const names = await readdir(destination);
        const replacementName = names.find((name) =>
          /^\.\.gitignore\.ultradyn-cas-.+\.replacement$/u.test(name),
        );
        expect(replacementName).toBeDefined();
        const token = replacementName!.slice(
          "..gitignore.ultradyn-cas-".length,
          -".replacement".length,
        );
        const recoveryBase = path.join(
          destination,
          `gitignore.ultradyn-recovery-${originalIdentity.dev.toString(16)}-${originalIdentity.ino.toString(16)}`,
        );
        const claimedRecovery = names.find((name) =>
          name.startsWith("gitignore.ultradyn-recovery-"),
        );
        expect(claimedRecovery).toBeDefined();
        await rm(path.join(destination, claimedRecovery!));
        const conflictBase = `${recoveryBase}-conflict-${token}`;
        for (const collisionPath of [
          recoveryBase,
          conflictBase,
          `${conflictBase}-2`,
          `${conflictBase}-3`,
        ]) {
          await symlink(collisionTarget, collisionPath);
        }
        const concurrentOwner = `${gitignorePath}.concurrent-owner`;
        await writeFile(concurrentOwner, "concurrent-owner/\n");
        await rename(concurrentOwner, gitignorePath);
        await ownerHandle.truncate(0);
        await ownerHandle.writeFile(
          `${context.expectedContents}late-fd-owner/\n`,
        );
        await ownerHandle.sync();
        throw new Error("injected failure after replacement publication");
      },
    });

    try {
      await expect(
        initializeDocumentationRepository({
          destination,
          packageRoot,
          packageVersion: "1.2.3",
          fileSystem,
          git: fakeGit(true),
          transactionId: () => "test",
        }),
      ).rejects.toThrow(/failure after replacement publication/i);
    } finally {
      await ownerHandle.close();
    }

    expect(injected).toBe(true);
    await expect(readFile(gitignorePath, "utf8")).resolves.toBe(
      "concurrent-owner/\n",
    );
    const recoveryPaths = (await readdir(destination))
      .filter((name) => name.startsWith("gitignore.ultradyn-recovery-"))
      .map((name) => path.join(destination, name));
    const ownerRecovery = (
      await Promise.all(
        recoveryPaths.map(async (recoveryPath) => ({
          path: recoveryPath,
          identity: await lstat(recoveryPath),
        })),
      )
    ).find(
      ({ identity }) =>
        identity.dev === originalIdentity.dev &&
        identity.ino === originalIdentity.ino,
    );
    expect(ownerRecovery?.path).toMatch(/-conflict-.+-4$/u);
    await expect(readFile(ownerRecovery!.path, "utf8")).resolves.toContain(
      "late-fd-owner/\n",
    );
    await expect(readFile(collisionTarget, "utf8")).resolves.toBe(
      "collision owner must remain untouched\n",
    );
    expect(
      (await readdir(destination)).filter((name) =>
        /^\.\.gitignore\.ultradyn-cas-/u.test(name),
      ),
    ).toEqual([]);
  });

  it("fails closed without losing either owner when the displaced inode and visible path both change", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "existing-ignore-two-owners");
    const gitignorePath = path.join(destination, ".gitignore");
    await mkdir(destination);
    await writeFile(gitignorePath, "node_modules/\n# owner baseline\n");
    const displacedOwner = await open(gitignorePath, "r+");
    let injected = false;
    const fileSystem = createNodeFileSystem({
      async afterCompareAndSwapReplacementLink(context) {
        if (context.filePath !== gitignorePath || injected) return;
        injected = true;
        const atomicOwnerPath = `${gitignorePath}.atomic-owner`;
        await writeFile(
          atomicOwnerPath,
          `${context.expectedContents}atomic-owner/\n`,
        );
        await Promise.all([
          (async () => {
            await displacedOwner.truncate(0);
            await displacedOwner.writeFile(
              `${context.expectedContents}fd-held-owner/\n`,
            );
            await displacedOwner.sync();
          })(),
          rename(atomicOwnerPath, gitignorePath),
        ]);
      },
    });

    try {
      await expect(
        initializeDocumentationRepository({
          destination,
          packageRoot,
          packageVersion: "1.2.3",
          fileSystem,
          git: fakeGit(true),
          transactionId: () => "test",
        }),
      ).rejects.toThrow(/both owner versions were preserved/i);
    } finally {
      await displacedOwner.close();
    }

    expect(injected).toBe(true);
    await expect(readFile(gitignorePath, "utf8")).resolves.toContain(
      "atomic-owner/\n",
    );
    const preservedPaths = (await readdir(destination))
      .filter((name) => name.startsWith("gitignore.ultradyn-preserved-"))
      .map((name) => path.join(destination, name));
    expect(preservedPaths).toHaveLength(1);
    await expect(readFile(preservedPaths[0]!, "utf8")).resolves.toContain(
      "fd-held-owner/\n",
    );
  });

  it("preserves both owners when a held inode changes across repeated displacement", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(
      root,
      "existing-ignore-repeated-displacement",
    );
    const gitignorePath = path.join(destination, ".gitignore");
    await mkdir(destination);
    await writeFile(gitignorePath, "node_modules/\n# owner baseline\n");
    const displacedOwner = await open(gitignorePath, "r+");
    let displacementAttempts = 0;
    let restoreAttempts = 0;
    const fileSystem = createNodeFileSystem({
      async afterCompareAndSwapReplacementLink(context) {
        if (context.filePath !== gitignorePath) return;
        displacementAttempts += 1;
        await displacedOwner.truncate(0);
        await displacedOwner.writeFile(
          `${context.expectedContents}fd-held-owner-${displacementAttempts}/\n`,
        );
        await displacedOwner.sync();
      },
      async beforeCompareAndSwapDisplacedRestore(context) {
        if (context.filePath !== gitignorePath) return;
        restoreAttempts += 1;
        if (restoreAttempts !== 2) return;
        const atomicOwnerPath = `${gitignorePath}.atomic-owner`;
        await writeFile(
          atomicOwnerPath,
          `${context.expectedContents}atomic-owner/\n`,
        );
        await rename(atomicOwnerPath, gitignorePath);
      },
    });

    try {
      await expect(
        initializeDocumentationRepository({
          destination,
          packageRoot,
          packageVersion: "1.2.3",
          fileSystem,
          git: fakeGit(true),
          transactionId: () => "test",
        }),
      ).rejects.toThrow(/both owner versions were preserved/i);
    } finally {
      await displacedOwner.close();
    }

    expect(displacementAttempts).toBe(2);
    expect(restoreAttempts).toBe(2);
    await expect(readFile(gitignorePath, "utf8")).resolves.toContain(
      "atomic-owner/\n",
    );
    const preservedPaths = (await readdir(destination))
      .filter((name) => name.startsWith("gitignore.ultradyn-preserved-"))
      .map((name) => path.join(destination, name));
    expect(preservedPaths).toHaveLength(3);
    const preservedContents = await Promise.all(
      preservedPaths.map((preservedPath) => readFile(preservedPath, "utf8")),
    );
    expect(
      preservedContents.some((contents) =>
        contents.includes("fd-held-owner-2/\n"),
      ),
    ).toBe(true);
    expect(
      preservedContents.some((contents) =>
        contents.includes("atomic-owner/\n"),
      ),
    ).toBe(true);
  });

  it("does not unlink the only held-inode bytes after another owner replaces the restored path", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "existing-ignore-restore-cleanup-race");
    const gitignorePath = path.join(destination, ".gitignore");
    await mkdir(destination);
    await writeFile(gitignorePath, "node_modules/\n# owner baseline\n");
    const displacedOwner = await open(gitignorePath, "r+");
    let changedDisplacedOwner = false;
    let replacedRestoredPath = false;
    const fileSystem = createNodeFileSystem({
      async beforeCompareAndSwapCommit(context) {
        if (context.filePath !== gitignorePath || changedDisplacedOwner) return;
        changedDisplacedOwner = true;
        await displacedOwner.truncate(0);
        await displacedOwner.writeFile(
          `${context.expectedContents}fd-held-owner/\n`,
        );
        await displacedOwner.sync();
      },
      async afterCompareAndSwapDisplacedIdentity(context) {
        if (context.filePath !== gitignorePath || replacedRestoredPath) return;
        replacedRestoredPath = true;
        const atomicOwnerPath = `${gitignorePath}.atomic-owner`;
        await writeFile(
          atomicOwnerPath,
          `${context.expectedContents}atomic-owner/\n`,
        );
        await rename(atomicOwnerPath, gitignorePath);
      },
    });

    try {
      await expect(
        initializeDocumentationRepository({
          destination,
          packageRoot,
          packageVersion: "1.2.3",
          fileSystem,
          git: fakeGit(true),
          transactionId: () => "test",
        }),
      ).rejects.toThrow(/both owner versions were preserved/i);
    } finally {
      await displacedOwner.close();
    }

    expect(changedDisplacedOwner).toBe(true);
    expect(replacedRestoredPath).toBe(true);
    await expect(readFile(gitignorePath, "utf8")).resolves.toContain(
      "atomic-owner/\n",
    );
    const preservedPaths = (await readdir(destination))
      .filter((name) => name.startsWith("gitignore.ultradyn-preserved-"))
      .map((name) => path.join(destination, name));
    expect(preservedPaths).toHaveLength(1);
    await expect(readFile(preservedPaths[0]!, "utf8")).resolves.toContain(
      "fd-held-owner/\n",
    );
  });

  it("rolls back only its staging rule while preserving a later owner edit", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "existing-ignore-rollback-race");
    const gitignorePath = path.join(destination, ".gitignore");
    await mkdir(destination);
    await writeFile(
      gitignorePath,
      "node_modules/\r\n# keep without a final newline",
    );
    const base = createNodeFileSystem();
    const failingFileSystem: InstallerFileSystem = {
      ...base,
      async writeFile(target, contents) {
        if (target.endsWith(path.join(".ultradyn", "manifest.json"))) {
          const installedContents = await base.readFile(gitignorePath);
          await writeFile(
            gitignorePath,
            `concurrent-before/\r\n${installedContents}concurrent-after/\r\n`,
          );
          throw new Error("later manifest failure");
        }
        await base.writeFile(target, contents);
      },
    };

    await expect(
      initializeDocumentationRepository({
        destination,
        packageRoot,
        packageVersion: "1.2.3",
        fileSystem: failingFileSystem,
        git: fakeGit(true),
        transactionId: () => "test",
      }),
    ).rejects.toThrow("later manifest failure");

    await expect(readFile(gitignorePath, "utf8")).resolves.toBe(
      "concurrent-before/\r\nnode_modules/\r\n# keep without a final newline\r\nconcurrent-after/\r\n",
    );
  });

  it("rolls back its UUID marker block after owner newline normalization and marker reformatting", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "existing-ignore-normalized-rollback");
    const gitignorePath = path.join(destination, ".gitignore");
    await mkdir(destination);
    await writeFile(gitignorePath, "node_modules/\n");
    const base = createNodeFileSystem();
    const failingFileSystem: InstallerFileSystem = {
      ...base,
      async writeFile(target, contents) {
        if (target.endsWith(path.join(".ultradyn", "manifest.json"))) {
          const installed = await base.readFile(gitignorePath);
          const normalized = installed
            .replace(/\r\n|\r|\n/gu, "\r\n")
            .replace(
              /^(# (?:>>>|<<<) ultradyn-docs managed staging ignore [0-9a-f-]+)$/gmu,
              "  $1  ",
            );
          await writeFile(gitignorePath, normalized);
          throw new Error("later failure after owner normalization");
        }
        await base.writeFile(target, contents);
      },
    };

    await expect(
      initializeDocumentationRepository({
        destination,
        packageRoot,
        packageVersion: "1.2.3",
        fileSystem: failingFileSystem,
        git: fakeGit(true),
        transactionId: () => "test",
      }),
    ).rejects.toThrow("later failure after owner normalization");

    await expect(readFile(gitignorePath, "utf8")).resolves.toBe(
      "node_modules/\r\n",
    );
  });

  it("aggregates a managed-block rollback failure with the installation failure", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "existing-ignore-rollback-failure");
    const gitignorePath = path.join(destination, ".gitignore");
    await mkdir(destination);
    await writeFile(gitignorePath, "node_modules/\n");
    const base = createNodeFileSystem();
    const failingFileSystem: InstallerFileSystem = {
      ...base,
      async writeFile(target, contents) {
        if (target.endsWith(path.join(".ultradyn", "manifest.json")))
          throw new Error("primary installation failure");
        await base.writeFile(target, contents);
      },
      async compareAndSwapFile(target, expected, replacement) {
        if (
          target === gitignorePath &&
          expected.includes("ultradyn-docs managed") &&
          !replacement.includes("ultradyn-docs managed")
        )
          throw new Error("managed block rollback failure");
        return base.compareAndSwapFile(target, expected, replacement);
      },
    };

    let caught: unknown;
    try {
      await initializeDocumentationRepository({
        destination,
        packageRoot,
        packageVersion: "1.2.3",
        fileSystem: failingFileSystem,
        git: fakeGit(true),
        transactionId: () => "test",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(
      (caught as AggregateError).errors.map((error) =>
        error instanceof Error ? error.message : String(error),
      ),
    ).toEqual([
      "primary installation failure",
      "managed block rollback failure",
    ]);
  });

  it("removes only its managed ignore block while preserving reordered owner duplicates", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "existing-ignore-owned-rollback");
    const gitignorePath = path.join(destination, ".gitignore");
    await mkdir(destination);
    await writeFile(gitignorePath, "node_modules/\n");
    const base = createNodeFileSystem();
    const failingFileSystem: InstallerFileSystem = {
      ...base,
      async writeFile(target, contents) {
        if (target.endsWith(path.join(".ultradyn", "manifest.json"))) {
          const installed = await base.readFile(gitignorePath);
          await writeFile(
            gitignorePath,
            `owner-before/\n.ultradyn/staging/\n${installed}owner-after/\n.ultradyn/staging/\n`,
          );
          throw new Error("later manifest failure after owner reorder");
        }
        await base.writeFile(target, contents);
      },
    };

    await expect(
      initializeDocumentationRepository({
        destination,
        packageRoot,
        packageVersion: "1.2.3",
        fileSystem: failingFileSystem,
        git: fakeGit(true),
        transactionId: () => "test",
      }),
    ).rejects.toThrow("later manifest failure after owner reorder");

    const rolledBack = await readFile(gitignorePath, "utf8");
    expect(rolledBack).toBe(
      "owner-before/\n.ultradyn/staging/\nnode_modules/\nowner-after/\n.ultradyn/staging/\n",
    );
    expect(rolledBack).not.toContain("ultradyn-docs managed");
  });

  it("does not overwrite a file created after merge planning", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "existing-docs");
    await mkdir(destination);
    const base = createNodeFileSystem();
    const racedRelativePath = path.join("code", "server", "index.ts");
    const racingFileSystem: InstallerFileSystem = {
      ...base,
      async copyFile(
        source,
        target,
        options?: { readonly exclusive?: boolean },
      ) {
        if (target.endsWith(racedRelativePath)) {
          await writeFile(target, "concurrent owner\n", { flag: "wx" });
          if (options?.exclusive) {
            throw Object.assign(new Error("target appeared during install"), {
              code: "EEXIST",
            });
          }
        }
        await base.copyFile(source, target);
      },
    };

    const result = await initializeDocumentationRepository({
      destination,
      packageRoot,
      packageVersion: "1.2.3",
      fileSystem: racingFileSystem,
      git: fakeGit(),
      transactionId: () => "test",
    });

    expect(result.skipped).toContain(racedRelativePath);
    expect(result.written).not.toContain(racedRelativePath);
    await expect(
      readFile(path.join(destination, racedRelativePath), "utf8"),
    ).resolves.toBe("concurrent owner\n");
  });

  it("never deletes a raced-in target while rolling back a later failure", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "existing-docs");
    await mkdir(destination);
    const base = createNodeFileSystem();
    const racedRelativePath = path.join("code", "server", "index.ts");
    const failingRelativePath = path.join("docs", "architecture.md");
    const racingFileSystem: InstallerFileSystem = {
      ...base,
      async copyFile(
        source,
        target,
        options?: { readonly exclusive?: boolean },
      ) {
        if (target.endsWith(racedRelativePath)) {
          await writeFile(target, "concurrent owner\n", { flag: "wx" });
          if (options?.exclusive) {
            throw Object.assign(new Error("target appeared during install"), {
              code: "EEXIST",
            });
          }
        }
        if (target.endsWith(failingRelativePath)) {
          throw new Error("later disk failure");
        }
        await base.copyFile(source, target);
      },
    };

    let caught: unknown;
    try {
      await initializeDocumentationRepository({
        destination,
        packageRoot,
        packageVersion: "1.2.3",
        fileSystem: racingFileSystem,
        git: fakeGit(),
        transactionId: () => "test",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors[0]).toMatchObject({
      message: "later disk failure",
    });

    await expect(
      readFile(path.join(destination, racedRelativePath), "utf8"),
    ).resolves.toBe("concurrent owner\n");
  });

  it("rolls back every generated path if merging fails", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "existing-docs");
    await mkdir(destination);
    await writeFile(path.join(destination, "personal-notes.md"), "keep\n");
    const base = createNodeFileSystem();
    let copies = 0;
    const failingFileSystem: InstallerFileSystem = {
      ...base,
      async copyFile(source, target) {
        copies += 1;
        if (copies === 3) throw new Error("simulated disk failure");
        await base.copyFile(source, target);
      },
    };

    await expect(
      initializeDocumentationRepository({
        destination,
        packageRoot,
        packageVersion: "1.2.3",
        fileSystem: failingFileSystem,
        git: fakeGit(),
        transactionId: () => "test",
      }),
    ).rejects.toThrow("simulated disk failure");

    await expect(readdir(destination)).resolves.toEqual(["personal-notes.md"]);
    await expect(
      readFile(path.join(destination, "personal-notes.md"), "utf8"),
    ).resolves.toBe("keep\n");
  });

  it("does not expose a partial destination when creating fails", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "new-docs");
    const base = createNodeFileSystem();
    const failingFileSystem: InstallerFileSystem = {
      ...base,
      async copyFile() {
        throw new Error("simulated copy failure");
      },
    };

    await expect(
      initializeDocumentationRepository({
        destination,
        packageRoot,
        packageVersion: "1.2.3",
        fileSystem: failingFileSystem,
        git: fakeGit(),
        transactionId: () => "test",
      }),
    ).rejects.toThrow("simulated copy failure");

    await expect(readdir(root)).resolves.toEqual(["package"]);
  });

  it("refuses a colliding transaction directory without deleting its contents", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "new-docs");
    const stage = path.join(root, ".new-docs.ultradyn-tmp-collision");
    await mkdir(stage);
    await writeFile(path.join(stage, "owner.txt"), "do not remove\n");

    await expect(
      initializeDocumentationRepository({
        destination,
        packageRoot,
        packageVersion: "1.2.3",
        fileSystem: createNodeFileSystem(),
        git: fakeGit(),
        transactionId: () => "collision",
      }),
    ).rejects.toThrow(/temporary installation directory already exists/i);

    await expect(readFile(path.join(stage, "owner.txt"), "utf8")).resolves.toBe(
      "do not remove\n",
    );
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a partially initialized Git directory when Git fails", async () => {
    const { packageRoot, root } = await fixture();
    const destination = path.join(root, "existing-docs");
    await mkdir(destination);
    await writeFile(path.join(destination, "personal-notes.md"), "keep\n");
    const git: GitClient = {
      isRepository: vi.fn(async () => false),
      version: vi.fn(async () => "git version 2.45.2"),
      async init(directory) {
        await mkdir(path.join(directory, ".git"));
        await writeFile(path.join(directory, ".git", "HEAD"), "partial\n");
        throw new Error("git init failed");
      },
    };

    await expect(
      initializeDocumentationRepository({
        destination,
        packageRoot,
        packageVersion: "1.2.3",
        fileSystem: createNodeFileSystem(),
        git,
        transactionId: () => "test",
      }),
    ).rejects.toThrow("git init failed");

    await expect(readdir(destination)).resolves.toEqual(["personal-notes.md"]);
  });

  it("initializes native Git repositories on main", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ultradyn-native-git-"));
    temporaryDirectories.push(root);
    const destination = path.join(root, "docs");
    await mkdir(destination);

    await createNativeGitClient().init(destination);

    await expect(
      readFile(path.join(destination, ".git", "HEAD"), "utf8"),
    ).resolves.toBe("ref: refs/heads/main\n");
  });

  it("creates a repository for a new destination inside an ancestor worktree", async () => {
    const { packageRoot, root } = await fixture();
    const parentRepository = path.join(root, "monorepo");
    const destination = path.join(parentRepository, "network-docs");
    await mkdir(parentRepository);
    const git = createNativeGitClient();
    await git.init(parentRepository);

    const result = await initializeDocumentationRepository({
      destination,
      packageRoot,
      packageVersion: "1.2.3",
      fileSystem: createNodeFileSystem(),
      git,
      transactionId: () => "nested",
    });

    expect(result.gitInitialized).toBe(true);
    await expect(
      readFile(path.join(destination, ".git", "HEAD"), "utf8"),
    ).resolves.toBe("ref: refs/heads/main\n");
    await expect(git.isRepository(destination)).resolves.toBe(true);
  });
});

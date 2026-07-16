import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

    await expect(
      initializeDocumentationRepository({
        destination,
        packageRoot,
        packageVersion: "1.2.3",
        fileSystem: racingFileSystem,
        git: fakeGit(),
        transactionId: () => "test",
      }),
    ).rejects.toThrow("later disk failure");

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

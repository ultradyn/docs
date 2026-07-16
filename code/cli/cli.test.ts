import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROMPT_CANCELLED,
  createNodeFileSystem,
  runNodeCli,
  runCli,
  type CliDependencies,
  type CliProcessSignal,
  type CliSignalTarget,
  type CliTerminal,
  type CliUi,
  type FileKind,
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

async function packageFixture(): Promise<{
  root: string;
  packageRoot: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ultradyn-cli-process-"));
  temporaryDirectories.push(root);
  const packageRoot = path.join(root, "package");
  for (const directory of [
    "code/server",
    "tauri-app/src",
    ".codex/skills/tdd",
    "docs",
    ".plan",
    "scaffold/questions",
  ]) {
    await mkdir(path.join(packageRoot, directory), { recursive: true });
  }
  await writeFile(
    path.join(packageRoot, "code/server/index.ts"),
    "export {};\n",
  );
  await writeFile(
    path.join(packageRoot, "tauri-app/src/main.rs"),
    "fn main() {}\n",
  );
  await writeFile(
    path.join(packageRoot, ".codex/skills/tdd/SKILL.md"),
    "# TDD\n",
  );
  await writeFile(
    path.join(packageRoot, "docs/architecture.md"),
    "# Architecture\n",
  );
  await writeFile(
    path.join(packageRoot, ".plan/03-specification.md"),
    "# Specification\n",
  );
  await writeFile(path.join(packageRoot, "scaffold/questions/index.jsonl"), "");
  await writeFile(
    path.join(packageRoot, "package.json"),
    '{"name":"@ultradyn/docs","version":"1.2.3"}\n',
  );
  return { root, packageRoot };
}

function terminal(): CliTerminal & { stdout: string; stderr: string } {
  return {
    stdout: "",
    stderr: "",
    columns: 80,
    isTTY: false,
    color: false,
    unicode: false,
    writeOut(value) {
      this.stdout += value;
    },
    writeError(value) {
      this.stderr += value;
    },
  };
}

function ui(): CliUi {
  return {
    intro: vi.fn(),
    askDestination: vi.fn(async ({ initialValue }) => initialValue),
    confirm: vi.fn(async () => true),
    runTask: vi.fn(async (_message, task) => task()),
    success: vi.fn(),
    error: vi.fn(),
    cancel: vi.fn(),
    close: vi.fn(),
  };
}

function dependencies(
  overrides: Partial<CliDependencies> = {},
): CliDependencies {
  const output = terminal();
  const fileSystem: InstallerFileSystem = {
    kind: vi.fn(async (targetPath: string): Promise<FileKind> =>
      targetPath.endsWith(path.join(".ultradyn", "manifest.json"))
        ? "file"
        : "directory",
    ),
    list: vi.fn(async () => []),
    mode: vi.fn(async () => 0o644),
    readFile: vi.fn(async () =>
      JSON.stringify({
        schemaVersion: 1,
        package: { name: "@ultradyn/docs", version: "1.2.3" },
      }),
    ),
    mkdir: vi.fn(async () => undefined),
    mkdirExclusive: vi.fn(async () => undefined),
    copyFile: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    chmod: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    removeEmptyDirectory: vi.fn(async () => undefined),
  };
  const git: GitClient = {
    isRepository: vi.fn(async () => true),
    init: vi.fn(async () => undefined),
    version: vi.fn(async () => "git version 2.45.2"),
  };

  return {
    cwd: "/work/network",
    packageRoot: "/package",
    packageVersion: "1.2.3",
    nodeVersion: "22.17.0",
    environment: {},
    terminal: output,
    fileSystem,
    git,
    createUi: vi.fn(() => ui()),
    startServer: vi.fn(async () => 0),
    startMcp: vi.fn(async () => 0),
    now: () => new Date("2026-07-16T00:00:00.000Z"),
    transactionId: () => "test",
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("CLI process", () => {
  it("prints stable help and version output without taking ownership of stdin", async () => {
    const helpDependencies = dependencies();
    expect(await runCli(["--help"], helpDependencies)).toBe(0);
    expect(helpDependencies.terminal).toMatchObject({
      stderr: "",
      stdout: expect.stringContaining("ultradyn-docs init"),
    });
    expect(helpDependencies.createUi).not.toHaveBeenCalled();

    const versionDependencies = dependencies();
    expect(await runCli(["--version"], versionDependencies)).toBe(0);
    expect(versionDependencies.terminal).toMatchObject({
      stdout: "1.2.3\n",
      stderr: "",
    });
    expect(versionDependencies.createUi).not.toHaveBeenCalled();
  });

  it("dispatches serve arguments through the injected server hook", async () => {
    const startServer = vi.fn(async () => 0);
    const deps = dependencies({ startServer });

    expect(
      await runCli(
        ["serve", "./repo", "--port", "4312", "--maintainer", "--no-open"],
        deps,
      ),
    ).toBe(0);
    expect(startServer).toHaveBeenCalledWith({
      repository: "/work/network/repo",
      args: ["--port", "4312", "--maintainer", "--no-open"],
    });
    expect(deps.createUi).not.toHaveBeenCalled();
  });

  it("dispatches the stdio MCP host for the selected repository", async () => {
    const startMcp = vi.fn(async () => 0);
    const deps = dependencies({ startMcp });

    expect(await runCli(["mcp", "./repo"], deps)).toBe(0);
    expect(startMcp).toHaveBeenCalledWith({ repository: "/work/network/repo" });
    expect(deps.createUi).not.toHaveBeenCalled();
  });

  it("refuses to serve or start MCP against an uninitialized path", async () => {
    const startServer = vi.fn(async () => 0);
    const startMcp = vi.fn(async () => 0);
    const deps = dependencies({
      startServer,
      startMcp,
      fileSystem: {
        ...dependencies().fileSystem,
        kind: vi.fn(async (targetPath: string): Promise<FileKind> =>
          targetPath.endsWith(path.join(".ultradyn", "manifest.json"))
            ? "missing"
            : "directory",
        ),
      },
    });

    expect(await runCli(["serve", "./typo"], deps)).toBe(1);
    expect(await runCli(["mcp", "./typo"], deps)).toBe(1);
    expect(startServer).not.toHaveBeenCalled();
    expect(startMcp).not.toHaveBeenCalled();
    expect((deps.terminal as ReturnType<typeof terminal>).stderr).toContain(
      "not an initialized Ultradyn Docs repository",
    );
  });

  it("rejects a corrupt or foreign repository marker before startup", async () => {
    const startServer = vi.fn(async () => 0);
    const deps = dependencies({
      startServer,
      fileSystem: {
        ...dependencies().fileSystem,
        readFile: vi.fn(async () =>
          JSON.stringify({
            schemaVersion: 1,
            package: { name: "@someone/else", version: "1.0.0" },
          }),
        ),
      },
    });

    expect(await runCli(["serve", "./foreign"], deps)).toBe(1);
    expect(startServer).not.toHaveBeenCalled();
    expect((deps.terminal as ReturnType<typeof terminal>).stderr).toContain(
      "invalid Ultradyn Docs repository marker",
    );
  });

  it("returns 130 when the first destination prompt is cancelled", async () => {
    const promptUi = ui();
    vi.mocked(promptUi.askDestination).mockResolvedValue(PROMPT_CANCELLED);
    const deps = dependencies({ createUi: vi.fn(() => promptUi) });

    expect(await runCli([], deps)).toBe(130);
    expect(promptUi.intro).toHaveBeenCalledBefore(
      vi.mocked(promptUi.askDestination),
    );
    expect(promptUi.confirm).not.toHaveBeenCalled();
    expect(promptUi.cancel).toHaveBeenCalledWith("Installation cancelled.");
    expect(promptUi.close).toHaveBeenCalled();
  });

  it("rolls back and returns 130 when Ctrl+C interrupts file copying", async () => {
    const { root, packageRoot } = await packageFixture();
    const cwd = path.join(root, "work");
    await mkdir(cwd);
    const target = path.join(cwd, "docs");
    const controller = new AbortController();
    const base = createNodeFileSystem();
    let copied = false;
    const interruptingFileSystem: InstallerFileSystem = {
      ...base,
      async copyFile(source, destination) {
        await base.copyFile(source, destination);
        if (!copied) {
          copied = true;
          controller.abort();
        }
      },
    };
    const promptUi = ui();
    const deps = dependencies({
      cwd,
      packageRoot,
      fileSystem: interruptingFileSystem,
      git: fakeProcessGit(false),
      createUi: vi.fn(() => promptUi),
      signal: controller.signal,
    });

    expect(
      await runCli(["init", "--dir", target, "--yes", "--plain"], deps),
    ).toBe(130);
    expect(promptUi.cancel).toHaveBeenCalledWith("Installation cancelled.");
    await expect(readFile(target, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("asks for the destination first and initializes the selected repository", async () => {
    const { root, packageRoot } = await packageFixture();
    const cwd = path.join(root, "Network Protocol");
    await mkdir(cwd);
    await writeFile(path.join(cwd, "notes.md"), "existing cwd content\n");
    const promptUi = ui();
    const output = terminal();
    Object.assign(output, { isTTY: true, color: true, unicode: true });
    const git = fakeProcessGit(false);
    const deps = dependencies({
      cwd,
      packageRoot,
      terminal: output,
      fileSystem: createNodeFileSystem(),
      git,
      createUi: vi.fn(() => promptUi),
    });

    expect(await runCli([], deps)).toBe(0);

    expect(promptUi.askDestination).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "./network-protocol-docs" }),
    );
    expect(promptUi.askDestination).toHaveBeenCalledBefore(
      vi.mocked(promptUi.confirm),
    );
    expect(git.init).toHaveBeenCalledTimes(1);
    await expect(
      readFile(
        path.join(cwd, "network-protocol-docs", "code", "server", "index.ts"),
        "utf8",
      ),
    ).resolves.toBe("export {};\n");
  });

  it("supports unattended plain installation without creating a prompt owner", async () => {
    const { root, packageRoot } = await packageFixture();
    const cwd = path.join(root, "work");
    await mkdir(cwd);
    const promptUi = ui();
    const createUi = vi.fn(() => promptUi);
    const deps = dependencies({
      cwd,
      packageRoot,
      fileSystem: createNodeFileSystem(),
      git: fakeProcessGit(false),
      createUi,
    });

    expect(
      await runCli(
        ["init", "--dir", "./docs", "--yes", "--plain", "--no-color"],
        deps,
      ),
    ).toBe(0);

    expect(createUi).toHaveBeenCalledOnce();
    expect(createUi).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "plain", color: false, unicode: false }),
    );
    expect(promptUi.intro).toHaveBeenCalledWith({
      destination: "./docs",
      suggested: false,
    });
    expect(promptUi.askDestination).not.toHaveBeenCalled();
    expect(promptUi.confirm).not.toHaveBeenCalled();
    await expect(
      readFile(path.join(cwd, "docs", ".ultradyn", "manifest.json"), "utf8"),
    ).resolves.toContain('"version": "1.2.3"');
  });

  it("honors NODE_DISABLE_COLORS as a plain terminal contract", async () => {
    const interactiveTerminal = {
      ...terminal(),
      isTTY: true,
      color: true,
      unicode: true,
    };
    const createUi = vi.fn(() => ui());
    const deps = dependencies({
      environment: { NODE_DISABLE_COLORS: "1" },
      terminal: interactiveTerminal,
      createUi,
    });

    await runCli(["init", "--dir", "./docs", "--yes"], deps);
    expect(createUi).toHaveBeenCalledWith({
      mode: "plain",
      color: false,
      unicode: false,
      width: 80,
    });
  });

  it("reports required local tools through doctor", async () => {
    const deps = dependencies();

    expect(await runCli(["doctor", "--json"], deps)).toBe(0);
    const report = JSON.parse(
      (deps.terminal as ReturnType<typeof terminal>).stdout,
    ) as {
      ok: boolean;
      checks: { name: string; ok: boolean }[];
    };
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual([
      "Node.js",
      "Git",
      "Package source",
    ]);
    expect(deps.createUi).not.toHaveBeenCalled();
  });

  it("rejects unsupported Node versions and invalid options with useful exit codes", async () => {
    const oldNode = dependencies({ nodeVersion: "20.19.0" });
    expect(await runCli(["doctor"], oldNode)).toBe(1);
    expect((oldNode.terminal as ReturnType<typeof terminal>).stderr).toContain(
      "requires Node.js 22",
    );

    const belowToolchainFloor = dependencies({ nodeVersion: "22.12.0" });
    expect(await runCli(["doctor"], belowToolchainFloor)).toBe(1);
    expect(
      (belowToolchainFloor.terminal as ReturnType<typeof terminal>).stderr,
    ).toContain("requires Node.js 22.13");

    const oddNode = dependencies({ nodeVersion: "23.11.0" });
    expect(await runCli(["doctor"], oddNode)).toBe(1);

    const invalid = dependencies();
    expect(await runCli(["init", "--unknown"], invalid)).toBe(2);
    expect((invalid.terminal as ReturnType<typeof terminal>).stderr).toContain(
      "Unknown install option",
    );
    expect(invalid.createUi).not.toHaveBeenCalled();
  });

  it("maps SIGTERM to 143 through the public Node CLI seam", async () => {
    const listeners = new Map<string, () => void>();
    const signalTarget = {
      once(signal: "SIGINT" | "SIGTERM", listener: () => void) {
        listeners.set(signal, listener);
        if (signal === "SIGTERM") listener();
      },
      off(signal: "SIGINT" | "SIGTERM", listener: () => void) {
        if (listeners.get(signal) === listener) listeners.delete(signal);
      },
    };
    const createDependencies = vi.fn(async () => dependencies());

    await expect(
      runNodeCli(["--help"], { signalTarget, createDependencies }),
    ).resolves.toBe(143);
    expect(createDependencies).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "rolls back an interrupted install and returns the conventional %s code",
    async (signalName, exitCode) => {
      const { root, packageRoot } = await packageFixture();
      const cwd = path.join(root, "work");
      await mkdir(cwd);
      const target = path.join(cwd, "docs");
      const listeners = new Map<CliProcessSignal, () => void>();
      const signalTarget: CliSignalTarget & {
        emit(signal: CliProcessSignal): void;
      } = {
        once(signal, listener) {
          listeners.set(signal, listener);
        },
        off(signal, listener) {
          if (listeners.get(signal) === listener) listeners.delete(signal);
        },
        emit(signal) {
          const listener = listeners.get(signal);
          listeners.delete(signal);
          listener?.();
        },
      };
      const base = createNodeFileSystem();
      let signaled = false;
      const interruptingFileSystem: InstallerFileSystem = {
        ...base,
        async copyFile(source, destination, options) {
          await base.copyFile(source, destination, options);
          if (!signaled) {
            signaled = true;
            signalTarget.emit(signalName);
          }
        },
      };
      const promptUi = ui();

      await expect(
        runNodeCli(["init", "--dir", target, "--yes", "--plain"], {
          signalTarget,
          createDependencies: async ({ signal }) =>
            dependencies({
              cwd,
              packageRoot,
              fileSystem: interruptingFileSystem,
              git: fakeProcessGit(false),
              createUi: vi.fn(() => promptUi),
              signal,
            }),
        }),
      ).resolves.toBe(exitCode);

      expect(promptUi.cancel).toHaveBeenCalledWith("Installation cancelled.");
      await expect(readdir(cwd)).resolves.toEqual([]);
      expect(listeners.size).toBe(0);
    },
  );
});

function fakeProcessGit(
  initiallyRepository: boolean,
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
    isRepository: vi.fn(async () => repository),
    init,
    version: vi.fn(async () => "git version 2.45.2"),
  };
}

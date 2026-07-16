import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import isUnicodeSupported from "is-unicode-supported";

import {
  FixtureAgentLlmProvider,
  startAgentMcpStdioHost,
} from "../mcp/index.js";
import { RepositorySettingsStore } from "../repository/index.js";
import {
  createDefaultProviderRuntimeFactory,
  localDataRootForRepository,
  startUltradynServer,
} from "../server/index.js";
import { createNodeFileSystem, type GitClient } from "./installer.js";
import { runCli, type CliDependencies, type CliTerminal } from "./runtime.js";
import { createTerminalUi } from "./ui.js";

const executeFile = promisify(execFile);

export type CliProcessSignal = "SIGINT" | "SIGTERM";

export interface CliSignalTarget {
  once(signal: CliProcessSignal, listener: () => void): void;
  off(signal: CliProcessSignal, listener: () => void): void;
}

export interface RunNodeCliOptions {
  readonly signalTarget?: CliSignalTarget;
  readonly createDependencies?: (options: {
    readonly signal: AbortSignal;
  }) => Promise<CliDependencies>;
}

export async function createNodeCliDependencies(
  options: {
    readonly importMetaUrl?: string;
    readonly packageRoot?: string;
    readonly startServer?: CliDependencies["startServer"];
    readonly startMcp?: CliDependencies["startMcp"];
    readonly signal?: AbortSignal;
  } = {},
): Promise<CliDependencies> {
  const packageRoot =
    options.packageRoot ??
    (await locatePackageRoot(options.importMetaUrl ?? import.meta.url));
  const packageMetadata = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as { name?: string; version?: string };
  if (
    packageMetadata.name !== "@ultradyn/docs" ||
    packageMetadata.version === undefined
  ) {
    throw new Error(
      `Invalid @ultradyn/docs package metadata at ${packageRoot}`,
    );
  }
  const packageVersion = packageMetadata.version;

  const noColor =
    process.env.NO_COLOR !== undefined ||
    process.env.NODE_DISABLE_COLORS !== undefined;
  const terminal: CliTerminal = {
    columns: process.stdout.columns ?? 80,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    color:
      !noColor &&
      (process.stdout.hasColors?.() ?? Boolean(process.stdout.isTTY)),
    unicode: isUnicodeSupported(),
    writeOut(value) {
      process.stdout.write(value);
    },
    writeError(value) {
      process.stderr.write(value);
    },
  };
  const fileSystem = createNodeFileSystem();
  const git = createNativeGitClient();

  return {
    cwd: process.cwd(),
    packageRoot,
    packageVersion,
    nodeVersion: process.versions.node,
    environment: process.env,
    terminal,
    fileSystem,
    git,
    createUi: (appearance) =>
      createTerminalUi({
        appearance,
        terminal,
        input: process.stdin,
        output: process.stdout,
      }),
    startServer:
      options.startServer ??
      ((input) =>
        runNodeServer(input, {
          packageRoot,
          version: packageVersion,
          terminal,
        })),
    startMcp:
      options.startMcp ??
      ((input) =>
        runNodeMcp(input, {
          packageRoot,
          version: packageVersion,
          signal: options.signal ?? new AbortController().signal,
        })),
    now: () => new Date(),
    transactionId: () =>
      `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    signal: options.signal ?? new AbortController().signal,
  };
}

async function runNodeMcp(
  input: { readonly repository: string },
  context: {
    packageRoot: string;
    version: string;
    signal: AbortSignal;
  },
): Promise<number> {
  const repository = path.resolve(input.repository);
  const dataRoot = localDataRootForRepository(repository);
  const settings = await new RepositorySettingsStore(
    repository,
    path.join(dataRoot, "settings.json"),
  ).readMerged();
  const definitionsRoot = existsSync(path.join(repository, "agents"))
    ? path.join(repository, "agents")
    : path.join(context.packageRoot, "scaffold", "agents");
  const runtime = createDefaultProviderRuntimeFactory({
    repoRoot: repository,
    dataRoot,
  });
  const selected = settings.effective.providers.llm;
  const resolution = await runtime.resolveLlm(selected);
  if (resolution.state === "blocked") {
    throw new Error(
      `${resolution.message} ${resolution.activationChecklist.join(" ")}`,
    );
  }
  const provider =
    selected === "fake-llm"
      ? new FixtureAgentLlmProvider(definitionsRoot)
      : resolution.provider;
  const server = await startAgentMcpStdioHost({
    definitionsRoot,
    provider,
    name: "ultradyn-docs",
    version: context.version,
  });
  if (context.signal.aborted) {
    await server.close();
    return 130;
  }
  return new Promise<number>((resolve) => {
    let closed = false;
    const close = (code: number) => {
      if (closed) return;
      closed = true;
      context.signal.removeEventListener("abort", onAbort);
      process.stdin.off("end", onEnd);
      void server.close().finally(() => resolve(code));
    };
    const onAbort = () => close(130);
    const onEnd = () => close(0);
    context.signal.addEventListener("abort", onAbort, { once: true });
    process.stdin.once("end", onEnd);
    process.stdin.resume();
  });
}

export function createNativeGitClient(): GitClient {
  return {
    async isRepository(directory) {
      try {
        const { stdout } = await executeFile(
          "git",
          ["-C", directory, "rev-parse", "--show-toplevel"],
          {
            windowsHide: true,
          },
        );
        const [topLevel, selected] = await Promise.all([
          realpath(stdout.trim()),
          realpath(directory),
        ]);
        const normalize = (value: string) =>
          process.platform === "win32" ? value.toLocaleLowerCase() : value;
        return normalize(topLevel) === normalize(selected);
      } catch {
        return false;
      }
    },
    async init(directory) {
      try {
        await executeFile(
          "git",
          ["init", "--quiet", "--initial-branch=main", directory],
          { windowsHide: true },
        );
      } catch (error) {
        const diagnostic = commandDiagnostic(error);
        if (!/unknown option|usage:\s*git init/i.test(diagnostic)) throw error;
        await executeFile("git", ["init", "--quiet", directory], {
          windowsHide: true,
        });
        await executeFile(
          "git",
          ["-C", directory, "symbolic-ref", "HEAD", "refs/heads/main"],
          { windowsHide: true },
        );
      }
    },
    async version() {
      try {
        const { stdout } = await executeFile("git", ["--version"], {
          windowsHide: true,
        });
        return stdout.trim();
      } catch {
        return null;
      }
    },
  };
}

export async function locatePackageRoot(
  importMetaUrl: string,
): Promise<string> {
  let cursor = path.dirname(fileURLToPath(importMetaUrl));
  while (true) {
    try {
      const metadata = JSON.parse(
        await readFile(path.join(cursor, "package.json"), "utf8"),
      ) as {
        name?: string;
      };
      if (metadata.name === "@ultradyn/docs") return cursor;
    } catch {
      // Keep walking: source execution and bundled execution begin at different depths.
    }
    const parent = path.dirname(cursor);
    if (parent === cursor)
      throw new Error("Could not locate the @ultradyn/docs package root.");
    cursor = parent;
  }
}

export async function runNodeCli(
  argv: readonly string[],
  options: RunNodeCliOptions = {},
): Promise<number> {
  const controller = new AbortController();
  const ownsSignals = argv[0] !== "serve";
  const signalTarget = options.signalTarget ?? nodeProcessSignalTarget;
  let signalExitCode: 130 | 143 | undefined;
  const abortFromSignal = (exitCode: 130 | 143) => {
    signalExitCode ??= exitCode;
    controller.abort();
  };
  const onInterrupt = () => abortFromSignal(130);
  const onTerminate = () => abortFromSignal(143);
  if (ownsSignals) {
    signalTarget.once("SIGINT", onInterrupt);
    signalTarget.once("SIGTERM", onTerminate);
  }
  try {
    const createDependencies =
      options.createDependencies ?? createNodeCliDependencies;
    const dependencies = await createDependencies({
      signal: controller.signal,
    });
    const result = await runCli(argv, dependencies);
    return signalExitCode ?? result;
  } catch (error) {
    if (signalExitCode !== undefined) return signalExitCode;
    throw error;
  } finally {
    if (ownsSignals) {
      signalTarget.off("SIGINT", onInterrupt);
      signalTarget.off("SIGTERM", onTerminate);
    }
  }
}

const nodeProcessSignalTarget: CliSignalTarget = {
  once(signal, listener) {
    process.once(signal, listener);
  },
  off(signal, listener) {
    process.off(signal, listener);
  },
};

async function runNodeServer(
  input: { readonly repository: string; readonly args: readonly string[] },
  context: {
    readonly packageRoot: string;
    readonly version: string;
    readonly terminal: CliTerminal;
  },
): Promise<number> {
  const options = parseServerArguments(input.args);
  const abort = new AbortController();
  const running = await startUltradynServer({
    repoRoot: input.repository,
    packageRoot: context.packageRoot,
    version: context.version,
    ...(process.env.ULTRADYN_DOCS_LAUNCH_NONCE
      ? { desktopLauncherNonce: process.env.ULTRADYN_DOCS_LAUNCH_NONCE }
      : {}),
    ...options,
    signal: abort.signal,
    onListening: (url) =>
      context.terminal.writeOut(`Ultradyn Docs is running at ${url}\n`),
  });

  return new Promise((resolve) => {
    let closing = false;
    const stop = (exitCode: number) => {
      if (closing) return;
      closing = true;
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      abort.abort();
      void running.close().finally(() => resolve(exitCode));
    };
    const onInterrupt = () => stop(130);
    const onTerminate = () => stop(143);
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
  });
}

function parseServerArguments(args: readonly string[]): {
  host?: string;
  port?: number;
  openBrowser?: boolean;
  maintenanceEnabled?: boolean;
  demoMode?: boolean;
  dev?: boolean;
  allowedHostnames?: string[];
  allowOrigin?: string[];
} {
  const output: {
    host?: string;
    port?: number;
    openBrowser?: boolean;
    maintenanceEnabled?: boolean;
    demoMode?: boolean;
    dev?: boolean;
    allowedHostnames?: string[];
    allowOrigin?: string[];
  } = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-open") output.openBrowser = false;
    else if (argument === "--maintainer") output.maintenanceEnabled = true;
    else if (argument === "--demo") output.demoMode = true;
    else if (argument === "--no-demo") output.demoMode = false;
    else if (argument === "--dev") output.dev = true;
    else if (argument === "--allowed-host") {
      output.allowedHostnames = [
        ...(output.allowedHostnames ?? []),
        requireServerValue(args, ++index, "--allowed-host"),
      ];
    } else if (argument?.startsWith("--allowed-host=")) {
      output.allowedHostnames = [
        ...(output.allowedHostnames ?? []),
        argument.slice("--allowed-host=".length),
      ];
    } else if (argument === "--allow-origin") {
      output.allowOrigin = [
        ...(output.allowOrigin ?? []),
        requireServerValue(args, ++index, "--allow-origin"),
      ];
    } else if (argument?.startsWith("--allow-origin=")) {
      output.allowOrigin = [
        ...(output.allowOrigin ?? []),
        argument.slice("--allow-origin=".length),
      ];
    } else if (argument === "--host") {
      output.host = requireServerValue(args, ++index, "--host");
    } else if (argument?.startsWith("--host="))
      output.host = argument.slice("--host=".length);
    else if (argument === "--port") {
      output.port = parsePort(requireServerValue(args, ++index, "--port"));
    } else if (argument?.startsWith("--port="))
      output.port = parsePort(argument.slice("--port=".length));
    else throw new Error(`Unknown serve option: ${argument ?? ""}`);
  }
  return output;
}

function requireServerValue(
  args: readonly string[],
  index: number,
  option: string,
): string {
  const value = args[index];
  if (value === undefined || value.startsWith("-"))
    throw new Error(`${option} requires a value.`);
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function commandDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const detail = error as Error & { stderr?: string; stdout?: string };
  return `${error.message}\n${detail.stderr ?? ""}\n${detail.stdout ?? ""}`;
}

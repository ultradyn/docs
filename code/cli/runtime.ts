import path from "node:path";
import { z } from "zod";

import {
  initializeDocumentationRepository,
  type GitClient,
  type InitializationResult,
  type InstallerFileSystem,
} from "./installer.js";
import { suggestDestination } from "./destination.js";

export const PROMPT_CANCELLED: unique symbol = Symbol(
  "ultradyn-docs.prompt-cancelled",
);

export interface CliTerminal {
  readonly columns: number;
  readonly isTTY: boolean;
  readonly color: boolean;
  readonly unicode: boolean;
  writeOut(value: string): void;
  writeError(value: string): void;
}

export interface UiAppearance {
  readonly mode: "interactive" | "plain";
  readonly color: boolean;
  readonly unicode: boolean;
  readonly width: number;
}

export interface CliUi {
  intro(input: {
    readonly destination: string;
    readonly suggested: boolean;
  }): void | Promise<void>;
  askDestination(input: {
    readonly initialValue: string;
    readonly validate: (value: string) => string | undefined;
  }): Promise<string | typeof PROMPT_CANCELLED>;
  confirm(input: {
    readonly destination: string;
    readonly description: string;
  }): Promise<boolean | typeof PROMPT_CANCELLED>;
  runTask<T>(message: string, task: () => Promise<T>): Promise<T>;
  success(input: {
    readonly destination: string;
    readonly written: number;
    readonly skipped: number;
    readonly gitInitialized: boolean;
  }): void | Promise<void>;
  error(message: string): void | Promise<void>;
  cancel(message: string): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface CliDependencies {
  readonly cwd: string;
  readonly packageRoot: string;
  readonly packageVersion: string;
  readonly nodeVersion: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly terminal: CliTerminal;
  readonly fileSystem: InstallerFileSystem;
  readonly git: GitClient;
  readonly createUi: (appearance: UiAppearance) => CliUi;
  readonly startServer: (input: {
    readonly repository: string;
    readonly args: readonly string[];
  }) => Promise<number | void>;
  readonly startMcp: (input: {
    readonly repository: string;
  }) => Promise<number | void>;
  readonly now: () => Date;
  readonly transactionId: () => string;
  readonly signal: AbortSignal;
}

type Command = "init" | "serve" | "mcp" | "doctor" | "help" | "version";

interface ParsedCommand {
  command: Command;
  args: readonly string[];
}

interface InitArguments {
  directory?: string;
  yes: boolean;
  plain: boolean;
  noColor: boolean;
}

const HELP = `Ultradyn Docs — question-driven, Git-backed documentation

Usage:
  ultradyn-docs [init] [directory] [options]
  ultradyn-docs init [directory] [options]
  ultradyn-docs serve [repository] [server options]
  ultradyn-docs mcp [repository]
  ultradyn-docs doctor [--json]

Install options:
  -d, --dir <path>  Destination for the documentation repository
  -y, --yes        Accept the suggested destination and skip confirmation
      --plain      Stable text output; suitable for logs and simple terminals
      --no-color   Disable ANSI color

Server exposure options:
      --host <host>             Bind address (loopback by default)
      --port <port>             Listening port (4173 by default)
      --allowed-host <hostname> Required for wildcard binds; repeatable
      --allow-origin <origin>   Additional exact browser origin; repeatable
  -h, --help       Show this help
  -v, --version    Print the installed package version

Examples:
  npx @ultradyn/docs
  npx @ultradyn/docs init --dir ./network-docs --yes --plain
  npx @ultradyn/docs serve ./network-docs --maintainer
  npx @ultradyn/docs mcp ./network-docs
`;

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  let parsed: ParsedCommand;
  try {
    parsed = parseCommand(argv);
  } catch (error) {
    dependencies.terminal.writeError(
      `${messageFrom(error)}\n\nRun with --help for usage.\n`,
    );
    return 2;
  }

  if (parsed.command === "help") {
    dependencies.terminal.writeOut(HELP);
    return 0;
  }
  if (parsed.command === "version") {
    dependencies.terminal.writeOut(`${dependencies.packageVersion}\n`);
    return 0;
  }
  if (!isSupportedNodeVersion(dependencies.nodeVersion)) {
    dependencies.terminal.writeError(
      `Ultradyn Docs requires Node.js 22.13+ or 24+ (found ${dependencies.nodeVersion}).\n`,
    );
    return 1;
  }

  if (parsed.command === "serve") return runServe(parsed.args, dependencies);
  if (parsed.command === "mcp") return runMcp(parsed.args, dependencies);
  if (parsed.command === "doctor") return runDoctor(parsed.args, dependencies);

  let initArguments: InitArguments;
  try {
    initArguments = parseInitArguments(parsed.args);
  } catch (error) {
    dependencies.terminal.writeError(
      `${messageFrom(error)}\n\nRun with --help for usage.\n`,
    );
    return 2;
  }
  return runInit(initArguments, dependencies);
}

async function runMcp(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  if (args.length > 1 || args[0]?.startsWith("-")) {
    dependencies.terminal.writeError(
      "mcp accepts only an optional repository path.\n",
    );
    return 2;
  }
  const repository = path.resolve(dependencies.cwd, args[0] ?? ".");
  try {
    await assertInitializedRepository(repository, dependencies.fileSystem);
    return (await dependencies.startMcp({ repository })) ?? 0;
  } catch (error) {
    dependencies.terminal.writeError(
      `Could not start the Ultradyn agent MCP host: ${messageFrom(error)}\n`,
    );
    return 1;
  }
}

async function runServe(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const [first, ...rest] = args;
  const hasRepository = first !== undefined && !first.startsWith("-");
  const repository = path.resolve(
    dependencies.cwd,
    hasRepository ? first : ".",
  );
  const serverArguments = hasRepository ? rest : args;
  try {
    await assertInitializedRepository(repository, dependencies.fileSystem);
    return (
      (await dependencies.startServer({ repository, args: serverArguments })) ??
      0
    );
  } catch (error) {
    dependencies.terminal.writeError(
      `Could not start Ultradyn Docs: ${messageFrom(error)}\n`,
    );
    return 1;
  }
}

async function runDoctor(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const json = args.length === 1 && args[0] === "--json";
  if (args.length > (json ? 1 : 0)) {
    dependencies.terminal.writeError("doctor accepts only --json.\n");
    return 2;
  }

  const gitVersion = await dependencies.git.version().catch(() => null);
  const requiredSources = ["code", "tauri-app", ".codex/skills"];
  const missingSources: string[] = [];
  for (const source of requiredSources) {
    if (
      (await dependencies.fileSystem.kind(
        path.join(dependencies.packageRoot, source),
      )) !== "directory"
    ) {
      missingSources.push(source);
    }
  }
  const checks = [
    { name: "Node.js", ok: true, detail: dependencies.nodeVersion },
    { name: "Git", ok: gitVersion !== null, detail: gitVersion ?? "not found" },
    {
      name: "Package source",
      ok: missingSources.length === 0,
      detail:
        missingSources.length === 0
          ? "complete"
          : `missing ${missingSources.join(", ")}`,
    },
  ];
  if (json)
    dependencies.terminal.writeOut(
      `${JSON.stringify({ ok: checks.every((check) => check.ok), checks }, null, 2)}\n`,
    );
  else {
    dependencies.terminal.writeOut("Ultradyn Docs doctor\n\n");
    for (const check of checks) {
      const symbol = dependencies.terminal.unicode
        ? check.ok
          ? "✓"
          : "✗"
        : check.ok
          ? "OK"
          : "!!";
      dependencies.terminal.writeOut(
        `${symbol} ${check.name}: ${check.detail}\n`,
      );
    }
  }
  return checks.every((check) => check.ok) ? 0 : 1;
}

async function runInit(
  arguments_: InitArguments,
  dependencies: CliDependencies,
): Promise<number> {
  const environmentDisablesColor =
    dependencies.environment.NO_COLOR !== undefined ||
    dependencies.environment.NODE_DISABLE_COLORS !== undefined;
  const plainFallback =
    arguments_.plain ||
    arguments_.noColor ||
    environmentDisablesColor ||
    !dependencies.terminal.isTTY ||
    !dependencies.terminal.unicode;
  const appearance: UiAppearance = {
    mode: plainFallback ? "plain" : "interactive",
    color:
      !arguments_.plain &&
      !arguments_.noColor &&
      !environmentDisablesColor &&
      dependencies.terminal.color,
    unicode: !plainFallback && dependencies.terminal.unicode,
    width: Math.max(20, dependencies.terminal.columns),
  };
  const userInterface = dependencies.createUi(appearance);

  try {
    const entries = await dependencies.fileSystem.list(dependencies.cwd);
    const suggestion = suggestDestination(
      dependencies.cwd,
      entries.map((entry) => entry.name),
    );
    await userInterface.intro({
      destination: arguments_.directory ?? suggestion,
      suggested: arguments_.directory === undefined,
    });

    let destinationInput = arguments_.directory;
    if (destinationInput === undefined) {
      if (arguments_.yes) destinationInput = suggestion;
      else {
        const answer = await userInterface.askDestination({
          initialValue: suggestion,
          validate: validateDestination,
        });
        if (answer === PROMPT_CANCELLED) return await cancel(userInterface);
        destinationInput = answer;
      }
    }
    const validationError = validateDestination(destinationInput);
    if (validationError !== undefined) throw new Error(validationError);
    const destination = path.resolve(dependencies.cwd, destinationInput);

    if (!arguments_.yes) {
      const answer = await userInterface.confirm({
        destination,
        description:
          "Copy the inspectable app source, starter documentation, project skills, and version manifest.",
      });
      if (answer === PROMPT_CANCELLED || answer === false)
        return await cancel(userInterface);
    }

    const result = await userInterface.runTask(
      "Creating your documentation repository",
      () =>
        initializeDocumentationRepository({
          destination,
          packageRoot: dependencies.packageRoot,
          packageVersion: dependencies.packageVersion,
          fileSystem: dependencies.fileSystem,
          git: dependencies.git,
          now: dependencies.now,
          transactionId: dependencies.transactionId,
          signal: dependencies.signal,
        }),
    );
    await announceSuccess(userInterface, result);
    return 0;
  } catch (error) {
    if (dependencies.signal.aborted) return await cancel(userInterface);
    await userInterface.error(messageFrom(error));
    return 1;
  } finally {
    await userInterface.close();
  }
}

async function announceSuccess(
  userInterface: CliUi,
  result: InitializationResult,
): Promise<void> {
  await userInterface.success({
    destination: result.destination,
    written: result.written.length,
    skipped: result.skipped.length,
    gitInitialized: result.gitInitialized,
  });
}

async function cancel(userInterface: CliUi): Promise<130> {
  await userInterface.cancel("Installation cancelled.");
  return 130;
}

function parseCommand(argv: readonly string[]): ParsedCommand {
  if (argv.includes("--help") || argv.includes("-h"))
    return { command: "help", args: [] };
  if (argv.includes("--version") || argv.includes("-v"))
    return { command: "version", args: [] };
  const [first, ...rest] = argv;
  if (first === undefined || first.startsWith("-"))
    return { command: "init", args: argv };
  if (
    first === "init" ||
    first === "serve" ||
    first === "mcp" ||
    first === "doctor"
  )
    return { command: first, args: rest };
  if (first === "help") return { command: "help", args: rest };
  if (first === "version") return { command: "version", args: rest };
  if (!first.startsWith("-")) return { command: "init", args: argv };
  throw new Error(`Unknown command: ${first}`);
}

function parseInitArguments(args: readonly string[]): InitArguments {
  let directory: string | undefined;
  let yes = false;
  let plain = false;
  let noColor = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--yes" || argument === "-y") yes = true;
    else if (argument === "--plain") plain = true;
    else if (argument === "--no-color") noColor = true;
    else if (argument === "--dir" || argument === "-d") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-"))
        throw new Error(`${argument} requires a path.`);
      if (directory !== undefined)
        throw new Error("Specify the destination only once.");
      directory = value;
      index += 1;
    } else if (argument?.startsWith("--dir=")) {
      if (directory !== undefined)
        throw new Error("Specify the destination only once.");
      directory = argument.slice("--dir=".length);
    } else if (argument?.startsWith("-"))
      throw new Error(`Unknown install option: ${argument}`);
    else if (argument !== undefined) {
      if (directory !== undefined)
        throw new Error("Specify the destination only once.");
      directory = argument;
    }
  }

  return {
    ...(directory === undefined ? {} : { directory }),
    yes,
    plain,
    noColor,
  };
}

function validateDestination(value: string): string | undefined {
  if (value.trim() === "") return "Enter a destination directory.";
  if (value.includes("\0"))
    return "The destination contains an invalid null character.";
  return undefined;
}

function isSupportedNodeVersion(version: string): boolean {
  const [majorText, minorText] = version.replace(/^v/, "").split(".");
  const major = Number.parseInt(majorText ?? "", 10);
  const minor = Number.parseInt(minorText ?? "", 10);
  return (
    Number.isFinite(major) &&
    Number.isFinite(minor) &&
    (major >= 24 || (major === 22 && minor >= 13))
  );
}

const repositoryMarkerSchema = z.object({
  schemaVersion: z.literal(1),
  package: z.object({
    name: z.literal("@ultradyn/docs"),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u),
  }),
});

async function assertInitializedRepository(
  repository: string,
  fileSystem: InstallerFileSystem,
): Promise<void> {
  const marker = path.join(repository, ".ultradyn", "manifest.json");
  if (
    (await fileSystem.kind(repository)) !== "directory" ||
    (await fileSystem.kind(marker)) !== "file"
  ) {
    throw new Error(
      `${repository} is not an initialized Ultradyn Docs repository (missing .ultradyn/manifest.json). Run \`npx @ultradyn/docs init --dir ${repository}\` first.`,
    );
  }
  try {
    repositoryMarkerSchema.parse(JSON.parse(await fileSystem.readFile(marker)));
  } catch {
    throw new Error(
      `${repository} has an invalid Ultradyn Docs repository marker. Re-run the matching installer or repair .ultradyn/manifest.json before startup.`,
    );
  }
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

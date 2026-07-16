import { execa } from "execa";

import type {
  LlmEvent,
  LlmProvider,
  LlmRequest,
  ProcessResult,
  ProcessRunner,
  ProviderStatus,
} from "./contracts.js";
import {
  InstalledClientCredentialSource,
  type CredentialSource,
} from "./credentials.js";

export class ExecaProcessRunner implements ProcessRunner {
  async run(
    command: string,
    args: readonly string[],
    options: { cwd?: string; input?: string; signal?: AbortSignal },
  ): Promise<ProcessResult> {
    const result = await execa(command, args, {
      reject: false,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.signal ? { cancelSignal: options.signal } : {}),
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}

function parseCodexOutput(stdout: string): string {
  const messages: string[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        item?: { type?: string; text?: string; content?: string };
      };
      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message"
      ) {
        const text = event.item.text ?? event.item.content;
        if (text) messages.push(text);
      }
    } catch {
      // Codex JSONL may add event kinds this adapter does not consume.
    }
  }
  if (messages.length === 0)
    throw new Error("Codex completed without an agent_message event.");
  return messages.join("\n");
}

function promptFor(request: LlmRequest): string {
  const schemaInstruction = request.responseSchema
    ? `\nReturn only JSON that validates against this JSON Schema:\n${JSON.stringify(request.responseSchema)}`
    : "";
  return [
    `You are the Ultradyn Docs ${request.agent.name} agent.`,
    request.agent.prompt,
    schemaInstruction,
    "Conversation:",
    ...request.messages.map(
      (message) => `${message.role.toUpperCase()}: ${message.content}`,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export class CodexCliLlmProvider implements LlmProvider {
  readonly id = "codex-cli";
  readonly #runner: ProcessRunner;
  readonly #cwd: string;
  readonly #model: string | undefined;

  constructor(options: {
    runner?: ProcessRunner;
    cwd: string;
    model?: string;
  }) {
    this.#runner = options.runner ?? new ExecaProcessRunner();
    this.#cwd = options.cwd;
    this.#model = options.model;
  }

  async status(): Promise<ProviderStatus> {
    try {
      const result = await this.#runner.run("codex", ["--version"], {
        cwd: this.#cwd,
      });
      return {
        id: this.id,
        kind: "llm",
        label: "Codex CLI (delegated ChatGPT sign-in)",
        availability:
          result.exitCode === 0 ? "available" : "activation-required",
        consent: "required",
        streaming: "buffered",
        ...(result.exitCode === 0
          ? {}
          : { reason: "Codex CLI is unavailable or not signed in." }),
      };
    } catch {
      return {
        id: this.id,
        kind: "llm",
        label: "Codex CLI (delegated ChatGPT sign-in)",
        availability: "activation-required",
        consent: "required",
        streaming: "buffered",
        reason: "Codex CLI is unavailable or not signed in.",
      };
    }
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
    yield {
      type: "started",
      providerId: this.id,
      invocationId: request.invocationId,
    };
    const selectedModel = request.model ?? this.#model;
    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      ...(selectedModel ? ["--model", selectedModel] : []),
      "-",
    ];
    const result = await this.#runner.run("codex", args, {
      cwd: this.#cwd,
      input: promptFor(request),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (result.exitCode !== 0) {
      yield {
        type: "failed",
        code: "codex_cli_failed",
        message:
          result.stderr.trim() || `Codex exited with ${result.exitCode}.`,
        retryable: true,
      };
      return;
    }
    const text = parseCodexOutput(result.stdout);
    let output: unknown = text;
    if (request.responseSchema) {
      try {
        output = JSON.parse(text);
      } catch {
        yield {
          type: "failed",
          code: "invalid_structured_output",
          message: "Codex returned non-JSON output for a structured request.",
          retryable: true,
        };
        return;
      }
    }
    yield { type: "text-delta", delta: text };
    yield { type: "completed", output, text };
  }
}

async function commandAvailable(
  runner: ProcessRunner,
  command: string,
  args: string[] = ["--version"],
): Promise<boolean> {
  try {
    return (await runner.run(command, args, {})).exitCode === 0;
  } catch {
    return false;
  }
}

export function createInstalledClientCredentialSources(
  runner: ProcessRunner = new ExecaProcessRunner(),
): CredentialSource[] {
  return [
    new InstalledClientCredentialSource({
      id: "codex-cli",
      label: "Codex CLI delegated sign-in",
      providerId: "openai",
      executable: "codex",
      scopes: ["model"],
      check: () => commandAvailable(runner, "codex"),
    }),
    new InstalledClientCredentialSource({
      id: "grok-cli",
      label: "Grok CLI delegated sign-in",
      providerId: "xai",
      executable: "grok",
      scopes: ["model"],
      check: () => commandAvailable(runner, "grok"),
    }),
    new InstalledClientCredentialSource({
      id: "claude-cli",
      label: "Claude CLI delegated sign-in",
      providerId: "anthropic",
      executable: "claude",
      scopes: ["model"],
      check: () => commandAvailable(runner, "claude"),
    }),
    new InstalledClientCredentialSource({
      id: "opencode-cli",
      label: "OpenCode CLI delegated sign-in",
      providerId: "opencode",
      executable: "opencode",
      scopes: ["model"],
      check: () => commandAvailable(runner, "opencode"),
    }),
    new InstalledClientCredentialSource({
      id: "github-cli",
      label: "GitHub CLI delegated authorization",
      providerId: "github",
      executable: "gh",
      scopes: ["git-host"],
      check: () => commandAvailable(runner, "gh"),
    }),
  ];
}

export interface InstalledClientLoginDefinition {
  sourceId:
    "codex-cli" | "grok-cli" | "claude-cli" | "opencode-cli" | "github-cli";
  command: string;
  args: string[];
}

export const installedClientLoginDefinitions: readonly InstalledClientLoginDefinition[] =
  [
    {
      sourceId: "codex-cli",
      command: "codex",
      args: ["login", "--device-auth"],
    },
    { sourceId: "grok-cli", command: "grok", args: ["login", "--device-auth"] },
    { sourceId: "claude-cli", command: "claude", args: ["auth", "login"] },
    { sourceId: "opencode-cli", command: "opencode", args: ["auth", "login"] },
    { sourceId: "github-cli", command: "gh", args: ["auth", "login", "--web"] },
  ];

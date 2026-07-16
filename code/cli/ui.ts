import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";

import * as prompts from "@clack/prompts";
import { createColors } from "picocolors";
import wrapAnsi from "wrap-ansi";

import { renderFailure, renderSuccess, renderWelcome } from "./render.js";
import {
  PROMPT_CANCELLED,
  type CliTerminal,
  type CliUi,
  type UiAppearance,
} from "./runtime.js";

export function createTerminalUi(options: {
  readonly appearance: UiAppearance;
  readonly terminal: CliTerminal;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}): CliUi {
  if (options.appearance.mode === "interactive") {
    return new ClackUi(options.appearance);
  }
  return new PlainUi(
    options.appearance,
    options.terminal,
    options.input,
    options.output,
  );
}

class ClackUi implements CliUi {
  readonly #appearance: UiAppearance;
  readonly #colors: ReturnType<typeof createColors>;

  constructor(appearance: UiAppearance) {
    this.#appearance = appearance;
    this.#colors = createColors(appearance.color);
  }

  intro({
    destination,
    suggested,
  }: {
    destination: string;
    suggested: boolean;
  }): void {
    prompts.intro(this.#colors.bgCyan(this.#colors.black(" ULTRADYN DOCS ")));
    prompts.note(
      wrapAnsi(
        "Documentation that grows around real questions, expert answers, and reviewable Git changes.",
        Math.max(24, Math.min(this.#appearance.width - 10, 72)),
      ),
      `${this.#colors.cyan("◆")} A living documentation repository`,
    );
    prompts.log.info(
      `${suggested ? "Suggested destination" : "Destination"}: ${this.#colors.cyan(destination)}`,
    );
  }

  async askDestination({
    initialValue,
    validate,
  }: {
    initialValue: string;
    validate: (value: string) => string | undefined;
  }): Promise<string | typeof PROMPT_CANCELLED> {
    const result = await prompts.text({
      message: "Where should Ultradyn Docs be initialized?",
      placeholder: initialValue,
      defaultValue: initialValue,
      validate: (value) => validate(value ?? ""),
    });
    return prompts.isCancel(result) ? PROMPT_CANCELLED : result;
  }

  async confirm({
    destination,
    description,
  }: {
    destination: string;
    description: string;
  }): Promise<boolean | typeof PROMPT_CANCELLED> {
    prompts.note(
      `${description}\n\n${this.#colors.cyan(destination)}`,
      "Ready to initialize",
    );
    const result = await prompts.confirm({
      message: "Create this documentation repository?",
      initialValue: true,
    });
    return prompts.isCancel(result) ? PROMPT_CANCELLED : result;
  }

  async runTask<T>(message: string, task: () => Promise<T>): Promise<T> {
    const progress = prompts.spinner();
    progress.start(message);
    try {
      const result = await task();
      progress.stop("Repository files written and verified");
      return result;
    } catch (error) {
      progress.stop("Installation stopped");
      throw error;
    }
  }

  success(input: Parameters<CliUi["success"]>[0]): void {
    const git = input.gitInitialized
      ? "Git initialized"
      : "Existing Git preserved";
    const preserved =
      input.skipped > 0 ? ` · ${input.skipped} existing preserved` : "";
    prompts.note(
      `${this.#colors.cyan(input.destination)}\n${input.written} files installed${preserved}\n${git}`,
      `${this.#colors.green("✓")} Repository ready`,
    );
    prompts.outro(
      `${this.#colors.bold("Next:")} cd ${input.destination} && ${this.#colors.cyan("npx @ultradyn/docs serve")}`,
    );
  }

  error(message: string): void {
    prompts.log.error(message);
    prompts.outro(this.#colors.red("No partial installation was kept."));
  }

  cancel(message: string): void {
    prompts.cancel(message);
  }

  close(): void {}
}

class PlainUi implements CliUi {
  readonly #appearance: UiAppearance;
  readonly #terminal: CliTerminal;
  readonly #input: NodeJS.ReadableStream;
  readonly #output: NodeJS.WritableStream;
  #readline: ReadlineInterface | undefined;
  #pendingCancellation: (() => void) | undefined;

  constructor(
    appearance: UiAppearance,
    terminal: CliTerminal,
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
  ) {
    this.#appearance = appearance;
    this.#terminal = terminal;
    this.#input = input;
    this.#output = output;
  }

  intro({
    destination,
    suggested,
  }: {
    destination: string;
    suggested: boolean;
  }): void {
    this.#terminal.writeOut(
      renderWelcome(this.#appearance, destination, suggested),
    );
  }

  async askDestination({
    initialValue,
    validate,
  }: {
    initialValue: string;
    validate: (value: string) => string | undefined;
  }): Promise<string | typeof PROMPT_CANCELLED> {
    while (true) {
      const answer = await this.#question(`Destination [${initialValue}]: `);
      if (answer === PROMPT_CANCELLED) return answer;
      const value = answer.trim() || initialValue;
      const error = validate(value);
      if (error === undefined) return value;
      this.#terminal.writeError(`${error}\n`);
    }
  }

  async confirm({
    destination,
    description,
  }: {
    destination: string;
    description: string;
  }): Promise<boolean | typeof PROMPT_CANCELLED> {
    this.#terminal.writeOut(`\n${description}\nDestination: ${destination}\n`);
    while (true) {
      const answer = await this.#question("Create this repository? [Y/n]: ");
      if (answer === PROMPT_CANCELLED) return answer;
      const normalized = answer.trim().toLowerCase();
      if (normalized === "" || normalized === "y" || normalized === "yes")
        return true;
      if (normalized === "n" || normalized === "no") return false;
      this.#terminal.writeError("Enter y or n.\n");
    }
  }

  async runTask<T>(message: string, task: () => Promise<T>): Promise<T> {
    this.#terminal.writeOut(`\n${message}...\n`);
    const result = await task();
    this.#terminal.writeOut("Repository files written and verified.\n\n");
    return result;
  }

  success(input: Parameters<CliUi["success"]>[0]): void {
    this.#terminal.writeOut(renderSuccess(this.#appearance, input));
  }

  error(message: string): void {
    this.#terminal.writeError(renderFailure(this.#appearance, message));
  }

  cancel(message: string): void {
    this.#terminal.writeError(`${message}\n`);
  }

  close(): void {
    this.#readline?.close();
    this.#readline = undefined;
  }

  async #question(query: string): Promise<string | typeof PROMPT_CANCELLED> {
    const readline = this.#readline ?? this.#createReadline();
    return new Promise((resolve) => {
      let settled = false;
      const complete = (value: string | typeof PROMPT_CANCELLED) => {
        if (settled) return;
        settled = true;
        this.#pendingCancellation = undefined;
        resolve(value);
      };
      this.#pendingCancellation = () => complete(PROMPT_CANCELLED);
      readline.question(query, (answer) => complete(answer));
    });
  }

  #createReadline(): ReadlineInterface {
    const readline = createInterface({
      input: this.#input,
      output: this.#output,
      terminal: this.#terminal.isTTY,
    });
    readline.on("SIGINT", () => this.#pendingCancellation?.());
    readline.on("close", () => this.#pendingCancellation?.());
    this.#readline = readline;
    return readline;
  }
}

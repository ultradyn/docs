import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTerminalUi, type CliTerminal } from "./index.js";

const promptMocks = vi.hoisted(() => ({
  text: vi.fn(async () => "./network-docs"),
}));

vi.mock("@clack/prompts", () => ({
  cancel: vi.fn(),
  confirm: vi.fn(),
  intro: vi.fn(),
  isCancel: vi.fn(() => false),
  log: { error: vi.fn(), info: vi.fn() },
  note: vi.fn(),
  outro: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  text: promptMocks.text,
}));

describe("interactive terminal UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("makes the suggested destination the editable prompt value", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const terminal: CliTerminal = {
      columns: 40,
      isTTY: true,
      color: true,
      unicode: true,
      writeOut: vi.fn(),
      writeError: vi.fn(),
    };
    const userInterface = createTerminalUi({
      appearance: {
        mode: "interactive",
        color: true,
        unicode: true,
        width: 40,
      },
      terminal,
      input,
      output,
    });

    await userInterface.askDestination({
      initialValue: "./network-docs",
      validate: () => undefined,
    });

    expect(promptMocks.text).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultValue: "./network-docs",
        initialValue: "./network-docs",
        placeholder: "./network-docs",
      }),
    );
  });
});

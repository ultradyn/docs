import { readFile } from "node:fs/promises";

import stripAnsi from "strip-ansi";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";

import { renderSuccess, renderWelcome } from "./index.js";

const widths = [40, 80, 120] as const;
const modes = ["plain", "ansi"] as const;

describe("terminal rendering", () => {
  for (const mode of modes) {
    for (const width of widths) {
      it(`matches the reviewed ${mode} ${width}-column screen`, async () => {
        const appearance = {
          color: mode === "ansi",
          unicode: mode === "ansi",
          width,
        };
        const screen = [
          renderWelcome(appearance, "./network-docs"),
          renderSuccess(appearance, {
            destination: "/home/max/network-docs",
            written: 184,
            skipped: 2,
            gitInitialized: false,
          }),
        ].join("\n");
        const comparable = screen.replaceAll("\u001B", "\\x1b");
        const snapshot = await readFile(
          new URL(`./test/snapshots/${mode}-${width}.txt`, import.meta.url),
          "utf8",
        );

        expect(comparable).toBe(snapshot);
        for (const line of stripAnsi(screen).trimEnd().split("\n")) {
          expect(stringWidth(line)).toBeLessThanOrEqual(width);
        }
      });
    }
  }
});

import { createColors } from "picocolors";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

import type { UiAppearance } from "./runtime.js";

export interface SuccessView {
  readonly destination: string;
  readonly written: number;
  readonly skipped: number;
  readonly gitInitialized: boolean;
}

export function renderWelcome(
  appearance: Pick<UiAppearance, "color" | "unicode" | "width">,
  destination: string,
  suggested = true,
): string {
  const colors = createColors(appearance.color);
  const diamond = appearance.unicode ? "◆" : "*";
  return frame(
    [
      `${colors.cyan(diamond)} ${colors.bold("ULTRADYN DOCS")}`,
      "",
      colors.dim(
        "Documentation that grows around real questions, expert answers, and reviewable Git changes.",
      ),
      "",
      colors.bold(suggested ? "Suggested destination" : "Destination"),
      colors.cyan(destination),
    ],
    appearance,
  );
}

export function renderSuccess(
  appearance: Pick<UiAppearance, "color" | "unicode" | "width">,
  view: SuccessView,
): string {
  const colors = createColors(appearance.color);
  const mark = appearance.unicode ? "✓" : "OK";
  const preserved =
    view.skipped > 0
      ? `${appearance.unicode ? " · " : "; "}${view.skipped} existing preserved`
      : "";
  return frame(
    [
      `${colors.green(mark)} ${colors.bold("Repository ready")}`,
      colors.cyan(view.destination),
      "",
      `${view.written} files installed${preserved}`,
      view.gitInitialized
        ? "Git repository initialized"
        : "Existing Git repository preserved",
      "",
      colors.bold("Start the browser app"),
      colors.dim(`cd ${shellDisplayPath(view.destination)}`),
      colors.cyan("npx @ultradyn/docs serve"),
    ],
    appearance,
  );
}

export function renderFailure(
  appearance: Pick<UiAppearance, "color" | "unicode" | "width">,
  message: string,
): string {
  const colors = createColors(appearance.color);
  const mark = appearance.unicode ? "✗" : "!!";
  return frame(
    [`${colors.red(mark)} ${colors.bold("Installation stopped")}`, "", message],
    appearance,
  );
}

function frame(
  inputLines: readonly string[],
  appearance: Pick<UiAppearance, "unicode" | "width">,
): string {
  const width = Math.max(20, Math.min(appearance.width, 88));
  const innerWidth = width - 4;
  const glyphs = appearance.unicode
    ? {
        topLeft: "╭",
        topRight: "╮",
        bottomLeft: "╰",
        bottomRight: "╯",
        horizontal: "─",
        vertical: "│",
      }
    : {
        topLeft: "+",
        topRight: "+",
        bottomLeft: "+",
        bottomRight: "+",
        horizontal: "-",
        vertical: "|",
      };
  const lines: string[] = [
    `${glyphs.topLeft}${glyphs.horizontal.repeat(width - 2)}${glyphs.topRight}`,
  ];

  for (const inputLine of inputLines) {
    const wrapped =
      inputLine === ""
        ? [""]
        : wrapAnsi(inputLine, innerWidth, { hard: true, trim: true }).split(
            "\n",
          );
    for (const line of wrapped) {
      const padding = " ".repeat(Math.max(0, innerWidth - stringWidth(line)));
      lines.push(`${glyphs.vertical} ${line}${padding} ${glyphs.vertical}`);
    }
  }
  lines.push(
    `${glyphs.bottomLeft}${glyphs.horizontal.repeat(width - 2)}${glyphs.bottomRight}`,
  );
  return `${lines.join("\n")}\n`;
}

function shellDisplayPath(value: string): string {
  return /[\s'"$`\\]/.test(value)
    ? `'${value.replaceAll("'", "'\\''")}'`
    : value;
}

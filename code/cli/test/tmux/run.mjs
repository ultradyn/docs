/* global console, process, setTimeout */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import stripAnsi from "strip-ansi";
import stringWidth from "string-width";

const TMUX_MINIMUM = [3, 3];
const TERMINAL_MATRIX = [
  { width: 40, rows: 18 },
  { width: 80, rows: 24 },
  { width: 120, rows: 36 },
];
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const snapshotsRoot = path.join(root, "code/cli/test/snapshots");
const publishedArtifactsRoot = path.join(root, "code/cli/test/tmux/artifacts");
const tsx = path.join(root, "node_modules/.bin/tsx");
const bin = path.join(root, "code/cli/bin.ts");

await preparePublishedArtifacts();

if (!commandExists("tmux")) {
  const message =
    "SKIP_TMUX_MISSING: tmux 3.3+ is required; install it, then run `pnpm test:tui`. Deterministic 40/80/120 renderer snapshots remain covered by Vitest.";
  await writeFile(
    path.join(publishedArtifactsRoot, "status.txt"),
    `${message}\n`,
    "utf8",
  );
  console.log(message);
  process.exit(0);
}
if (!existsSync(tsx))
  throw new Error("Missing node_modules/.bin/tsx; run `pnpm install` first.");

const version = tmuxVersion();
if (!isAtLeast(version, TMUX_MINIMUM)) {
  const message = `SKIP_TMUX_VERSION: found tmux ${version.join(".")}; tmux ${TMUX_MINIMUM.join(".")}+ is required.`;
  await writeFile(
    path.join(publishedArtifactsRoot, "status.txt"),
    `${message}\n`,
    "utf8",
  );
  console.log(message);
  process.exit(0);
}

await assertReviewedSnapshotsExist();
const workspace = await mkdtemp(path.join(os.tmpdir(), "ud-"));
const workingArtifactsRoot = path.join(workspace, "artifacts");
await mkdir(workingArtifactsRoot, { recursive: true });
const socket = `ultradyn-docs-${process.pid}-${Date.now().toString(36)}`;
const captures = [];

try {
  for (const terminal of TERMINAL_MATRIX) {
    captures.push(await runCase({ mode: "plain", ...terminal }));
    captures.push(await runCase({ mode: "ansi", ...terminal }));
  }
  captures.push(await runNodeDisableColorsCase());
  captures.push(await runResizeCase());
  captures.push(await runErrorCase());
  await runCancellationCase();
  await assertSocketCleaned(socket);
  await writeFile(
    path.join(workingArtifactsRoot, "status.txt"),
    [
      "status=passed",
      `tmux=${version.join(".")}`,
      "matrix=40x18,80x24,120x36",
      `captures=${captures.length}`,
      "plain_color_contract=NO_COLOR + --no-color",
      "node_disable_colors_contract=NODE_DISABLE_COLORS alone selects unstyled fallback",
      "ansi_color_contract=FORCE_COLOR",
      "resize_contract=tmux resize-window (kernel SIGWINCH)",
      "",
    ].join("\n"),
    "utf8",
  );
  await publishArtifacts();
  console.log(
    `tmux TUI E2E passed: ${captures.length} captures + cancellation; matrix 40x18, 80x24, 120x36; tmux ${version.join(".")}.`,
  );
} catch (error) {
  await captureFailureArtifacts(error);
  await publishArtifacts();
  throw error;
} finally {
  tmux(["kill-server"], { allowFailure: true });
  await rm(workspace, { recursive: true, force: true });
}

async function runCase({ mode, width, rows }) {
  const session = `${mode}-${width}x${rows}`;
  const caseRoot = path.join(workspace, session);
  const target = mode === "ansi" ? caseRoot : path.join(caseRoot, "docs");
  await mkdir(caseRoot, { recursive: true });
  await startSession(session, width, rows, caseRoot);
  const sttyBefore = await recordStty(session, "BEFORE");
  const command =
    mode === "plain"
      ? `NO_COLOR=1 ${shellQuote(tsx)} ${shellQuote(bin)} init --dir ${shellQuote(target)} --yes --plain --no-color; printf '\\n__EXIT_CODE__%s\\n' "$?"`
      : `TERM=xterm-256color FORCE_COLOR=1 ${shellQuote(tsx)} ${shellQuote(bin)} init; printf '\\n__EXIT_CODE__%s\\n' "$?"`;
  sendLiteral(session, command);
  sendKey(session, "Enter");

  const stages = [];
  if (mode === "ansi") {
    const destinationPrompt = await pollPane(session, "Where should Ultradyn");
    stages.push({ name: "destination", value: destinationPrompt });
    throwIfMissing(destinationPrompt, "Where should Ultradyn", session);
    sendKey(session, "Enter");
  }
  if (mode === "ansi") {
    const confirmation = await pollPane(session, "Create this documentation");
    stages.push({ name: "confirmation", value: confirmation });
    sendKey(session, "Enter");
  }
  await pollPane(session, "Repository ready", 30_000);
  const finalPlain = await pollPane(session, "__EXIT_CODE__0");
  const finalAnsi = capture(session, true);
  stages.push({ name: "final", value: finalAnsi });
  await assertCapture({
    mode,
    width,
    rows,
    plain: finalPlain,
    ansi: finalAnsi,
  });
  await assertRepository(target);
  const sttyAfter = await recordStty(session, "AFTER");
  if (sttyAfter !== sttyBefore)
    throw new Error(`${session}: terminal mode was not restored after exit.`);
  assertPaneMetadata(session, width, rows);

  const artifact = path.join(workingArtifactsRoot, `${session}.capture.txt`);
  await writeFile(
    artifact,
    stages
      .map(
        (stage) =>
          `===== ${stage.name} =====\n${normalizeCapture(stage.value, workspace)}`,
      )
      .join("\n"),
    "utf8",
  );
  tmux(["kill-session", "-t", session]);
  return artifact;
}

async function runNodeDisableColorsCase() {
  const session = "node-disable-colors-80x24";
  const caseRoot = path.join(workspace, session);
  const target = path.join(caseRoot, "docs");
  await mkdir(caseRoot, { recursive: true });
  await startSession(session, 80, 24, caseRoot);
  const before = await recordStty(session, "NODE_COLORS_BEFORE");
  sendLiteral(
    session,
    `TERM=xterm-256color NODE_DISABLE_COLORS=1 ${shellQuote(tsx)} ${shellQuote(bin)} init --dir ${shellQuote(target)} --yes; printf '\\n__EXIT_CODE__%s\\n' "$?"`,
  );
  sendKey(session, "Enter");
  await pollPane(session, "Repository ready", 30_000);
  const plain = await pollPane(session, "__EXIT_CODE__0");
  const ansi = capture(session, true);
  await assertCapture({
    mode: "plain",
    width: 80,
    rows: 24,
    plain,
    ansi,
  });
  await assertRepository(target);
  const after = await recordStty(session, "NODE_COLORS_AFTER");
  if (after !== before)
    throw new Error("NODE_DISABLE_COLORS path did not restore terminal mode.");
  assertPaneMetadata(session, 80, 24);
  const artifact = path.join(workingArtifactsRoot, `${session}.capture.txt`);
  await writeFile(artifact, normalizeCapture(ansi, workspace), "utf8");
  tmux(["kill-session", "-t", session]);
  return artifact;
}

async function runResizeCase() {
  const session = "resize-80x24";
  const caseRoot = path.join(workspace, session);
  await mkdir(caseRoot, { recursive: true });
  await startSession(session, 80, 24, caseRoot);
  const before = await recordStty(session, "RESIZE_BEFORE");
  sendLiteral(
    session,
    `TERM=xterm-256color FORCE_COLOR=1 ${shellQuote(tsx)} ${shellQuote(bin)} init; printf '\\n__EXIT_CODE__%s\\n' "$?"`,
  );
  sendKey(session, "Enter");
  const wide = await pollPane(session, "Where should Ultradyn");

  resizeTerminal(session, 40, 18);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const narrow = capture(session, false);
  assertHealthyTextCapture("resize-40x18", narrow, 40);
  throwIfMissing(narrow, "Where should Ultradyn", session);

  resizeTerminal(session, 80, 24);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const restored = capture(session, true);
  throwIfMissing(stripAnsi(restored), "Where should Ultradyn", session);
  sendKey(session, "C-c");
  await pollPane(session, "Installation cancelled.");
  const cancelled = await pollPane(session, "__EXIT_CODE__130");
  const after = await recordStty(session, "RESIZE_AFTER");
  if (after !== before)
    throw new Error("Resize cancellation did not restore terminal mode.");
  assertPaneMetadata(session, 80, 24);

  const artifact = path.join(workingArtifactsRoot, `${session}.capture.txt`);
  await writeFile(
    artifact,
    [
      ["wide-80x24", wide],
      ["narrow-40x18", narrow],
      ["restored-80x24", restored],
      ["cancelled", cancelled],
    ]
      .map(
        ([name, value]) =>
          `===== ${name} =====\n${normalizeCapture(value, workspace)}`,
      )
      .join("\n"),
    "utf8",
  );
  tmux(["kill-session", "-t", session]);
  return artifact;
}

async function runErrorCase() {
  const session = "error-80x24";
  const caseRoot = path.join(workspace, session);
  const target = path.join(caseRoot, "not-a-directory");
  await mkdir(caseRoot, { recursive: true });
  await writeFile(target, "preserve this file\n", "utf8");
  await startSession(session, 80, 24, caseRoot);
  const before = await recordStty(session, "ERROR_BEFORE");
  sendLiteral(
    session,
    `NO_COLOR=1 ${shellQuote(tsx)} ${shellQuote(bin)} init --dir ${shellQuote(target)} --yes --plain --no-color; printf '\\n__EXIT_CODE__%s\\n' "$?"`,
  );
  sendKey(session, "Enter");
  const captureValue = await pollPane(session, "__EXIT_CODE__1");
  throwIfMissing(captureValue, "Installation stopped", session);
  if (captureValue.includes("Repository ready"))
    throw new Error("Error path falsely claimed the repository was ready.");
  if (capture(session, true).includes("\u001B"))
    throw new Error("Error path leaked ANSI despite the plain color contract.");
  if ((await readFile(target, "utf8")) !== "preserve this file\n")
    throw new Error("Error path changed the blocking destination file.");
  await assertNoTransactionDirectories(caseRoot);
  const after = await recordStty(session, "ERROR_AFTER");
  if (after !== before)
    throw new Error("Error path did not restore terminal mode.");
  assertPaneMetadata(session, 80, 24);
  const artifact = path.join(workingArtifactsRoot, `${session}.capture.txt`);
  await writeFile(artifact, normalizeCapture(captureValue, workspace), "utf8");
  tmux(["kill-session", "-t", session]);
  return artifact;
}

async function runCancellationCase() {
  const session = "cancel-80x24";
  const caseRoot = path.join(workspace, session);
  await mkdir(caseRoot, { recursive: true });
  await startSession(session, 80, 24, caseRoot);
  const before = await recordStty(session, "CANCEL_BEFORE");
  sendLiteral(
    session,
    `TERM=xterm-256color FORCE_COLOR=1 ${shellQuote(tsx)} ${shellQuote(bin)} init; printf '\\n__EXIT_CODE__%s\\n' "$?"`,
  );
  sendKey(session, "Enter");
  const prompt = await pollPane(session, "Where should Ultradyn");
  throwIfMissing(prompt, "Where should Ultradyn", session);
  sendKey(session, "C-c");
  await pollPane(session, "Installation cancelled.");
  const captureValue = await pollPane(session, "__EXIT_CODE__130");
  throwIfMissing(captureValue, "__EXIT_CODE__130", session);
  if (
    existsSync(path.join(caseRoot, ".ultradyn")) ||
    existsSync(path.join(caseRoot, "code"))
  ) {
    throw new Error("Cancellation left generated files behind.");
  }
  const after = await recordStty(session, "CANCEL_AFTER");
  if (after !== before)
    throw new Error("Cancellation did not restore terminal mode.");
  assertPaneMetadata(session, 80, 24);
  await writeFile(
    path.join(workingArtifactsRoot, `${session}.capture.txt`),
    normalizeCapture(captureValue, workspace),
    "utf8",
  );
  tmux(["kill-session", "-t", session]);
}

async function startSession(session, width, rows, directory) {
  tmux([
    "new-session",
    "-d",
    "-s",
    session,
    "-x",
    String(width),
    "-y",
    String(rows),
    "-c",
    directory,
  ]);
  tmux(["set-option", "-t", session, "status", "off"]);
  resizeTerminal(session, width, rows);
  sendLiteral(
    session,
    "export PS1='__UD_PROMPT__ '; export LANG=C.UTF-8 TZ=UTC; unset PROMPT_COMMAND; clear",
  );
  sendKey(session, "Enter");
  await pollPane(session, "__UD_PROMPT__");
  tmux(["clear-history", "-t", session]);
  assertPaneMetadata(session, width, rows);
}

async function recordStty(session, label) {
  sendLiteral(session, `printf '__${label}__'; stty -g`);
  sendKey(session, "Enter");
  const pattern = new RegExp(`^__${label}__([^\\r\\n]+)`, "m");
  const { match } = await pollPaneMatch(session, pattern);
  return match[1].trim();
}

async function assertCapture({ mode, width, rows, plain, ansi }) {
  const normalized = normalizeCapture(plain, workspace);
  for (const forbidden of [
    "undefined",
    "[object Object]",
    "�",
    "simulated",
    "UnhandledPromiseRejection",
  ]) {
    if (normalized.includes(forbidden))
      throw new Error(`${mode}-${width}: capture contains ${forbidden}.`);
  }
  assertHealthyTextCapture(`${mode}-${width}x${rows}`, plain, width);
  if (mode === "plain" && ansi.includes("\u001B"))
    throw new Error(`${mode}-${width}: plain mode leaked ANSI.`);
  if (mode === "ansi" && !ansi.includes("\u001B["))
    throw new Error(`${mode}-${width}: ANSI mode lost styling.`);
  const csiPattern = new RegExp(
    `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
    "g",
  );
  const withoutCsi = ansi.replace(csiPattern, "");
  if (withoutCsi.includes("\u001B"))
    throw new Error(`${mode}-${width}: malformed terminal escape sequence.`);
  await assertCaptureMatchesReviewedSnapshot(mode, width, plain);
}

async function assertRepository(target) {
  for (const relative of [
    ".git",
    ".ultradyn/manifest.json",
    "code/cli/bin.ts",
    "tauri-app",
    ".codex/skills/tdd/SKILL.md",
  ]) {
    await stat(path.join(target, relative)).catch(() => {
      throw new Error(`Installed repository is missing ${relative}.`);
    });
  }
  const gitRoot = execFileSync(
    "git",
    ["-C", target, "rev-parse", "--show-toplevel"],
    { encoding: "utf8" },
  ).trim();
  if (path.resolve(gitRoot) !== path.resolve(target))
    throw new Error("Installed target is not its own Git repository.");
  const siblings = await readdir(path.dirname(target));
  if (siblings.some((entry) => entry.includes(".ultradyn-tmp-"))) {
    throw new Error("Installer left a transaction staging directory behind.");
  }
  JSON.parse(
    await readFile(path.join(target, ".ultradyn/manifest.json"), "utf8"),
  );
}

function assertPaneMetadata(session, width, rows) {
  const metadata = tmux([
    "display-message",
    "-p",
    "-t",
    session,
    "#{pane_in_mode}|#{pane_dead}|#{cursor_x}|#{cursor_y}|#{pane_width}|#{pane_height}",
  ])
    .trim()
    .split("|");
  if (metadata[0] !== "0" || metadata[1] !== "0") {
    throw new Error(
      `${session}: unexpected pane metadata ${metadata.join("|")}.`,
    );
  }
  if (metadata.slice(2).some((value) => !/^\d+$/.test(value))) {
    throw new Error(`${session}: cursor metadata is invalid.`);
  }
  if (Number(metadata[4]) !== width || Number(metadata[5]) !== rows) {
    throw new Error(
      `${session}: expected ${width}x${rows}, received ${metadata[4]}x${metadata[5]}.`,
    );
  }
  if (Number(metadata[2]) >= width || Number(metadata[3]) >= rows) {
    throw new Error(`${session}: cursor is outside the terminal bounds.`);
  }
}

async function assertReviewedSnapshotsExist() {
  for (const mode of ["plain", "ansi"]) {
    for (const { width } of TERMINAL_MATRIX) {
      const content = await readFile(
        path.join(snapshotsRoot, `${mode}-${width}.txt`),
        "utf8",
      );
      if (
        !content.includes("ULTRADYN DOCS") ||
        !content.includes("Repository ready")
      ) {
        throw new Error(
          `Renderer snapshot ${mode}-${width}.txt has not been reviewed.`,
        );
      }
    }
  }
}

async function assertCaptureMatchesReviewedSnapshot(mode, width, captureValue) {
  const reviewed = await readFile(
    path.join(snapshotsRoot, `${mode}-${width}.txt`),
    "utf8",
  );
  if (mode === "plain") {
    const actualFrames = extractAsciiFrames(captureValue);
    const reviewedFrames = extractAsciiFrames(reviewed);
    if (actualFrames.length < 2 || reviewedFrames.length !== 2) {
      throw new Error(
        `plain-${width}: expected welcome and success frames in the process capture and reviewed snapshot.`,
      );
    }
    for (const [index, expected] of reviewedFrames.entries()) {
      const actual = actualFrames[index === 0 ? 0 : actualFrames.length - 1];
      if (
        canonicalizeAsciiFrame(actual, index) !==
        canonicalizeAsciiFrame(expected, index)
      ) {
        throw new Error(
          `plain-${width}: normalized PTY frame ${index + 1} differs from the committed renderer snapshot.`,
        );
      }
    }
    return;
  }

  const reviewedText = reviewed
    .replace(/\\x1b\[[0-9;]*m/gu, "")
    .replace(/\s+/gu, " ");
  const actualText = stripAnsi(captureValue).replace(/\s+/gu, " ");
  for (const marker of [
    "ULTRADYN DOCS",
    "Repository ready",
    "npx",
    "@ultradyn/docs",
    "serve",
  ]) {
    if (!reviewedText.includes(marker) || !actualText.includes(marker)) {
      throw new Error(
        `ansi-${width}: process capture diverged from reviewed marker ${marker}.`,
      );
    }
  }
}

function extractAsciiFrames(value) {
  const lines = stripAnsi(value)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""));
  const frames = [];
  for (let index = 0; index < lines.length; index += 1) {
    const border = lines[index];
    if (!/^\+-+\+$/u.test(border)) continue;
    const end = lines.indexOf(border, index + 1);
    if (end === -1) continue;
    const frame = lines.slice(index, end + 1);
    if (frame.slice(1, -1).every((line) => /^\|.*\|$/u.test(line))) {
      frames.push(frame.join("\n"));
      index = end;
    }
  }
  return frames;
}

function canonicalizeAsciiFrame(frame, index) {
  return frame
    .split("\n")
    .filter((line) => {
      if (!line.startsWith("| ") || !line.endsWith(" |")) return true;
      const content = line.slice(2, -2).trim();
      if (index === 0) {
        return (
          !/^(Suggested )?Destination$/u.test(content) &&
          !content.startsWith("/") &&
          !content.startsWith("./")
        );
      }
      return !(
        content.startsWith("/") ||
        /^\d+ files installed/u.test(content) ||
        content === "preserved" ||
        /Git repository/u.test(content) ||
        content.startsWith("cd ")
      );
    })
    .join("\n");
}

async function assertSocketCleaned(socketName) {
  tmux(["kill-server"], { allowFailure: true });
  const result = spawnSync("tmux", ["-L", socketName, "list-sessions"], {
    encoding: "utf8",
  });
  if (result.status === 0)
    throw new Error(`Isolated tmux server ${socketName} survived cleanup.`);
}

async function pollPane(session, needle, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let value = "";
  while (Date.now() < deadline) {
    value = capture(session, false);
    if (value.includes(needle)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `${session}: timed out waiting for ${JSON.stringify(needle)}.\n${value}`,
  );
}

async function pollPaneMatch(session, pattern, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let value = "";
  while (Date.now() < deadline) {
    value = capture(session, false);
    const match = value.match(pattern);
    if (match) return { value, match };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${session}: timed out waiting for ${pattern}.\n${value}`);
}

function resizeTerminal(session, width, rows) {
  tmux([
    "resize-window",
    "-t",
    session,
    "-x",
    String(width),
    "-y",
    String(rows),
  ]);
  assertPaneMetadata(session, width, rows);
}

function assertHealthyTextCapture(label, value, width) {
  for (const forbidden of [
    "undefined",
    "[object Object]",
    "�",
    "UnhandledPromiseRejection",
  ]) {
    if (value.includes(forbidden))
      throw new Error(`${label}: capture contains ${forbidden}.`);
  }
  for (const line of stripAnsi(value).split("\n")) {
    if (stringWidth(line) > width)
      throw new Error(`${label}: line exceeds terminal width: ${line}`);
  }
}

async function assertNoTransactionDirectories(directory) {
  const entries = await readdir(directory);
  if (entries.some((entry) => entry.includes(".ultradyn-tmp-"))) {
    throw new Error("Installer left a transaction staging directory behind.");
  }
}

function capture(session, preserveEscapes) {
  return tmux([
    "capture-pane",
    "-p",
    ...(preserveEscapes ? ["-e"] : []),
    "-S",
    "-",
    "-t",
    session,
  ]);
}

function sendLiteral(session, value) {
  tmux(["send-keys", "-t", session, "-l", value]);
}

function sendKey(session, key) {
  tmux(["send-keys", "-t", session, key]);
}

function tmux(args, { allowFailure = false } = {}) {
  const result = spawnSync("tmux", ["-L", socket, ...args], {
    encoding: "utf8",
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `tmux ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout ?? "";
}

function tmuxVersion() {
  const output = execFileSync("tmux", ["-V"], { encoding: "utf8" });
  const match = output.match(/tmux\s+(\d+)\.(\d+)/);
  if (!match) throw new Error(`Could not parse tmux version: ${output.trim()}`);
  return [Number(match[1]), Number(match[2])];
}

function isAtLeast(actual, required) {
  return (
    actual[0] > required[0] ||
    (actual[0] === required[0] && actual[1] >= required[1])
  );
}

function commandExists(command) {
  return spawnSync(command, ["-V"], { stdio: "ignore" }).status === 0;
}

function throwIfMissing(value, needle, context) {
  if (!value.includes(needle))
    throw new Error(`${context}: missing ${needle}.`);
}

async function preparePublishedArtifacts() {
  await mkdir(publishedArtifactsRoot, { recursive: true });
  for (const entry of await readdir(publishedArtifactsRoot)) {
    if (entry === ".gitignore") continue;
    await rm(path.join(publishedArtifactsRoot, entry), {
      recursive: true,
      force: true,
    });
  }
}

async function publishArtifacts() {
  await mkdir(publishedArtifactsRoot, { recursive: true });
  for (const entry of await readdir(workingArtifactsRoot)) {
    await cp(
      path.join(workingArtifactsRoot, entry),
      path.join(publishedArtifactsRoot, entry),
      { recursive: true, force: true },
    );
  }
}

async function captureFailureArtifacts(error) {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  await writeFile(
    path.join(workingArtifactsRoot, "status.txt"),
    `status=failed\n${message}\n`,
    "utf8",
  );
  const sessions = tmux(["list-sessions", "-F", "#{session_name}"], {
    allowFailure: true,
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const session of sessions) {
    const value = tmux(["capture-pane", "-p", "-e", "-S", "-", "-t", session], {
      allowFailure: true,
    });
    await writeFile(
      path.join(workingArtifactsRoot, `failure-${session}.capture.txt`),
      normalizeCapture(value, workspace),
      "utf8",
    );
  }
}

function normalizeCapture(value, temporaryRoot) {
  return value
    .replaceAll(temporaryRoot, "<TMP>")
    .replaceAll(root, "<REPO>")
    .replaceAll(os.homedir(), "<HOME>")
    .replaceAll("\u001B", "\\x1b")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

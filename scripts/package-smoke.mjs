import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { request } from "node:http";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "ultradyn-docs-package-"));
const destination = join(temporary, "installed-docs");

function run(command, arguments_, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: {
        ...process.env,
        NO_COLOR: "1",
        NODE_DISABLE_COLORS: "1",
        npm_config_cache: join(temporary, "npm-cache"),
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else
        reject(
          new Error(
            `${command} exited ${code ?? `after signal ${signal ?? "unknown"}`}`,
          ),
        );
    });
  });
}

function rawGet(url, headers = {}) {
  return new Promise((resolveRequest, reject) => {
    const outgoing = request(url, { method: "GET", headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () =>
        resolveRequest({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function verifyServer(cwd) {
  const port = 41_000 + (process.pid % 1_000);
  const child = spawn(
    process.execPath,
    [
      "dist/bin.js",
      "serve",
      ".",
      "--demo",
      "--no-open",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { cwd, env: process.env, stdio: "inherit" },
  );
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new Error(
          `packed server exited ${child.exitCode} before health check`,
        );
      let response;
      try {
        response = await globalThis.fetch(
          `http://127.0.0.1:${port}/api/health`,
        );
      } catch {
        // The process may still be binding its loopback listener.
        await delay(100);
        continue;
      }
      if (!response.ok) {
        await delay(100);
        continue;
      }

      const health = await response.json();
      if (health?.status !== "ok")
        throw new Error("unexpected health response");

      const goalsWithoutSession = await globalThis.fetch(
        `http://127.0.0.1:${port}/api/goals`,
      );
      if (goalsWithoutSession.status !== 401)
        throw new Error("packed server accepted an API call without a session");

      const navigation = await rawGet(`http://127.0.0.1:${port}/`, {
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
      });
      const setCookie = navigation.headers["set-cookie"];
      const cookie = (
        Array.isArray(setCookie) ? setCookie[0] : setCookie
      )?.split(";", 1)[0];
      if (navigation.status !== 200 || !cookie?.startsWith("ultradyn_session="))
        throw new Error("packed server did not establish a browser session");
      if (
        !navigation.headers["content-security-policy"]?.includes(
          "frame-ancestors 'none'",
        )
      )
        throw new Error("packed server did not emit browser security headers");

      const goalsWithSession = await globalThis.fetch(
        `http://127.0.0.1:${port}/api/goals`,
        { headers: { Cookie: cookie } },
      );
      if (!goalsWithSession.ok)
        throw new Error(
          "packed server rejected its established browser session",
        );
      return;
    }
    throw new Error("packed server did not become healthy within 20 seconds");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolveExit) => child.once("exit", resolveExit));
    }
  }
}

try {
  await run(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", temporary],
    root,
  );
  const archive = (await readdir(temporary)).find((entry) =>
    entry.endsWith(".tgz"),
  );
  if (!archive) throw new Error("npm pack did not create a tarball");
  await run(
    "npx",
    [
      "--yes",
      "--package",
      join(temporary, archive),
      "ultradyn-docs",
      "init",
      "--dir",
      destination,
      "--yes",
      "--plain",
      "--no-color",
    ],
    root,
  );
  await Promise.all(
    [
      "AGENTS.md",
      "BLOCKED_TASKS.md",
      ".plan/README.md",
      ".ultradyn/manifest.json",
      "code/server/index.ts",
      "docs/architecture.md",
      "tauri-app/src-tauri/tauri.conf.json",
      "agents/librarian/agent.md",
      ".codex/skills/tdd/SKILL.md",
      ".github/workflows/ci.yml",
      "pnpm-lock.yaml",
    ].map((path) => access(join(destination, path))),
  );
  await run(
    "pnpm",
    [
      "install",
      "--frozen-lockfile",
      "--store-dir",
      join(temporary, "pnpm-store"),
    ],
    destination,
  );
  await run("pnpm", ["typecheck"], destination);
  await run("pnpm", ["test"], destination);
  await run("pnpm", ["build"], destination);
  await verifyServer(destination);
  process.stdout.write("Clean tarball npx installation passed.\n");
} finally {
  if (process.env.ULTRADYN_KEEP_PACKAGE_SMOKE !== "1") {
    await rm(temporary, { recursive: true, force: true });
  } else {
    process.stdout.write(`Package smoke artifacts: ${temporary}\n`);
  }
}

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import open from "open";
import { buildServer } from "./app.js";
import { createDemoServices } from "./demo-services.js";
import { createLocalServices } from "./local-services.js";
import { MaintenanceScheduler } from "./maintenance.js";
import type { UltradynServices } from "./services.js";

const DEFAULT_PORT = 5885;
const DEFAULT_HOST = "127.0.0.1";

export interface StartServerOptions {
  repoRoot: string;
  packageRoot: string;
  host?: string;
  port?: number;
  openBrowser?: boolean;
  maintenanceEnabled?: boolean;
  demoMode?: boolean;
  dev?: boolean;
  version?: string;
  services?: UltradynServices;
  dataRoot?: string;
  allowOrigin?: string | string[];
  allowedHostnames?: string[];
  desktopLauncherNonce?: string;
  signal?: AbortSignal;
  onListening?: (url: string) => void;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

export function browserUrlHostname(hostname: string): string {
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return unwrapped.includes(":") ? `[${unwrapped}]` : unwrapped;
}

export async function startUltradynServer(
  options: StartServerOptions,
): Promise<RunningServer> {
  const repoRoot = resolve(options.repoRoot);
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const loopback = ["127.0.0.1", "localhost", "::1"];
  const wildcard = host === "0.0.0.0" || host === "::";
  if (wildcard && !options.allowedHostnames?.length) {
    throw new Error(
      `Binding ${host} requires at least one explicit --allowed-host value.`,
    );
  }
  const allowedHostnames = options.allowedHostnames?.length
    ? options.allowedHostnames
    : loopback.includes(host)
      ? loopback
      : [host];
  const demoMode = options.demoMode ?? false;
  const services =
    options.services ??
    (demoMode
      ? createDemoServices()
      : await createLocalServices({
          repoRoot,
          dataRoot: options.dataRoot ?? localDataRootForRepository(repoRoot),
        }));
  const currentSettings = await services.settings.values();
  const runtime = {
    maintenanceEnabled:
      options.maintenanceEnabled ??
      currentSettings.find((setting) => setting.key === "server.maintenance")
        ?.value === true,
    demoMode,
    repoRoot,
    version: options.version ?? "0.1.0",
  };
  const pollIntervalMinutes = Number(
    currentSettings.find(
      (setting) => setting.key === "server.pollIntervalMinutes",
    )?.value ?? 15,
  );
  const schedulerRef: { current?: MaintenanceScheduler } = {};
  const app = buildServer({
    services,
    runtime,
    webRoot: resolve(options.packageRoot, "code/web/dist"),
    ...(options.allowOrigin ? { allowOrigin: options.allowOrigin } : {}),
    allowedHostnames,
    sessionAuth: true,
    ...(options.desktopLauncherNonce
      ? { desktopLauncherNonce: options.desktopLauncherNonce }
      : {}),
    logger: options.dev ?? false,
    onMaintenanceChanged: (enabled) =>
      enabled ? schedulerRef.current?.start() : schedulerRef.current?.stop(),
  });
  const scheduler = new MaintenanceScheduler({
    intervalMs:
      Number.isFinite(pollIntervalMinutes) && pollIntervalMinutes >= 1
        ? pollIntervalMinutes * 60_000
        : 15 * 60_000,
    run: async () => {
      if (runtime.maintenanceEnabled) await services.maintenance.run();
    },
    onError: (error) => app.log.error(error),
  });
  schedulerRef.current = scheduler;
  if (runtime.maintenanceEnabled) scheduler.start();

  const address = await app.listen({
    host,
    port,
  });
  const wildcardBrowserHost = browserUrlHostname(
    allowedHostnames[0] ?? "127.0.0.1",
  );
  const url = address
    .replace("0.0.0.0", wildcardBrowserHost)
    .replace("[::]", wildcardBrowserHost);
  options.onListening?.(url);

  if (options.openBrowser !== false && !process.env.CI) {
    await open(url).catch((error: unknown) =>
      app.log.warn({ error }, "Could not open the browser"),
    );
  }

  let closing: Promise<void> | undefined;
  const close = async () => {
    closing ??= (async () => {
      scheduler?.stop();
      await app.close();
    })();
    return closing;
  };
  options.signal?.addEventListener("abort", () => void close(), { once: true });
  return { url, close };
}

export function localDataRootForRepository(repoRoot: string): string {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(resolve(repoRoot));
  } catch {
    canonicalRoot = resolve(repoRoot);
  }
  if (process.platform === "win32")
    canonicalRoot = canonicalRoot.toLocaleLowerCase();
  const id = createHash("sha256")
    .update(canonicalRoot)
    .digest("hex")
    .slice(0, 16);
  const platformRoot =
    process.platform === "win32"
      ? (process.env.APPDATA ?? resolve(homedir(), "AppData", "Roaming"))
      : process.platform === "darwin"
        ? resolve(homedir(), "Library", "Application Support")
        : (process.env.XDG_DATA_HOME ?? resolve(homedir(), ".local", "share"));
  return resolve(platformRoot, "ultradyn-docs", "repositories", id);
}

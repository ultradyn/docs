import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Signed in</title>
  <style>
    :root { color-scheme: dark light; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      background: #0b0f19;
      color: #f3f4f6;
    }
    main {
      max-width: 28rem;
      padding: 2rem;
      border: 1px solid #1f2937;
      border-radius: 16px;
      background: #111827;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
      text-align: center;
    }
    h1 {
      margin: 0 0 0.5rem;
      font-size: 1.25rem;
      background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    p { margin: 0; color: #9ca3af; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>Signed in</h1>
    <p>You can close this tab and return to Ultradyn Docs.</p>
  </main>
</body>
</html>
`;

export interface LoopbackListener {
  port: number;
  waitForCallback(): Promise<{ code: string; state: string }>;
  close(): Promise<void>;
}

export interface StartLoopbackListenerOptions {
  path: string;
  port?: number;
  timeoutMs?: number;
}

function send(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
}

/**
 * Start a one-shot loopback HTTP listener on 127.0.0.1 for the OAuth redirect.
 */
export async function startLoopbackListener(
  options: StartLoopbackListenerOptions,
): Promise<LoopbackListener> {
  const timeoutMs = options.timeoutMs ?? 3 * 60 * 1000;
  const expectedPath = options.path.startsWith("/")
    ? options.path
    : `/${options.path}`;

  let settled = false;
  const timeoutRef: { id?: ReturnType<typeof setTimeout> } = {};
  let resolveCallback!: (value: { code: string; state: string }) => void;
  let rejectCallback!: (error: Error) => void;

  // Create the promise eagerly and always attach a no-op rejection handler so
  // close/timeout/bad-callback cannot produce unhandledRejection noise when
  // the caller has not yet awaited waitForCallback().
  const callbackPromise = new Promise<{ code: string; state: string }>(
    (resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    },
  );
  void callbackPromise.catch(() => undefined);

  const settleReject = (error: Error): void => {
    if (settled) return;
    settled = true;
    if (timeoutRef.id) clearTimeout(timeoutRef.id);
    rejectCallback(error);
  };

  const settleResolve = (value: { code: string; state: string }): void => {
    if (settled) return;
    settled = true;
    if (timeoutRef.id) clearTimeout(timeoutRef.id);
    resolveCallback(value);
  };

  const server: Server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      try {
        const host = request.headers.host ?? "127.0.0.1";
        const url = new URL(request.url ?? "/", `http://${host}`);
        if (url.pathname !== expectedPath) {
          send(response, 404, "Not found");
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) {
          send(response, 400, "Missing code or state");
          settleReject(
            new Error("OAuth callback is missing code or state parameters."),
          );
          return;
        }
        send(response, 200, SUCCESS_HTML, "text/html; charset=utf-8");
        settleResolve({ code, state });
      } catch (error) {
        send(response, 500, "Internal error");
        settleReject(
          error instanceof Error
            ? error
            : new Error("OAuth callback handling failed."),
        );
      }
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Loopback listener failed to bind a TCP port.");
  }

  timeoutRef.id = setTimeout(() => {
    settleReject(
      new Error(
        `OAuth callback timed out after ${Math.round(timeoutMs / 1000)}s.`,
      ),
    );
  }, timeoutMs);
  timeoutRef.id.unref?.();

  return {
    port: address.port,
    // Return the same promise (not an async wrapper) so rejections stay handled
    // by the permanent catch attached above until the caller awaits.
    waitForCallback: () => callbackPromise,
    close: async () => {
      if (timeoutRef.id) clearTimeout(timeoutRef.id);
      if (!settled) {
        settleReject(new Error("OAuth loopback listener was closed."));
      }
      await closeServer(server);
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

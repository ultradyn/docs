import { randomBytes, timingSafeEqual } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import type {
  PriorityTier,
  RuntimeInfo,
  SettingScope,
} from "../shared/index.js";
import { ProviderConsentScopes } from "../shared/index.js";
import { IdSchemas, SafeSlugSchema } from "../domain/index.js";
import { EventHub } from "./events.js";
import { ServiceError, type UltradynServices } from "./services.js";

export interface BuildServerOptions {
  services: UltradynServices;
  runtime: RuntimeInfo;
  webRoot?: string;
  allowOrigin?: string | string[];
  allowedHostnames?: string[];
  sessionAuth?: boolean;
  desktopLauncherNonce?: string;
  logger?: boolean;
  events?: EventHub;
  onMaintenanceChanged?: (enabled: boolean) => void;
}

const askSchema = z.object({
  question: z.string().trim().min(1).max(20_000),
  goals: z.array(z.string().trim().min(1)).default(["documentation"]),
  asker: z.string().trim().min(1),
  chat: z.string().max(100_000).optional(),
});

const prioritySchema = z.object({
  tier: z.enum(["P1", "P2", "P3", "P4", "P5"]),
  rationale: z.string().trim().min(1).max(2_000),
  by: SafeSlugSchema,
});

const transcriptSchema = z.object({
  text: z.string().trim().min(1).max(2_000_000),
  source: z.enum(["typed", "stt"]),
  confidence: z.number().min(0).max(1).optional(),
  kind: z.enum(["transcript", "correction"]).default("transcript"),
});

const loopbackHostnames = ["127.0.0.1", "localhost", "::1"];
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
].join("; ");

function normalizedHostname(value: string): string {
  return value.replace(/^\[|\]$/gu, "").toLocaleLowerCase();
}

function hostnameFromHostHeader(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return normalizedHostname(new URL(`http://${value}`).hostname);
  } catch {
    return undefined;
  }
}

function sameOriginRequest(
  origin: string,
  hostHeader: string | undefined,
  allowedHostnames: ReadonlySet<string>,
): boolean {
  if (!hostHeader || origin === "null") return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      normalizedHostname(parsed.hostname) ===
        hostnameFromHostHeader(hostHeader) &&
      allowedHostnames.has(normalizedHostname(parsed.hostname)) &&
      parsed.host.toLocaleLowerCase() === hostHeader.toLocaleLowerCase()
    );
  } catch {
    return false;
  }
}

function tokenMatches(candidate: string | undefined, token: string): boolean {
  if (!candidate) return false;
  const actual = Buffer.from(candidate);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 16 * 1024 * 1024,
  });
  const events = options.events ?? new EventHub();
  const allowedHostnames = new Set(
    (options.allowedHostnames ?? loopbackHostnames).map(normalizedHostname),
  );
  const allowedOrigins = new Set(
    typeof options.allowOrigin === "string"
      ? [options.allowOrigin]
      : (options.allowOrigin ?? []),
  );
  const sessionToken = randomBytes(32).toString("base64url");
  const desktopLauncherNonce = options.desktopLauncherNonce;
  let desktopBootstrapAvailable = desktopLauncherNonce !== undefined;

  app.addHook("onSend", async (_request, reply) => {
    reply.header("Content-Security-Policy", contentSecurityPolicy);
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Permissions-Policy", "microphone=(self)");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
  });

  app.addHook("onRequest", async (request, reply) => {
    const hostHeader = request.headers.host;
    const hostname = hostnameFromHostHeader(hostHeader);
    if (!hostname || !allowedHostnames.has(hostname)) {
      return reply.status(421).send({
        error: {
          code: "host_not_allowed",
          message: "This Host is not allowed for the Ultradyn Docs server.",
        },
      });
    }

    const origin = request.headers.origin;
    if (
      origin &&
      !allowedOrigins.has(origin) &&
      !sameOriginRequest(origin, hostHeader, allowedHostnames)
    ) {
      return reply.status(403).send({
        error: {
          code: "origin_not_allowed",
          message: "This browser origin is not allowed.",
        },
      });
    }

    const requestUrl = new URL(request.url, "http://ultradyn.local");
    const desktopBootstrap = requestUrl.searchParams.get("ultradyn_desktop");
    if (desktopBootstrap !== null) {
      if (
        request.method !== "GET" ||
        !options.sessionAuth ||
        !desktopBootstrapAvailable ||
        !desktopLauncherNonce ||
        !tokenMatches(desktopBootstrap, desktopLauncherNonce)
      ) {
        return reply.status(403).send({
          error: {
            code: "desktop_bootstrap_rejected",
            message: "The desktop session bootstrap is invalid or expired.",
          },
        });
      }
      desktopBootstrapAvailable = false;
      reply.header(
        "Set-Cookie",
        `ultradyn_session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`,
      );
      reply.header("Cache-Control", "no-store");
      return reply.redirect("/");
    }

    if (!options.sessionAuth) return;
    const hasFetchMetadata =
      request.headers["sec-fetch-mode"] !== undefined ||
      request.headers["sec-fetch-dest"] !== undefined;
    const hasDocumentNavigationHeaders = hasFetchMetadata
      ? request.headers["sec-fetch-mode"] === "navigate" &&
        request.headers["sec-fetch-dest"] === "document"
      : request.headers["upgrade-insecure-requests"] === "1" &&
        request.headers.accept?.includes("text/html");
    const isExplicitBrowserConnection =
      requestUrl.searchParams.get("ultradyn_connect") === "1" &&
      request.method === "GET" &&
      !requestUrl.pathname.startsWith("/api/") &&
      hasDocumentNavigationHeaders;
    if (isExplicitBrowserConnection) {
      reply.header(
        "Set-Cookie",
        `ultradyn_session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`,
      );
      reply.header("Cache-Control", "no-store");
      return reply.redirect("/#/settings");
    }
    const isNavigation =
      request.method === "GET" &&
      !requestUrl.pathname.startsWith("/api/") &&
      request.headers["sec-fetch-mode"] === "navigate" &&
      request.headers["sec-fetch-dest"] === "document" &&
      ["none", "same-origin"].includes(request.headers["sec-fetch-site"] ?? "");
    if (isNavigation) {
      reply.header(
        "Set-Cookie",
        `ultradyn_session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`,
      );
      reply.header("Cache-Control", "no-store");
      return;
    }

    if (
      request.method === "OPTIONS" ||
      requestUrl.pathname === "/api/health" ||
      requestUrl.pathname === "/api/runtime" ||
      requestUrl.pathname === "/api/desktop-readiness"
    ) {
      return;
    }
    if (request.url.startsWith("/api/")) {
      const cookieToken = request.headers.cookie
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("ultradyn_session="))
        ?.slice("ultradyn_session=".length);
      const bearerToken = request.headers.authorization?.startsWith("Bearer ")
        ? request.headers.authorization.slice("Bearer ".length)
        : undefined;
      if (
        !tokenMatches(cookieToken, sessionToken) &&
        !tokenMatches(bearerToken, sessionToken)
      ) {
        return reply.status(401).send({
          error: {
            code: "session_required",
            message:
              "Open the server URL directly to establish a local browser session.",
          },
        });
      }
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ServiceError) {
      void reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof z.ZodError) {
      void reply.status(400).send({
        error: {
          code: "invalid_request",
          message: "The request was invalid.",
          issues: error.issues,
        },
      });
      return;
    }
    app.log.error(error);
    void reply.status(500).send({
      error: {
        code: "internal_error",
        message: "Ultradyn Docs could not complete the request.",
      },
    });
  });

  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  if (options.allowOrigin) {
    void app.register(fastifyCors, {
      origin: [...allowedOrigins],
      credentials: false,
    });
  }

  app.get("/api/health", async () => ({
    status: "ok",
    version: options.runtime.version,
  }));
  app.get("/api/runtime", async () => options.runtime);
  app.get("/api/desktop-readiness", async (request, reply) => {
    const candidate = request.headers["x-ultradyn-launch-nonce"];
    if (
      !desktopLauncherNonce ||
      typeof candidate !== "string" ||
      !tokenMatches(candidate, desktopLauncherNonce)
    ) {
      return reply.status(404).send({
        error: {
          code: "desktop_launcher_not_found",
          message: "No matching desktop launcher owns this server.",
        },
      });
    }
    return reply.send({ status: "ok" });
  });
  app.get("/api/goals", async () => ({
    items: await options.services.goals.list(),
  }));

  app.post("/api/ask", async (request, reply) => {
    const input = askSchema.parse(request.body);
    const result = await options.services.ask({
      ...input,
      goals: input.goals.length > 0 ? input.goals : ["documentation"],
    });
    events.publish("question", result);
    return reply.send(result);
  });

  app.get("/api/questions", async (request) => {
    const query = z
      .object({
        bucket: z.enum(["active", "deferred", "answered"]).optional(),
        tier: z.enum(["P1", "P2", "P3", "P4", "P5"]).optional(),
        q: z.string().optional(),
      })
      .parse(request.query);
    return { items: await options.services.questions.list(query) };
  });

  app.get<{ Params: { id: string } }>(
    "/api/questions/:id",
    async (request, reply) => {
      const id = IdSchemas.question.parse(request.params.id);
      const question = await options.services.questions.get(id);
      if (!question)
        throw new ServiceError(
          `Question ${id} was not found`,
          404,
          "question_not_found",
        );
      return reply.send(question);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/questions/:id/claim",
    async (request) => {
      const id = IdSchemas.question.parse(request.params.id);
      const body = z.object({ answerer: SafeSlugSchema }).parse(request.body);
      const question = await options.services.questions.claim(
        id,
        body.answerer,
      );
      events.publish("question", question);
      return question;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/questions/:id/priority",
    async (request) => {
      const id = IdSchemas.question.parse(request.params.id);
      const body = prioritySchema.parse(request.body);
      const question = await options.services.questions.setPriority(
        id,
        body.tier as PriorityTier,
        body.rationale,
        body.by,
      );
      events.publish("question", question);
      return question;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/questions/:id/transcripts",
    async (request, reply) => {
      const id = IdSchemas.question.parse(request.params.id);
      const body = transcriptSchema.parse(request.body);
      const question = await options.services.questions.addTranscript(id, body);
      events.publish("question", question);
      return reply.status(201).send(question);
    },
  );

  for (const action of ["structure", "critic", "integrate"] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/questions/:id/${action}`,
      async (request) => {
        const id = IdSchemas.question.parse(request.params.id);
        const question = await options.services.questions[action](id);
        events.publish("question", question);
        return question;
      },
    );
  }

  app.post<{ Params: { id: string } }>(
    "/api/questions/:id/change-request/approve",
    async (request) => {
      const id = IdSchemas.question.parse(request.params.id);
      const body = z
        .object({
          by: SafeSlugSchema,
          kind: z.enum(["answerer", "maintainer", "summary"]),
        })
        .parse(request.body);
      const question = await options.services.questions.approveChangeRequest(
        id,
        body,
      );
      events.publish("question", question);
      return question;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/questions/:id/change-request/merge",
    async (request) => {
      const id = IdSchemas.question.parse(request.params.id);
      const body = z.object({ by: SafeSlugSchema }).parse(request.body);
      const question = await options.services.questions.mergeChangeRequest(
        id,
        body.by,
      );
      events.publish("question", question);
      return question;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/questions/:id/accept",
    async (request) => {
      const id = IdSchemas.question.parse(request.params.id);
      const body = z.object({ asker: SafeSlugSchema }).parse(request.body);
      const question = await options.services.questions.accept(id, body.asker);
      events.publish("question", question);
      return question;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/questions/:id/reject",
    async (request) => {
      const id = IdSchemas.question.parse(request.params.id);
      const body = z
        .object({
          asker: SafeSlugSchema,
          reason: z.string().trim().min(1),
        })
        .parse(request.body);
      const question = await options.services.questions.reject(
        id,
        body.asker,
        body.reason,
      );
      events.publish("question", question);
      return question;
    },
  );

  app.get("/api/settings/schema", async () => ({
    items: await options.services.settings.schema(),
  }));
  app.get("/api/settings", async () => ({
    items: await options.services.settings.values(),
  }));
  app.put("/api/settings", async (request) => {
    const body = z
      .object({
        key: z.string().min(1),
        value: z.unknown(),
        scope: z.enum(["repo", "personal"]),
      })
      .parse(request.body);
    const setting = await options.services.settings.set(
      body.key,
      body.value,
      body.scope as SettingScope,
    );
    if (body.key === "server.maintenance") {
      options.runtime.maintenanceEnabled = body.value === true;
      options.onMaintenanceChanged?.(options.runtime.maintenanceEnabled);
    }
    events.publish("settings", setting);
    return setting;
  });

  app.get("/api/providers", async () => ({
    items: await options.services.providers.list(),
  }));
  app.post<{ Params: { id: string } }>(
    "/api/providers/:id/consent",
    async (request) => {
      const id = SafeSlugSchema.parse(request.params.id);
      const body = z
        .object({
          scope: z.enum(ProviderConsentScopes),
          granted: z.boolean(),
        })
        .parse(request.body);
      const provider = await options.services.providers.consent(
        id,
        body.scope,
        body.granted,
      );
      events.publish("provider", provider);
      return provider;
    },
  );

  for (const action of ["connect", "test"] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/providers/:id/${action}`,
      async (request) => {
        const id = SafeSlugSchema.parse(request.params.id);
        const result = await options.services.providers[action](id);
        events.publish("provider", result);
        return result;
      },
    );
  }

  app.post<{ Params: { id: string } }>(
    "/api/providers/:id/disconnect",
    async (request) => {
      const id = SafeSlugSchema.parse(request.params.id);
      const body = z
        .object({ scope: z.enum(ProviderConsentScopes) })
        .parse(request.body);
      const provider = await options.services.providers.disconnect(
        id,
        body.scope,
      );
      events.publish("provider", provider);
      return provider;
    },
  );

  app.get("/api/agents", async () => ({
    agents: await options.services.agents.list(),
  }));

  app.post<{ Params: { id: string } }>(
    "/api/agents/:id/fixtures",
    async (request) =>
      options.services.agents.validate(SafeSlugSchema.parse(request.params.id)),
  );

  app.post("/api/agents/agent-smith", async (request, reply) => {
    const body = z
      .object({
        mode: z.enum(["create", "update"]),
        request: z.string().trim().min(8).max(8_000),
        target: z.string().trim().min(1).optional(),
      })
      .superRefine((value, context) => {
        if (value.mode === "update" && !value.target) {
          context.addIssue({
            code: "custom",
            path: ["target"],
            message: "Choose an existing agent to update.",
          });
        }
      })
      .parse(request.body);
    const result = await options.services.agents.propose({
      mode: body.mode,
      request: body.request,
      ...(body.target ? { target: body.target } : {}),
    });
    events.publish("maintenance", result);
    return reply.status(201).send(result);
  });

  app.get("/api/change-requests", async () => ({
    items: await options.services.changeRequests.list(),
  }));

  app.get<{ Params: { id: string } }>(
    "/api/change-requests/:id",
    async (request) => {
      const id = IdSchemas.changeRequest.parse(request.params.id);
      const result = await options.services.changeRequests.get(id);
      if (!result) {
        throw new ServiceError(
          `Change request ${id} was not found`,
          404,
          "change_request_not_found",
        );
      }
      return result;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/change-requests/:id/approve",
    async (request) => {
      const id = IdSchemas.changeRequest.parse(request.params.id);
      const body = z
        .object({
          by: SafeSlugSchema,
          kind: z.enum(["answerer", "maintainer", "summary"]),
        })
        .parse(request.body);
      const result = await options.services.changeRequests.approve(id, body);
      events.publish("maintenance", result);
      return result;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/change-requests/:id/merge",
    async (request) => {
      const id = IdSchemas.changeRequest.parse(request.params.id);
      const body = z.object({ by: SafeSlugSchema }).parse(request.body);
      const result = await options.services.changeRequests.merge(id, body.by);
      events.publish("maintenance", result);
      return result;
    },
  );

  app.post("/api/audio/sessions", async (request, reply) => {
    const body = z
      .object({
        questionId: IdSchemas.question,
        mimeType: z.string().min(1),
      })
      .parse(request.body);
    const session = await options.services.audio.create(body);
    events.publish("audio", session);
    return reply.status(201).send(session);
  });

  app.put<{ Params: { id: string; sequence: string } }>(
    "/api/audio/sessions/:id/chunks/:sequence",
    async (request, reply) => {
      const id = IdSchemas.audioSession.parse(request.params.id);
      const sequence = z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(request.params.sequence);
      if (!Buffer.isBuffer(request.body))
        throw new ServiceError(
          "Audio chunks must use application/octet-stream",
          415,
          "audio_content_type",
        );
      const result = await options.services.audio.append(
        id,
        sequence,
        request.body,
      );
      events.publish("audio", { id, ...result });
      return reply.status(202).send(result);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/audio/sessions/:id/finalize",
    async (request) => {
      const id = IdSchemas.audioSession.parse(request.params.id);
      const result = await options.services.audio.finalize(id);
      events.publish("audio", result);
      return result;
    },
  );

  app.get("/api/maintenance", async () => {
    if (!options.runtime.maintenanceEnabled)
      throw new ServiceError(
        "Maintenance mode is disabled",
        404,
        "maintenance_disabled",
      );
    const items = await options.services.maintenance.list();
    return {
      enabled: true,
      pendingCheckpoints: items.filter(
        (item) => item.kind === "checkpoint" && item.status !== "done",
      ).length,
      items,
    };
  });

  app.post("/api/maintenance/run", async (_request, reply) => {
    if (!options.runtime.maintenanceEnabled)
      throw new ServiceError(
        "Maintenance mode is disabled",
        404,
        "maintenance_disabled",
      );
    const items = await options.services.maintenance.run();
    events.publish("maintenance", items);
    return reply.status(202).send({
      enabled: true,
      pendingCheckpoints: items.filter(
        (item) => item.kind === "checkpoint" && item.status !== "done",
      ).length,
      items,
    });
  });

  app.get("/api/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");
    const unsubscribe = events.subscribe((event) => {
      reply.raw.write(
        `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    });
    const heartbeat = setInterval(
      () => reply.raw.write(": heartbeat\n\n"),
      15_000,
    );
    heartbeat.unref();
    request.raw.once("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  if (options.webRoot) {
    void app.register(async (staticApp) => {
      try {
        await access(join(options.webRoot as string, "index.html"));
      } catch {
        return;
      }
      await staticApp.register(fastifyStatic, {
        root: options.webRoot as string,
        prefix: "/",
      });
      staticApp.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith("/api/"))
          return reply.status(404).send({
            error: { code: "not_found", message: "API route not found" },
          });
        return reply.sendFile("index.html");
      });
    });
  }

  return app;
}

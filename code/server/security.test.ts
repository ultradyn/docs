import { afterEach, describe, expect, it } from "vitest";

import { buildServer, createDemoServices } from "./index.js";

describe("HTTP browser security boundary", () => {
  const servers: Array<ReturnType<typeof buildServer>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("rejects rebinding and cross-origin requests and requires a navigation session", async () => {
    const app = buildServer({
      services: createDemoServices(),
      runtime: {
        maintenanceEnabled: false,
        demoMode: true,
        repoRoot: "/tmp/network-docs",
        version: "0.1.0-test",
      },
      sessionAuth: true,
    });
    servers.push(app);

    const rebound = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "attacker.example" },
    });
    expect(rebound.statusCode).toBe(421);

    const crossOrigin = await app.inject({
      method: "POST",
      url: "/api/ask",
      headers: {
        host: "127.0.0.1:4173",
        origin: "https://attacker.example",
      },
      payload: { question: "Steal docs", goals: ["documentation"] },
    });
    expect(crossOrigin.statusCode).toBe(403);

    const missingSession = await app.inject({
      method: "POST",
      url: "/api/ask",
      headers: { host: "127.0.0.1:4173" },
      payload: { question: "No session", goals: ["documentation"] },
    });
    expect(missingSession.statusCode).toBe(401);

    const navigation = await app.inject({
      method: "GET",
      url: "/",
      headers: {
        host: "127.0.0.1:4173",
        accept: "text/html",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
      },
    });
    const cookie = navigation.headers["set-cookie"];
    expect(cookie).toMatch(/^ultradyn_session=/);
    expect(navigation.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    expect(navigation.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(navigation.headers["x-content-type-options"]).toBe("nosniff");
    expect(navigation.headers["referrer-policy"]).toBe("no-referrer");
    expect(navigation.headers["permissions-policy"]).toContain(
      "microphone=(self)",
    );

    const authorized = await app.inject({
      method: "POST",
      url: "/api/ask",
      headers: { host: "127.0.0.1:4173", cookie },
      payload: {
        question: "What is already documented?",
        goals: ["documentation"],
        asker: "max",
      },
    });
    expect(authorized.statusCode).toBe(200);
  });

  it("bootstraps a session from a same-origin browser POST without Fetch Metadata", async () => {
    const app = buildServer({
      services: createDemoServices(),
      runtime: {
        maintenanceEnabled: false,
        demoMode: true,
        repoRoot: "/tmp/network-docs",
        version: "0.1.0-test",
      },
      sessionAuth: true,
      allowedHostnames: ["xsm"],
    });
    servers.push(app);

    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/browser-session",
      headers: {
        host: "xsm:5885",
        origin: "http://xsm:5885",
        "x-ultradyn-browser-session": "1",
      },
    });

    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.headers["set-cookie"]).toMatch(/^ultradyn_session=/);
    expect(bootstrap.headers["cache-control"]).toBe("no-store");

    const settings = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: {
        host: "xsm:5885",
        cookie: bootstrap.headers["set-cookie"],
      },
    });
    expect(settings.statusCode).toBe(200);
  });

  it("rejects unmarked or cross-origin browser session bootstraps", async () => {
    const app = buildServer({
      services: createDemoServices(),
      runtime: {
        maintenanceEnabled: false,
        demoMode: true,
        repoRoot: "/tmp/network-docs",
        version: "0.1.0-test",
      },
      sessionAuth: true,
      allowedHostnames: ["xsm"],
      allowOrigin: "https://dev.example",
    });
    servers.push(app);

    const missingOrigin = await app.inject({
      method: "POST",
      url: "/api/browser-session",
      headers: {
        host: "xsm:5885",
        "x-ultradyn-browser-session": "1",
      },
    });
    const missingMarker = await app.inject({
      method: "POST",
      url: "/api/browser-session",
      headers: {
        host: "xsm:5885",
        origin: "http://xsm:5885",
      },
    });
    const allowedButCrossOrigin = await app.inject({
      method: "POST",
      url: "/api/browser-session",
      headers: {
        host: "xsm:5885",
        origin: "https://dev.example",
        "x-ultradyn-browser-session": "1",
      },
    });

    expect([
      missingOrigin.statusCode,
      missingMarker.statusCode,
      allowedButCrossOrigin.statusCode,
    ]).toEqual([403, 403, 403]);
    expect(missingOrigin.headers["set-cookie"]).toBeUndefined();
    expect(missingMarker.headers["set-cookie"]).toBeUndefined();
    expect(allowedButCrossOrigin.headers["set-cookie"]).toBeUndefined();
  });

  it("uses a one-time desktop nonce for owned readiness and session bootstrap", async () => {
    const app = buildServer({
      services: createDemoServices(),
      runtime: {
        maintenanceEnabled: false,
        demoMode: true,
        repoRoot: "/tmp/network-docs",
        version: "0.1.0-test",
      },
      sessionAuth: true,
      desktopLauncherNonce: "a".repeat(64),
    });
    servers.push(app);

    const anonymousReadiness = await app.inject({
      method: "GET",
      url: "/api/desktop-readiness",
    });
    expect(anonymousReadiness.statusCode).toBe(404);

    const ownedReadiness = await app.inject({
      method: "GET",
      url: "/api/desktop-readiness",
      headers: { "x-ultradyn-launch-nonce": "a".repeat(64) },
    });
    expect(ownedReadiness.statusCode).toBe(200);
    expect(ownedReadiness.json()).toEqual({ status: "ok" });

    const bootstrap = await app.inject({
      method: "GET",
      url: `/?ultradyn_desktop=${"a".repeat(64)}`,
      headers: {
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(bootstrap.statusCode).toBe(302);
    expect(bootstrap.headers.location).toBe("/");
    expect(bootstrap.headers["set-cookie"]).toMatch(/^ultradyn_session=/);

    const reused = await app.inject({
      method: "GET",
      url: `/?ultradyn_desktop=${"a".repeat(64)}`,
    });
    expect(reused.statusCode).toBe(403);
    expect(reused.headers["set-cookie"]).toBeUndefined();
  });

  it("requires an explicit handshake for a cross-site browser connection", async () => {
    const app = buildServer({
      services: createDemoServices(),
      runtime: {
        maintenanceEnabled: false,
        demoMode: true,
        repoRoot: "/tmp/network-docs",
        version: "0.1.0-test",
      },
      sessionAuth: true,
    });
    servers.push(app);
    const navigationHeaders = {
      host: "127.0.0.1:4173",
      accept: "text/html",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "cross-site",
    };

    const ordinaryNavigation = await app.inject({
      method: "GET",
      url: "/",
      headers: navigationHeaders,
    });
    expect(ordinaryNavigation.headers["set-cookie"]).toBeUndefined();

    const compatibilityNavigationHeaders = {
      host: "127.0.0.1:4173",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "upgrade-insecure-requests": "1",
    };
    const ordinaryCompatibilityNavigation = await app.inject({
      method: "GET",
      url: "/",
      headers: compatibilityNavigationHeaders,
    });
    expect(
      ordinaryCompatibilityNavigation.headers["set-cookie"],
    ).toBeUndefined();

    const iframeConnection = await app.inject({
      method: "GET",
      url: "/?ultradyn_connect=1",
      headers: {
        ...compatibilityNavigationHeaders,
        "sec-fetch-dest": "iframe",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(iframeConnection.headers["set-cookie"]).toBeUndefined();

    const connection = await app.inject({
      method: "GET",
      url: "/?ultradyn_connect=1",
      headers: compatibilityNavigationHeaders,
    });
    expect(connection.statusCode).toBe(302);
    expect(connection.headers.location).toBe("/#/settings");
    expect(connection.headers["set-cookie"]).toMatch(/^ultradyn_session=/);

    const settings = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: {
        host: "127.0.0.1:4173",
        cookie: connection.headers["set-cookie"],
      },
    });
    expect(settings.statusCode).toBe(200);
  });
});

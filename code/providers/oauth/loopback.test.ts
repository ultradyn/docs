import { describe, expect, it } from "vitest";

import { startLoopbackListener } from "./loopback.js";

describe("startLoopbackListener", () => {
  it("captures code and state on the expected path and serves success HTML", async () => {
    const listener = await startLoopbackListener({
      path: "/callback",
      timeoutMs: 5_000,
    });
    try {
      const pending = listener.waitForCallback();
      const response = await fetch(
        `http://127.0.0.1:${listener.port}/callback?code=abc&state=xyz`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/text\/html/u);
      const html = await response.text();
      expect(html).toMatch(/close this tab/iu);
      await expect(pending).resolves.toEqual({ code: "abc", state: "xyz" });
    } finally {
      await listener.close();
    }
  });

  it("returns 404 for the wrong path and does not resolve the callback", async () => {
    const listener = await startLoopbackListener({
      path: "/callback",
      timeoutMs: 200,
    });
    try {
      const pending = listener.waitForCallback();
      const response = await fetch(
        `http://127.0.0.1:${listener.port}/other?code=abc&state=xyz`,
      );
      expect(response.status).toBe(404);
      await expect(pending).rejects.toThrow(/timed out/iu);
    } finally {
      await listener.close();
    }
  });

  it("returns 400 when code or state is missing", async () => {
    const listener = await startLoopbackListener({
      path: "/callback",
      timeoutMs: 1_000,
    });
    try {
      const pending = listener.waitForCallback();
      const response = await fetch(
        `http://127.0.0.1:${listener.port}/callback?code=only`,
      );
      expect(response.status).toBe(400);
      await expect(pending).rejects.toThrow(/missing code or state/iu);
    } finally {
      await listener.close().catch(() => undefined);
    }
  });
});

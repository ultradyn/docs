import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDemoServices,
  localDataRootForRepository,
  startUltradynServer,
} from "./index.js";
import { browserUrlHostname } from "./testing.js";

describe("machine-local repository identity", () => {
  it("formats IPv6 hostnames for browser URLs", () => {
    expect(browserUrlHostname("::1")).toBe("[::1]");
    expect(browserUrlHostname("[::1]")).toBe("[::1]");
    expect(browserUrlHostname("docs.example.test")).toBe("docs.example.test");
  });

  it.runIf(process.platform !== "win32")(
    "uses one data root for canonical and symlinked repository paths",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "ultradyn-data-identity-"));
      const alias = `${root}-alias`;
      await symlink(root, alias, "dir");

      expect(localDataRootForRepository(alias)).toBe(
        localDataRootForRepository(root),
      );
    },
  );

  it("requires an explicit browser host when binding a wildcard address", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-wildcard-host-"));

    await expect(
      startUltradynServer({
        repoRoot: root,
        packageRoot: root,
        host: "0.0.0.0",
        services: createDemoServices(),
        openBrowser: false,
      }),
    ).rejects.toThrow(/--allowed-host/i);
  });
});

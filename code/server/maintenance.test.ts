import { describe, expect, it, vi } from "vitest";

import { MaintenanceScheduler } from "./testing.js";

describe("MaintenanceScheduler", () => {
  it("polls immediately when maintainer mode starts", async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = new MaintenanceScheduler({ intervalMs: 60_000, run });

    scheduler.start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    scheduler.stop();
  });

  it("does not overlap a scheduled poll with one already running", async () => {
    let release!: () => void;
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(() => running);
    const scheduler = new MaintenanceScheduler({ intervalMs: 60_000, run });

    const first = scheduler.tick();
    await scheduler.tick();
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});

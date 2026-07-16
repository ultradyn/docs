import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FakeGitHostProvider,
  type GitHostPollRequest,
} from "../providers/index.js";
import { MaintenanceCoordinator } from "./testing.js";

class RecordingFakeGitHostProvider extends FakeGitHostProvider {
  readonly requests: GitHostPollRequest[] = [];

  override async poll(request: GitHostPollRequest) {
    this.requests.push(request);
    return super.poll(request);
  }
}

describe("MaintenanceCoordinator", () => {
  it("persists review tasks across a coordinator restart", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "ultradyn-maintenance-"));
    const provider = new FakeGitHostProvider();
    provider.tasks.push({
      id: "event-42-abc123",
      changeRequestId: "42",
      revision: "abc123",
      reason: "opened",
    });

    const coordinator = new MaintenanceCoordinator({
      dataRoot,
      provider,
      now: () => new Date("2026-07-16T01:02:03.000Z"),
    });
    const tasks = await coordinator.run("ultradyn/docs");

    expect(tasks).toEqual([
      {
        id: "fake-git-host:ultradyn/docs#42",
        kind: "review",
        title: "Review change request #42",
        detail: "fake-git-host reported opened at revision abc123.",
        status: "open",
        updated: "2026-07-16T01:02:03.000Z",
      },
    ]);

    const restarted = new MaintenanceCoordinator({ dataRoot, provider });
    expect(await restarted.list("ultradyn/docs")).toEqual(tasks);
  });

  it("persists claim and completion status", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "ultradyn-maintenance-"));
    const provider = new FakeGitHostProvider();
    provider.tasks.push({
      id: "event-7-first",
      changeRequestId: "7",
      revision: "first",
      reason: "review-requested",
    });
    const coordinator = new MaintenanceCoordinator({ dataRoot, provider });
    const [task] = await coordinator.run("ultradyn/docs");

    await coordinator.setStatus("ultradyn/docs", task!.id, "claimed");
    await coordinator.setStatus("ultradyn/docs", task!.id, "done");

    const restarted = new MaintenanceCoordinator({ dataRoot, provider });
    expect(await restarted.list("ultradyn/docs")).toMatchObject([
      { id: task!.id, status: "done" },
    ]);
  });

  it("reopens one stable task for re-review when the head revision changes", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "ultradyn-maintenance-"));
    const provider = new RecordingFakeGitHostProvider();
    provider.tasks.push({
      id: "event-7-first",
      changeRequestId: "7",
      revision: "first",
      reason: "opened",
    });
    const first = new MaintenanceCoordinator({
      dataRoot,
      provider,
      now: () => new Date("2026-07-16T01:00:00.000Z"),
    });
    const [initial] = await first.run("ultradyn/docs");
    await first.setStatus("ultradyn/docs", initial!.id, "done");

    provider.tasks.push({
      id: "event-7-second",
      changeRequestId: "7",
      revision: "second",
      reason: "updated",
    });
    const restarted = new MaintenanceCoordinator({
      dataRoot,
      provider,
      now: () => new Date("2026-07-16T02:00:00.000Z"),
    });
    const updated = await restarted.run("ultradyn/docs");

    expect(provider.requests[1]?.cursor).toBe("fake-cursor-0001");
    expect(updated).toEqual([
      {
        id: initial!.id,
        kind: "rereview",
        title: "Re-review change request #7",
        detail:
          "Head revision changed from first to second; the prior review is no longer current.",
        status: "open",
        updated: "2026-07-16T02:00:00.000Z",
      },
    ]);

    await restarted.setStatus("ultradyn/docs", initial!.id, "done");
    provider.tasks.push({
      id: "event-7-second",
      changeRequestId: "7",
      revision: "second",
      reason: "updated",
    });
    const unchanged = await restarted.run("ultradyn/docs");
    expect(unchanged).toHaveLength(1);
    expect(unchanged[0]).toMatchObject({ id: initial!.id, status: "done" });
  });

  it("serializes overlapping polls so cursor and task updates cannot be lost", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "ultradyn-maintenance-"));
    const provider = new RecordingFakeGitHostProvider();
    provider.tasks.push({
      id: "event-8-head",
      changeRequestId: "8",
      revision: "head",
      reason: "opened",
    });
    const coordinator = new MaintenanceCoordinator({ dataRoot, provider });

    const [first, second] = await Promise.all([
      coordinator.run("ultradyn/docs"),
      coordinator.run("ultradyn/docs"),
    ]);

    expect(provider.requests.map((request) => request.cursor)).toEqual([
      null,
      "fake-cursor-0001",
    ]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(await coordinator.list("ultradyn/docs")).toHaveLength(1);
  });
});

// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ApiClient } from "../api.js";
import {
  ApiContext,
  type ActorIdentityState,
  type ApiContextValue,
} from "../api-context.js";
import { AskPage } from "./AskPage.js";
import { AnswerPage } from "./AnswerPage.js";
import { MaintenancePage } from "./MaintenancePage.js";
import { QueuePage } from "./QueuePage.js";
import { SettingsPage } from "./SettingsPage.js";

const ASK_QUESTION_PLACEHOLDER =
  "Fill in your goals then ask a specific question…";

afterEach(cleanup);

function renderRoute(
  element: React.ReactNode,
  route = "/",
  path = "*",
  api = new ApiClient({ clientDemo: true }),
  actorIdentity: ActorIdentityState = {
    status: "configured",
    handle: "alex.review-1",
  },
) {
  const context: ApiContextValue = {
    api,
    runtime: {
      maintenanceEnabled: true,
      demoMode: true,
      repoRoot: "~/network-docs",
      version: "test",
    },
    refreshRuntime: async () => undefined,
    refreshActorIdentity: async () => undefined,
    actorIdentity,
    eventConnected: true,
  };
  return render(
    <ApiContext.Provider value={context}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path={path} element={element} />
        </Routes>
      </MemoryRouter>
    </ApiContext.Provider>,
  );
}

describe("primary web routes", () => {
  it("adds an accessible freeform goal alongside the default vocabulary", async () => {
    const user = userEvent.setup();
    const api = new ApiClient({ clientDemo: true });
    const ask = vi.spyOn(api, "ask").mockResolvedValue({
      kind: "answer",
      answer: "A grounded answer.",
      citations: [],
      goalResults: [],
    });
    renderRoute(<AskPage />, "/", "*", api);

    const customGoal = await screen.findByLabelText("Add a custom goal");
    await user.type(customGoal, "Prepare a launch review{Enter}");

    expect(
      screen
        .getByRole("button", { name: "Prepare a launch review" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Documentation" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    await user.type(
      screen.getByPlaceholderText(ASK_QUESTION_PLACEHOLDER),
      "Is this ready to launch?",
    );
    await user.click(
      screen.getByRole("button", { name: "Ask the documentation" }),
    );

    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        goals: ["documentation", "prepare-a-launch-review"],
        asker: "alex.review-1",
      }),
    );
  });

  it("retries the exact failed ask payload", async () => {
    const user = userEvent.setup();
    const api = new ApiClient({ clientDemo: true });
    const ask = vi
      .spyOn(api, "ask")
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce({
        kind: "answer",
        answer: "Recovered answer.",
        citations: [],
        goalResults: [],
      });
    renderRoute(<AskPage />, "/", "*", api);

    await user.click(
      await screen.findByRole("button", { name: "Add conversation context" }),
    );
    const identity = screen.getByPlaceholderText("Name or stable handle");
    const context = screen.getByPlaceholderText(
      "Paste only context that affects the question.",
    );
    await user.clear(identity);
    await user.type(identity, "alex");
    await user.type(context, "Release train 42 is blocked.");
    await user.type(
      screen.getByPlaceholderText(ASK_QUESTION_PLACEHOLDER),
      "Can we release safely?",
    );
    await user.click(
      screen.getByRole("button", { name: "Ask the documentation" }),
    );

    expect(await screen.findByText(/Connection interrupted/)).toBeTruthy();
    const firstPayload = ask.mock.calls[0]?.[0];
    await user.clear(identity);
    await user.type(identity, "someone-else");
    await user.clear(context);
    await user.type(context, "Different context.");
    await user.click(screen.getByRole("button", { name: "Retry question" }));

    expect(await screen.findByText("Recovered answer.")).toBeTruthy();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1]?.[0]).toEqual(firstPayload);
  });

  it("logs an unsupported ask with its stable queue identity", async () => {
    const user = userEvent.setup();
    renderRoute(<AskPage />);

    const composer = await screen.findByPlaceholderText(
      ASK_QUESTION_PLACEHOLDER,
    );
    await user.type(composer, "Which release process handles a solar flare?");
    await user.click(
      screen.getByRole("button", { name: "Ask the documentation" }),
    );

    expect(await screen.findByText("Knowledge gap captured")).toBeTruthy();
    expect(screen.getByText(/q-DEMO/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /View queue record/ }),
    ).toBeTruthy();
  });

  it("keeps a grounded partial answer visible when the remaining gap is logged", async () => {
    const user = userEvent.setup();
    const api = new ApiClient({ clientDemo: true });
    vi.spyOn(api, "ask").mockResolvedValue({
      kind: "logged",
      partialAnswer: "The repository already specifies checksum verification.",
      citations: [
        { path: "docs/recovery.md", excerpt: "Verify the checksum." },
      ],
      question: {
        id: "q-PARTIAL",
        title: "Recovery edge case",
        question: "How does the remaining recovery edge case work?",
        state: "active",
        tier: "P2",
        goals: ["implementation"],
        tags: ["raw"],
        createdAt: "2026-07-16T00:00:00.000Z",
      },
    });
    renderRoute(<AskPage />, "/", "*", api);

    await user.type(
      await screen.findByPlaceholderText(ASK_QUESTION_PLACEHOLDER),
      "How does the remaining recovery edge case work?",
    );
    await user.click(
      screen.getByRole("button", { name: "Ask the documentation" }),
    );

    expect(
      await screen.findByText("What the repository already establishes"),
    ).toBeTruthy();
    expect(screen.getByText(/checksum verification/)).toBeTruthy();
    expect(screen.getByText("docs/recovery.md")).toBeTruthy();
  });

  it("shows priority, provenance, and an override from a queue detail route", async () => {
    const user = userEvent.setup();
    const api = new ApiClient({ clientDemo: true });
    const priority = vi.spyOn(api, "priority");
    renderRoute(
      <QueuePage />,
      "/queue/q-01K0DEMOSECURITY",
      "/queue/:questionId",
      api,
    );

    expect(await screen.findByText("Why P1?")).toBeTruthy();
    expect(screen.getByText("Raw asker question")).toBeTruthy();
    expect(screen.getByLabelText("Override rationale")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Claim and answer" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "P2" }));
    expect(priority).toHaveBeenCalledWith(
      "q-01K0DEMOSECURITY",
      "P2",
      "Manual override after reviewing the question context.",
      "alex.review-1",
    );
  });

  it("filters the queue through the shared styled tier combobox", async () => {
    const user = userEvent.setup();
    const api = new ApiClient({ clientDemo: true });
    const questions = vi.spyOn(api, "questions");
    renderRoute(<QueuePage />, "/queue", "/queue", api);

    const tier = await screen.findByRole("combobox", {
      name: "Priority tier",
    });
    expect(tier.getAttribute("aria-expanded")).toBe("false");

    await user.click(tier);
    expect(tier.getAttribute("aria-expanded")).toBe("true");
    await user.click(screen.getByRole("option", { name: "P1 only" }));

    await waitFor(() =>
      expect(questions).toHaveBeenLastCalledWith(
        expect.objectContaining({ tier: "P1" }),
      ),
    );
    expect(tier.textContent).toContain("P1 only");
  });

  it("claims an active question before opening its answer room", async () => {
    const user = userEvent.setup();
    const api = new ApiClient({ clientDemo: true });
    const claim = vi.spyOn(api, "claim").mockResolvedValue({} as never);
    renderRoute(<AnswerPage />, "/answer", "/answer", api);

    await user.click(
      await screen.findByRole("button", {
        name: /How are credential sources kept out of the repository\?/,
      }),
    );

    expect(claim).toHaveBeenCalledWith("q-01K0DEMOSECURITY", "alex.review-1");
  });

  it("fails closed and links to Settings when an attributed claim has no identity", async () => {
    const user = userEvent.setup();
    const api = new ApiClient({ clientDemo: true });
    const claim = vi.spyOn(api, "claim");
    renderRoute(<AnswerPage />, "/answer", "/answer", api, {
      status: "missing",
    });

    expect(await screen.findByText("Set your actor handle")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Settings" })).toBeTruthy();
    const question = await screen.findByRole("button", {
      name: /How are credential sources kept out of the repository\?/,
    });
    expect((question as HTMLButtonElement).disabled).toBe(true);
    await user.click(question);
    expect(claim).not.toHaveBeenCalled();
  });

  it("only offers an asker decision to the matching configured identity", async () => {
    const question = {
      id: "q-01K0DEMOASKER0000000000000",
      title: "Is the runbook complete?",
      question: "Is the runbook complete?",
      state: "merged" as const,
      tier: "P2" as const,
      goals: ["documentation"],
      tags: ["raw"],
      createdAt: "2026-07-16T00:00:00.000Z",
      askers: [{ id: "max", name: "Max", status: "pending" }],
      changeRequest: {
        id: "cr-01K0DEMOASKER000000000000",
        state: "merged" as const,
        branch: "ultradyn/question",
        summary: "Documents the runbook.",
        diff: "+Runbook",
        checks: [],
        approvals: [],
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
      },
    };
    const api = new ApiClient({ clientDemo: true });
    vi.spyOn(api, "question").mockResolvedValue(question);

    const view = renderRoute(
      <AnswerPage />,
      `/answer/${question.id}`,
      "/answer/:questionId",
      api,
      { status: "configured", handle: "alex" },
    );
    expect(
      await screen.findByText("This answer is waiting for Max"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept answer" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open Settings" })).toBeTruthy();

    view.unmount();
    renderRoute(
      <AnswerPage />,
      `/answer/${question.id}`,
      "/answer/:questionId",
      api,
      { status: "configured", handle: "max" },
    );
    expect(
      await screen.findByRole("button", { name: "Accept answer" }),
    ).toBeTruthy();
  });

  it("attributes maintainer approval to the configured actor handle", async () => {
    const user = userEvent.setup();
    const api = new ApiClient({ clientDemo: true });
    vi.spyOn(api, "maintenance").mockResolvedValue({
      enabled: true,
      polling: false,
      tasks: [
        {
          id: "cr-review",
          kind: "review",
          title: "Review docs",
          status: "ready",
          detail: "Review the local diff.",
          updatedAt: "2026-07-16T00:00:00.000Z",
        },
      ],
    });
    vi.spyOn(api, "agents").mockResolvedValue([]);
    vi.spyOn(api, "changeRequest").mockResolvedValue({
      id: "cr-review",
      state: "open",
      branch: "ultradyn/review",
      summary: "Documents the change.",
      diff: "+Safe change",
      checks: [],
      approvals: [],
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    });
    const approve = vi
      .spyOn(api, "changeRequestReviewAction")
      .mockResolvedValue({
        id: "cr-review",
        state: "approved",
        branch: "ultradyn/review",
        summary: "Documents the change.",
        diff: "+Safe change",
        checks: [],
        approvals: [],
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
      });
    renderRoute(<MaintenancePage />, "/", "*", api, {
      status: "configured",
      handle: "alex.review-1",
    });

    await user.click(await screen.findByRole("button", { name: "Open" }));
    await user.click(
      await screen.findByRole("button", { name: "Approve as maintainer" }),
    );
    expect(approve).toHaveBeenCalledWith("cr-review", "approve", {
      by: "alex.review-1",
      kind: "maintainer",
    });
  });

  it("shows a disabled-checkpoint task without offering an invalid review action", async () => {
    const api = new ApiClient({ clientDemo: true });
    vi.spyOn(api, "maintenance").mockResolvedValue({
      enabled: true,
      polling: false,
      pendingCheckpoints: 1,
      tasks: [
        {
          id: "checkpoint:portable-state",
          kind: "checkpoint",
          title: "Checkpoint pending portable state",
          detail:
            "Automatic checkpoint commits are disabled; portable paths are waiting under questions/ and settings/.",
          status: "ready",
          updatedAt: "2026-07-16T00:00:00.000Z",
        },
      ],
    });
    vi.spyOn(api, "agents").mockResolvedValue([]);

    renderRoute(<MaintenancePage />, "/", "*", api);

    expect(
      await screen.findByText("Checkpoint pending portable state"),
    ).toBeTruthy();
    expect(
      screen.getByText(/Automatic checkpoint commits are disabled/),
    ).toBeTruthy();
    expect(
      screen.getByText("Claimable work").closest("p")?.textContent,
    ).toContain("0");
    expect(
      screen.getByText("Pending checkpoints").closest("p")?.textContent,
    ).toContain("1");
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  });

  it("requires an explicit claim before a deep-linked answer can record", async () => {
    renderRoute(
      <AnswerPage />,
      "/answer/q-01K0DEMOSECURITY",
      "/answer/:questionId",
    );

    expect(await screen.findByText("Claim required")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Start recording" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Claim question" })).toBeTruthy();
  });

  it("continues an existing answer without claiming it again", async () => {
    const user = userEvent.setup();
    const api = new ApiClient({ clientDemo: true });
    const claim = vi.spyOn(api, "claim");
    renderRoute(
      <QueuePage />,
      "/queue/q-01K0DEMOAUDIO",
      "/queue/:questionId",
      api,
    );

    await user.click(
      await screen.findByRole("button", { name: "Continue answer" }),
    );
    expect(claim).not.toHaveBeenCalled();
  });

  it("does not offer capture for deferred queue records", async () => {
    renderRoute(<QueuePage />, "/queue/q-01K0DEMODEFER", "/queue/:questionId");

    expect(
      await screen.findByText("Answering is unavailable while deferred."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Claim and answer" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Continue answer" }),
    ).toBeNull();
  });

  it("exposes fake provider state and exact activation work", async () => {
    const user = userEvent.setup();
    renderRoute(<SettingsPage />);

    await user.click(await screen.findByRole("tab", { name: "Connections" }));
    await user.click(
      await screen.findByRole("button", { name: /Grok \/ xAI/ }),
    );

    expect(screen.getByText("Exact activation checklist")).toBeTruthy();
    expect(
      screen.getByText(/Register a loopback-capable xAI OAuth client/),
    ).toBeTruthy();
    expect(
      screen.getAllByText("Fake contract available").length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Test contract" })).toBeTruthy();
  });

  it("identifies restart-required settings and announces a restart after saving", async () => {
    const user = userEvent.setup();
    const api = new ApiClient({ clientDemo: true });
    vi.spyOn(api, "settings").mockResolvedValue({
      values: { "server.pollIntervalMinutes": 15 },
    });
    vi.spyOn(api, "settingSchema").mockResolvedValue([
      {
        key: "server.pollIntervalMinutes",
        label: "Maintenance poll interval",
        description: "Minutes between Git-host checks.",
        category: "Server",
        scope: "repo",
        type: "number",
        defaultValue: 15,
        restartRequired: true,
      },
    ]);
    vi.spyOn(api, "providers").mockResolvedValue([]);
    const save = vi.spyOn(api, "settingsSave").mockResolvedValue({
      values: { "server.pollIntervalMinutes": 30 },
    });
    renderRoute(<SettingsPage />, "/", "*", api);

    expect(await screen.findByText("Restart required")).toBeTruthy();
    expect(
      screen.getByRole("note", {
        name: "This setting requires an Ultradyn Docs restart",
      }),
    ).toBeTruthy();
    const interval = screen.getByRole("spinbutton", {
      name: "Maintenance poll interval",
    });
    expect(interval.getAttribute("aria-describedby")).toContain(
      "setting-server-pollintervalminutes-restart-required",
    );
    await user.clear(interval);
    await user.type(interval, "30");
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(save).toHaveBeenCalledWith(
      { "server.pollIntervalMinutes": 30 },
      { "server.pollIntervalMinutes": "repo" },
    );
    expect(
      await screen.findByText("Restart Ultradyn Docs to apply this change"),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "The saved server setting will take effect after a restart.",
    );
  });

  it("retains unsaved settings when the connection drops during save", async () => {
    const user = userEvent.setup();
    const api = new ApiClient({ clientDemo: true });
    vi.spyOn(api, "settings").mockResolvedValue({
      values: { "server.pollIntervalMinutes": 15 },
    });
    vi.spyOn(api, "settingSchema").mockResolvedValue([
      {
        key: "server.pollIntervalMinutes",
        label: "Maintenance poll interval",
        description: "Minutes between Git-host checks.",
        category: "Server",
        scope: "repo",
        type: "number",
        defaultValue: 15,
      },
    ]);
    vi.spyOn(api, "providers").mockResolvedValue([]);
    vi.spyOn(api, "settingsSave").mockRejectedValue(
      new Error("The server connection dropped before the save completed."),
    );
    renderRoute(<SettingsPage />, "/", "*", api);

    const interval = await screen.findByRole("spinbutton", {
      name: "Maintenance poll interval",
    });
    await user.clear(interval);
    await user.type(interval, "30");
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(
      await screen.findByText(
        "The server connection dropped before the save completed.",
      ),
    ).toBeTruthy();
    expect((interval as HTMLInputElement).value).toBe("30");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save settings" })).toBeTruthy();
  });

  it("can change the server URL when settings cannot establish a browser session", async () => {
    const user = userEvent.setup();
    const api = new ApiClient({ baseUrl: "http://127.0.0.1:49321" });
    vi.spyOn(api, "settings").mockRejectedValue(
      new Error(
        "Open the server URL directly to establish a local browser session.",
      ),
    );
    vi.spyOn(api, "settingSchema").mockResolvedValue([]);
    vi.spyOn(api, "providers").mockResolvedValue([]);
    renderRoute(<SettingsPage />, "/", "*", api);

    expect(await screen.findByText("We couldn’t load this")).toBeTruthy();
    expect(
      screen.getByText(
        "Open the server URL directly to establish a local browser session.",
      ),
    ).toBeTruthy();

    const serverUrl = screen.getByRole("textbox", { name: "Server URL" });
    expect((serverUrl as HTMLInputElement).value).toBe(
      "http://127.0.0.1:49321",
    );
    await user.clear(serverUrl);
    await user.type(serverUrl, "http://127.0.0.1:5885");

    expect(
      screen
        .getByRole("link", { name: "Connect to different server" })
        .getAttribute("href"),
    ).toBe("http://127.0.0.1:5885/?ultradyn_connect=1#/settings");
    expect(
      screen.getByText(
        "This page reconnects to the current server automatically. Change the URL only to connect to a different server.",
      ),
    ).toBeTruthy();
  });

  it("does not put credentials into a server connection link", async () => {
    const user = userEvent.setup();
    renderRoute(<SettingsPage />);

    const serverUrl = await screen.findByRole("textbox", {
      name: "Server URL",
    });
    await user.clear(serverUrl);
    await user.type(serverUrl, "http://operator:secret@127.0.0.1:5885");

    expect(
      (
        screen.getByRole("button", {
          name: "Connect to different server",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.queryByRole("link", { name: "Connect to different server" }),
    ).toBeNull();
    expect(
      screen.getByText("Enter an HTTP(S) server URL without credentials."),
    ).toBeTruthy();
    expect(serverUrl.getAttribute("aria-describedby")).toBe("server-url-error");
  });

  it("reports an unavailable provider test as a failure", async () => {
    const user = userEvent.setup();
    const api = new ApiClient({ clientDemo: true });
    vi.spyOn(api, "providerAction").mockResolvedValue({
      ok: false,
      detail: "Grok / xAI still requires consent.",
    });
    renderRoute(<SettingsPage />, "/", "*", api);

    await user.click(await screen.findByRole("tab", { name: "Connections" }));
    await user.click(
      await screen.findByRole("button", { name: /Grok \/ xAI/ }),
    );
    await user.click(screen.getByRole("button", { name: "Test contract" }));

    expect(await screen.findByText("Provider test failed")).toBeTruthy();
    expect(screen.getByText("Grok / xAI still requires consent.")).toBeTruthy();
  });

  it("grants and revokes provider consent one clearly labelled scope at a time", async () => {
    const user = userEvent.setup();
    const api = new ApiClient({ clientDemo: true });
    const providerAction = vi.spyOn(api, "providerAction");
    renderRoute(<SettingsPage />, "/", "*", api);

    await user.click(await screen.findByRole("tab", { name: "Connections" }));
    await user.click(
      await screen.findByRole("button", { name: /Grok \/ xAI/ }),
    );

    expect(screen.getByText("Model use")).toBeTruthy();
    expect(screen.getByText("Speech transcription")).toBeTruthy();
    const modelConfirmation = screen.getByRole("checkbox", {
      name: /authorize model use/i,
    });
    await user.click(modelConfirmation);
    await user.click(
      screen.getByRole("button", { name: "Grant model consent" }),
    );

    expect(providerAction).toHaveBeenCalledWith("grok", "consent", {
      scope: "model",
      granted: true,
    });
    expect(await screen.findByText("Grok / xAI updated")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Grant transcription consent" }),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Codex \/ ChatGPT/ }));
    const revokeModel = screen.getByRole("button", {
      name: "Revoke model consent",
    });
    await waitFor(() =>
      expect((revokeModel as HTMLButtonElement).disabled).toBe(false),
    );
    await user.click(revokeModel);
    expect(providerAction).toHaveBeenCalledWith("codex", "consent", {
      scope: "model",
      granted: false,
    });
  });

  it("lists repository agents and keeps Agent-Smith in a change-request lane", async () => {
    const user = userEvent.setup();
    renderRoute(<MaintenancePage />);

    await user.click(screen.getByRole("tab", { name: "Agents" }));
    expect(
      await screen.findByText("Definitions hot-load from repository HEAD"),
    ).toBeTruthy();
    expect(screen.getByText("Agent-Smith")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Create change request",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

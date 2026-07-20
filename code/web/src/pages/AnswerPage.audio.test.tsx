// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ApiClient } from "../api.js";
import { ApiContext, type ApiContextValue } from "../api-context.js";
import { AnswerPage } from "./AnswerPage.js";

class FakeMediaRecorder {
  static isTypeSupported = () => true;

  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;

  start() {
    this.state = "recording";
  }

  pause() {
    this.state = "paused";
  }

  resume() {
    this.state = "recording";
  }

  requestData() {}

  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"]) } as BlobEvent);
    this.onstop?.(new Event("stop"));
  }
}

describe("Answer page audio recovery", () => {
  const stopTrack = vi.fn();
  const stream = {
    getTracks: () => [{ stop: stopTrack, onended: null }],
  } as unknown as MediaStream;

  beforeEach(() => {
    stopTrack.mockClear();
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: FakeMediaRecorder,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) },
    });
  });

  afterEach(cleanup);

  it("offers an accessible finalization retry after every chunk is uploaded", async () => {
    const user = userEvent.setup();
    const api = new ApiClient({ clientDemo: true });
    const finalize = vi
      .spyOn(api, "finalizeAudioSession")
      .mockRejectedValueOnce(new Error("Transcription provider unavailable"))
      .mockResolvedValueOnce({
        status: "ready",
        transcript: "Recovered transcript",
      });
    const context: ApiContextValue = {
      api,
      runtime: {
        maintenanceEnabled: false,
        demoMode: false,
        repoRoot: "~/network-docs",
        version: "test",
      },
      refreshRuntime: async () => undefined,
      refreshActorIdentity: async () => undefined,
      refreshTheme: async () => undefined,
      actorIdentity: { status: "configured", handle: "alex.review-1" },
      eventConnected: true,
    };

    render(
      <ApiContext.Provider value={context}>
        <MemoryRouter initialEntries={["/answer/q-01K0DEMOAUDIO"]}>
          <Routes>
            <Route path="/answer/:questionId" element={<AnswerPage />} />
          </Routes>
        </MemoryRouter>
      </ApiContext.Provider>,
    );

    await user.click(
      await screen.findByRole("button", { name: "Start recording" }),
    );
    await user.click(await screen.findByRole("button", { name: "Finish" }));

    const retry = await screen.findByRole("button", {
      name: "Retry finalization",
    });
    expect(screen.getByText(/1 chunk safely acknowledged/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Transcription provider unavailable",
    );

    await user.click(retry);

    expect(
      await screen.findByRole("button", { name: "Record another segment" }),
    ).toBeTruthy();
    expect(finalize).toHaveBeenCalledTimes(2);
  });
});

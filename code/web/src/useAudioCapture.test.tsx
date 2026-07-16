// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "./api.js";
import { useAudioCapture } from "./useAudioCapture.js";

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = () => true;

  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  readonly requestData = vi.fn();

  constructor() {
    FakeMediaRecorder.instances.push(this);
  }

  start() {
    this.state = "recording";
  }

  pause() {
    this.state = "paused";
  }

  resume() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.onstop?.(new Event("stop"));
  }
}

describe("useAudioCapture", () => {
  const stopTrack = vi.fn();
  const track = { stop: stopTrack, onended: null as (() => void) | null };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const api = {
    createAudioSession: vi.fn(async () => ({ id: "aud-1" })),
    uploadAudioChunk: vi.fn(async () => ({})),
    finalizeAudioSession: vi.fn(async () => ({ status: "ready" })),
  } as unknown as ApiClient;

  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    stopTrack.mockClear();
    track.onended = null;
    vi.mocked(api.createAudioSession).mockClear();
    vi.mocked(api.uploadAudioChunk).mockClear();
    vi.mocked(api.finalizeAudioSession).mockClear();
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

  it("flushes and releases an active microphone when the route unmounts", async () => {
    const capture = renderHook(() =>
      useAudioCapture({ api, questionId: "q-1", onTranscript: vi.fn() }),
    );
    await act(() => capture.result.current.start());
    const recorder = FakeMediaRecorder.instances[0]!;

    capture.unmount();

    expect(recorder.requestData).toHaveBeenCalledOnce();
    expect(recorder.state).toBe("inactive");
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("fails safely and releases the device when its audio track ends", async () => {
    const capture = renderHook(() =>
      useAudioCapture({ api, questionId: "q-1", onTranscript: vi.fn() }),
    );
    await act(() => capture.result.current.start());

    act(() => track.onended?.());

    await waitFor(() => expect(capture.result.current.state).toBe("failed"));
    expect(capture.result.current.error).toMatch(/microphone.*ended/i);
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("stops and releases the recorder after a browser recording error", async () => {
    const capture = renderHook(() =>
      useAudioCapture({ api, questionId: "q-1", onTranscript: vi.fn() }),
    );
    await act(() => capture.result.current.start());
    const recorder = FakeMediaRecorder.instances[0]!;

    act(() => recorder.onerror?.(new Event("error")));

    await waitFor(() => expect(capture.result.current.state).toBe("failed"));
    expect(recorder.state).toBe("inactive");
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("retries finalization after every audio chunk was uploaded", async () => {
    const onTranscript = vi.fn(async () => undefined);
    vi.mocked(api.finalizeAudioSession)
      .mockRejectedValueOnce(new Error("Transcription provider unavailable"))
      .mockResolvedValueOnce({
        status: "ready",
        transcript: "Recovered transcript",
      });
    const capture = renderHook(() =>
      useAudioCapture({ api, questionId: "q-1", onTranscript }),
    );
    await act(() => capture.result.current.start());
    const recorder = FakeMediaRecorder.instances[0]!;

    act(() =>
      recorder.ondataavailable?.({
        data: new Blob(["audio"]),
      } as BlobEvent),
    );
    await waitFor(() => expect(capture.result.current.uploadedChunks).toBe(1));
    expect(capture.result.current.pendingChunks).toBe(0);

    act(() => capture.result.current.stop());

    await waitFor(() => expect(capture.result.current.state).toBe("failed"));
    expect(capture.result.current.retryableOperation).toBe("finalization");

    await act(() => capture.result.current.retry());

    await waitFor(() => expect(capture.result.current.state).toBe("complete"));
    expect(api.finalizeAudioSession).toHaveBeenCalledTimes(2);
    expect(onTranscript).toHaveBeenCalledWith("Recovered transcript");
  });
});

import { useCallback, useEffect, useRef, useState } from "react";

import type { ApiClient } from "./api.js";
import type { RecorderState } from "./model.js";

interface PendingChunk {
  sequence: number;
  blob: Blob;
}

interface AudioCaptureOptions {
  api: ApiClient;
  questionId: string;
  onTranscript: (transcript: string) => Promise<void>;
}

export type RetryableAudioOperation = "upload" | "finalization";

export interface AudioCapture {
  state: RecorderState;
  error?: string;
  retryableOperation?: RetryableAudioOperation;
  elapsedSeconds: number;
  uploadedChunks: number;
  pendingChunks: number;
  start: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  retry: () => Promise<void>;
}

function chooseMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/ogg;codecs=opus",
    "audio/webm",
  ];
  return (
    candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ??
    ""
  );
}

export function useAudioCapture({
  api,
  questionId,
  onTranscript,
}: AudioCaptureOptions): AudioCapture {
  const [state, setState] = useState<RecorderState>("idle");
  const [error, setError] = useState<string>();
  const [retryableOperation, setRetryableOperation] =
    useState<RetryableAudioOperation>();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [uploadedChunks, setUploadedChunks] = useState(0);
  const [pendingChunks, setPendingChunks] = useState(0);
  const stateRef = useRef<RecorderState>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<string | null>(null);
  const queueRef = useRef<PendingChunk[]>([]);
  const sequenceRef = useRef(0);
  const drainingRef = useRef<Promise<boolean> | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const elapsedBeforePauseRef = useRef(0);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const transition = useCallback((next: RecorderState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const releaseMicrophone = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const failAndRelease = useCallback(
    (message: string) => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.requestData();
        } catch {
          // Some engines reject requestData after a device failure.
        }
        recorder.onstop = null;
        try {
          recorder.stop();
        } catch {
          // The device has already ended; releasing its tracks is sufficient.
        }
      }
      setError(message);
      transition("failed");
      releaseMicrophone();
    },
    [releaseMicrophone, transition],
  );

  const drain = useCallback(async (): Promise<boolean> => {
    if (drainingRef.current) return drainingRef.current;
    const operation = (async () => {
      while (queueRef.current.length) {
        const current = queueRef.current[0];
        const sessionId = sessionRef.current;
        if (!current || !sessionId) return false;
        try {
          await api.uploadAudioChunk(sessionId, current.sequence, current.blob);
          queueRef.current.shift();
          setUploadedChunks((value) => value + 1);
          setPendingChunks(queueRef.current.length);
        } catch (caught) {
          const recorder = recorderRef.current;
          if (recorder?.state === "recording") recorder.pause();
          setError(
            caught instanceof Error
              ? caught.message
              : "An audio chunk could not be saved.",
          );
          setRetryableOperation("upload");
          transition("failed");
          return false;
        }
      }
      return true;
    })();
    drainingRef.current = operation;
    try {
      return await operation;
    } finally {
      drainingRef.current = null;
    }
  }, [api, transition]);

  const finalize = useCallback(async () => {
    const uploaded = await drain();
    if (!uploaded) return;
    const sessionId = sessionRef.current;
    if (!sessionId) return;
    try {
      const result = await api.finalizeAudioSession(sessionId);
      if (result.transcript) await onTranscriptRef.current(result.transcript);
      transition("complete");
      setError(undefined);
      setRetryableOperation(undefined);
      releaseMicrophone();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The recording could not be finalized.",
      );
      setRetryableOperation("finalization");
      transition("failed");
    }
  }, [api, drain, releaseMicrophone, transition]);

  const start = useCallback(async () => {
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setError(
        "This browser does not expose MediaRecorder. Use typed dictation or a supported desktop browser.",
      );
      transition("failed");
      return;
    }
    transition("requesting");
    setError(undefined);
    setRetryableOperation(undefined);
    setElapsedSeconds(0);
    setUploadedChunks(0);
    setPendingChunks(0);
    queueRef.current = [];
    sequenceRef.current = 0;
    elapsedBeforePauseRef.current = 0;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const mimeType = chooseMimeType();
      const session = await api.createAudioSession(
        questionId,
        mimeType || "browser-default",
      );
      sessionRef.current = session.id;
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      recorderRef.current = recorder;
      stream.getTracks().forEach((track) => {
        track.onended = () =>
          failAndRelease(
            "The microphone track ended unexpectedly. Any acknowledged chunks remain saved.",
          );
      });
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        queueRef.current.push({
          sequence: sequenceRef.current++,
          blob: event.data,
        });
        setPendingChunks(queueRef.current.length);
        void drain();
      };
      recorder.onerror = () => {
        failAndRelease(
          "The browser reported a microphone recording error. Uploaded chunks remain on disk.",
        );
      };
      recorder.onstop = () => void finalize();
      recorder.start(1_000);
      startedAtRef.current = Date.now();
      transition("recording");
    } catch (caught) {
      releaseMicrophone();
      setError(
        caught instanceof DOMException && caught.name === "NotAllowedError"
          ? "Microphone access was denied. You can grant access in browser settings or use typed dictation."
          : caught instanceof Error
            ? caught.message
            : "The microphone could not be opened.",
      );
      transition("failed");
    }
  }, [
    api,
    drain,
    failAndRelease,
    finalize,
    questionId,
    releaseMicrophone,
    transition,
  ]);

  const pause = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state !== "recording") return;
    recorder.requestData();
    recorder.pause();
    if (startedAtRef.current)
      elapsedBeforePauseRef.current += Date.now() - startedAtRef.current;
    startedAtRef.current = null;
    transition("paused");
  }, [transition]);

  const resume = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state !== "paused" || queueRef.current.length) return;
    recorder.resume();
    startedAtRef.current = Date.now();
    setError(undefined);
    transition("recording");
  }, [transition]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    if (startedAtRef.current)
      elapsedBeforePauseRef.current += Date.now() - startedAtRef.current;
    startedAtRef.current = null;
    transition("finalising");
    recorder.stop();
  }, [transition]);

  const retry = useCallback(async () => {
    setError(undefined);
    setRetryableOperation(undefined);
    const uploaded = await drain();
    if (!uploaded) return;
    const recorder = recorderRef.current;
    if (recorder?.state === "paused") transition("paused");
    else if (recorder?.state === "inactive") {
      transition("finalising");
      await finalize();
    }
  }, [drain, finalize, transition]);

  useEffect(() => {
    if (state !== "recording") return;
    const timer = window.setInterval(() => {
      setElapsedSeconds(
        Math.floor(
          (elapsedBeforePauseRef.current +
            (startedAtRef.current ? Date.now() - startedAtRef.current : 0)) /
            1000,
        ),
      );
    }, 250);
    return () => window.clearInterval(timer);
  }, [state]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (
        ["recording", "paused", "finalising", "failed"].includes(
          stateRef.current,
        ) &&
        sessionRef.current
      )
        event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  useEffect(
    () => () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.requestData();
        } catch {
          // A stopped recorder has nothing left to flush.
        }
        try {
          recorder.stop();
        } catch {
          // Track release below is still required if stop races a device error.
        }
      }
      releaseMicrophone();
    },
    [releaseMicrophone],
  );

  return {
    state,
    ...(error ? { error } : {}),
    ...(retryableOperation ? { retryableOperation } : {}),
    elapsedSeconds,
    uploadedChunks,
    pendingChunks,
    start,
    pause,
    resume,
    stop,
    retry,
  };
}

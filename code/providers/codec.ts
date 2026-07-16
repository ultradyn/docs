import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import type {
  CodecProvider,
  CodecRequest,
  CodecResult,
  ProcessRunner,
  ProviderStatus,
} from "./contracts.js";
import { ExecaProcessRunner } from "./cli-delegates.js";

export class FfmpegCodecProvider implements CodecProvider {
  readonly id = "ffmpeg";
  readonly #runner: ProcessRunner;

  constructor(runner: ProcessRunner = new ExecaProcessRunner()) {
    this.#runner = runner;
  }

  async status(): Promise<ProviderStatus> {
    try {
      const result = await this.#runner.run("ffmpeg", ["-version"], {});
      return {
        id: this.id,
        kind: "codec",
        label: "FFmpeg audio codec",
        availability:
          result.exitCode === 0 ? "available" : "activation-required",
        consent: "not-applicable",
        streaming: "none",
        ...(result.exitCode === 0
          ? {}
          : { reason: "FFmpeg is not installed." }),
      };
    } catch {
      return {
        id: this.id,
        kind: "codec",
        label: "FFmpeg audio codec",
        availability: "activation-required",
        consent: "not-applicable",
        streaming: "none",
        reason: "FFmpeg is not installed.",
      };
    }
  }

  async transcode(request: CodecRequest): Promise<CodecResult> {
    const codec = request.format === "ogg" ? "libopus" : "libmp3lame";
    const result = await this.#runner.run(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-i",
        request.inputPath,
        "-vn",
        "-c:a",
        codec,
        request.outputPath,
      ],
      request.signal ? { signal: request.signal } : {},
    );
    if (result.exitCode !== 0)
      throw new Error(
        result.stderr || `FFmpeg exited with ${result.exitCode}.`,
      );
    const bytes = await readFile(request.outputPath);
    return {
      outputPath: request.outputPath,
      mimeType: request.format === "ogg" ? "audio/ogg" : "audio/mpeg",
      bytes: (await stat(request.outputPath)).size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
}

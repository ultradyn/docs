import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  LlmEvent,
  LlmProvider,
  LlmRequest,
  ProviderStatus,
} from "../providers/index.js";

/** Deterministic offline MCP provider backed by each agent's first golden fixture. */
export class FixtureAgentLlmProvider implements LlmProvider {
  readonly id = "fixture-agent-llm";
  readonly requests: LlmRequest[] = [];

  constructor(readonly definitionsRoot: string) {}

  async status(): Promise<ProviderStatus> {
    return {
      id: this.id,
      kind: "llm",
      label: "Agent golden-fixture provider",
      availability: "available",
      consent: "not-applicable",
      streaming: "none",
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
    this.requests.push(request);
    yield {
      type: "started",
      providerId: this.id,
      invocationId: request.invocationId,
    };
    const output = JSON.parse(
      await readFile(
        join(
          this.definitionsRoot,
          request.agent.name,
          "fixtures",
          "001-expected.json",
        ),
        "utf8",
      ),
    ) as unknown;
    const text = JSON.stringify(output);
    yield { type: "text-delta", delta: text };
    yield { type: "completed", output, text };
  }
}

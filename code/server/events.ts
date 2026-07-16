import { EventEmitter } from "node:events";
import { ulid } from "ulid";
import type { ServerEvent } from "../shared/index.js";

export class EventHub {
  readonly #emitter = new EventEmitter();

  publish(type: ServerEvent["type"], data: unknown): ServerEvent {
    const event: ServerEvent = {
      id: ulid(),
      type,
      at: new Date().toISOString(),
      data,
    };
    this.#emitter.emit("event", event);
    return event;
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.#emitter.on("event", listener);
    return () => this.#emitter.off("event", listener);
  }
}

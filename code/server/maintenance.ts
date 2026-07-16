export interface MaintenanceSchedulerOptions {
  intervalMs: number;
  run: () => Promise<unknown>;
  onError?: (error: unknown) => void;
}

export class MaintenanceScheduler {
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(private readonly options: MaintenanceSchedulerOptions) {}

  get active(): boolean {
    return this.#timer !== undefined;
  }

  start(): void {
    if (this.#timer) return;
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.options.run();
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.#running = false;
    }
  }
}

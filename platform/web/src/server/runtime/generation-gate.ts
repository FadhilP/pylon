export class GenerationGate {
  private current = 0;
  private pending?: number;
  private recovering = false;
  private state: "stopped" | "ready" | "replacing" | "unavailable" = "stopped";

  get generation(): number {
    return this.current;
  }
  get ready(): boolean {
    return this.state === "ready";
  }

  start(): number {
    if (this.current !== 0) throw new Error("generation gate already started");
    this.current = 1;
    this.state = "ready";
    return this.current;
  }

  beginReplacement(): number {
    if (!this.ready) throw new Error("runtime is not ready");
    this.pending = this.current + 1;
    this.recovering = false;
    this.state = "replacing";
    return this.pending;
  }

  beginRecovery(): number {
    if (this.state !== "unavailable") throw new Error("runtime is not unavailable");
    this.pending = this.current + 1;
    this.recovering = true;
    this.state = "replacing";
    return this.pending;
  }

  cancelReplacement(): void {
    if (this.state !== "replacing") return;
    this.pending = undefined;
    this.state = this.recovering ? "unavailable" : "ready";
    this.recovering = false;
  }

  invalidateCurrent(): number {
    if (this.state !== "replacing" || this.pending === undefined) throw new Error("replacement was not started");
    this.current = this.pending;
    this.state = "unavailable";
    return this.current;
  }

  commitReplacement(): number {
    if (this.pending === undefined) throw new Error("replacement was not started");
    this.current = this.pending;
    this.pending = undefined;
    this.recovering = false;
    this.state = "ready";
    return this.current;
  }

  failReplacement(): void {
    if (this.pending !== undefined && this.current < this.pending) this.current = this.pending;
    this.pending = undefined;
    this.recovering = false;
    this.state = "unavailable";
  }

  stop(): void {
    this.pending = undefined;
    this.recovering = false;
    this.state = "stopped";
  }

  accepts(capturedGeneration: number): boolean {
    return this.ready && capturedGeneration === this.current;
  }

  acceptsUi(capturedGeneration: number): boolean {
    return (this.state === "ready" || this.state === "replacing") && capturedGeneration === this.current;
  }

  assert(expectedGeneration: number): void {
    if (!this.ready) throw new Error("runtime is not ready");
    if (expectedGeneration !== this.current) {
      const error = new Error(`stale session generation: expected ${this.current}`);
      error.name = "StaleGenerationError";
      throw error;
    }
  }
}

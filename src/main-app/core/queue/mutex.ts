/**
 * Minimal Promise-based mutex — replaces async-mutex package.
 *
 * Used by QueueService to synchronize SQLite access during dequeue
 * (prevents two concurrent dispatchers from grabbing the same job).
 */
export class Mutex {
  private _locked = false;
  private readonly _queue: Array<() => void> = [];

  get locked(): boolean { return this._locked; }

  async acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    await new Promise<void>(resolve => this._queue.push(resolve));
  }

  release(): void {
    if (!this._locked) throw new Error('Mutex.release() called when not locked');
    const next = this._queue.shift();
    if (next) {
      // Transfer ownership to next waiter
      next();
    } else {
      this._locked = false;
    }
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

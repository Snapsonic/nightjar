/** Restart-backoff helpers shared by the recorder and motion detector. */

/**
 * ±50% random jitter: spreads restart herds (5 cams x 2 consumers hitting a
 * rate-limited upstream in lockstep never let the quota recover). Returns a
 * delay uniformly in [0.5x, 1.5x) of baseMs. `rand` is injectable for tests.
 */
export function jitterMs(baseMs: number, rand: () => number = Math.random): number {
  return Math.round(baseMs * (0.5 + rand()));
}

/**
 * Initial-spawn stagger: camera index * this many ms between first spawns.
 * Each Nest capture makes Google mint a new SDM stream, and that API is
 * rate-limited per minute per project — five cameras coming up together is
 * already most of the budget, so the first spawns are spread over ~a minute.
 */
export const SPAWN_STAGGER_MS = 12_000;

/**
 * Shared circuit breaker for upstream stream creation.
 *
 * The failure this exists to stop: Google 429s a burst of SDM stream requests,
 * every capture loop retries, the retries keep the per-minute quota saturated,
 * and nothing ever succeeds again — observed as 2+ hours with zero recording
 * while each loop dutifully "retried". Independent per-camera backoff cannot
 * fix that, because the resource being exhausted is shared.
 *
 * So failures are counted globally: once enough captures fail in a short
 * window, the breaker opens and every loop stops attempting for long enough
 * that the quota window actually drains. The first success closes it.
 */
export class StreamBreaker {
  private failures: number[] = [];
  private openUntilMs = 0;

  constructor(
    /** Failures within the window that trip the breaker. */
    private readonly threshold = 6,
    /** Sliding window for counting failures. */
    private readonly windowMs = 60_000,
    /** How long to stop attempting once tripped — longer than the quota window. */
    private readonly cooldownMs = 300_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds a caller must wait before its next attempt (0 = go ahead). */
  waitMs(): number {
    const remaining = this.openUntilMs - this.now();
    return remaining > 0 ? remaining : 0;
  }

  get isOpen(): boolean {
    return this.waitMs() > 0;
  }

  /** Record a capture failure; may trip the breaker. Returns true if it tripped. */
  recordFailure(): boolean {
    const t = this.now();
    this.failures = this.failures.filter((at) => t - at < this.windowMs);
    this.failures.push(t);
    if (this.failures.length >= this.threshold && !this.isOpen) {
      this.openUntilMs = t + this.cooldownMs;
      this.failures = [];
      return true;
    }
    return false;
  }

  /** A capture produced data — the upstream is healthy again. */
  recordSuccess(): void {
    this.failures = [];
    this.openUntilMs = 0;
  }
}

/**
 * Global pacing for upstream stream starts.
 *
 * Backoff and jitter are probabilistic: with ten capture loops sharing one
 * per-minute quota they still collide, and a collision costs minutes of lost
 * recording. This makes the pacing deterministic — every capture must take a
 * turn, and turns are spaced. One start at a time, `minGapMs` apart, for the
 * whole process.
 */
export class StreamStartGate {
  private nextAllowedAtMs = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly minGapMs = 8_000,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms).unref?.()),
  ) {}

  /** Resolves when the caller may start a capture. Serialized across callers. */
  acquire(): Promise<void> {
    const turn = this.chain.then(async () => {
      const wait = this.nextAllowedAtMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.nextAllowedAtMs = this.now() + this.minGapMs;
    });
    // Keep the chain alive even if a caller's turn rejects.
    this.chain = turn.catch(() => {});
    return turn;
  }
}

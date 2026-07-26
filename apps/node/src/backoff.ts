/** Restart-backoff helpers shared by the recorder and motion detector. */

/**
 * ±50% random jitter: spreads restart herds (5 cams x 2 consumers hitting a
 * rate-limited upstream in lockstep never let the quota recover). Returns a
 * delay uniformly in [0.5x, 1.5x) of baseMs. `rand` is injectable for tests.
 */
export function jitterMs(baseMs: number, rand: () => number = Math.random): number {
  return Math.round(baseMs * (0.5 + rand()));
}

/** Initial-spawn stagger: camera index * this many ms between first spawns. */
export const SPAWN_STAGGER_MS = 3_000;

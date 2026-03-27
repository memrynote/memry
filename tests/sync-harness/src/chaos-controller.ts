import { createSeededRng, getChaosSeed } from './seeded-rng.js'
import type { FetchFn } from './types.js'

/**
 * Phase 1: passthrough fetch wrapper with seed tracking.
 * Chaos controls (offline, drop, corrupt, reorder, duplicate)
 * added in Phase 2.
 */
export class ChaosController {
  private readonly seed: number
  private readonly rng: () => number

  constructor(config?: { seed?: number }) {
    this.seed = config?.seed ?? getChaosSeed()
    this.rng = createSeededRng(this.seed)
  }

  getSeed(): number {
    return this.seed
  }

  /**
   * Returns a fetch function that wraps the given base fetch,
   * injecting chaos as configured. Phase 1: no-op passthrough.
   */
  wrapFetch(baseFetch: FetchFn): FetchFn {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      return baseFetch(input, init)
    }
  }

  /**
   * Generate a random number using the seeded PRNG.
   * Useful for deterministic test decisions.
   */
  random(): number {
    return this.rng()
  }
}

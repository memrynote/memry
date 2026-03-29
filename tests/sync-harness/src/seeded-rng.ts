/**
 * Mulberry32 seeded PRNG — deterministic random number generator.
 * All chaos controls use this instead of Math.random() to ensure
 * test runs are reproducible via CHAOS_SEED env var.
 */
export function createSeededRng(seed: number): () => number {
  let state = seed | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function getChaosSeed(): number {
  const envSeed = process.env.CHAOS_SEED
  if (envSeed) {
    const parsed = parseInt(envSeed, 10)
    if (!isNaN(parsed)) return parsed
  }
  return 42
}

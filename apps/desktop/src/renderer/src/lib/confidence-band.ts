/**
 * Coarse confidence band for AI suggestions.
 *
 * Replaces a falsely-precise percentage with an honest strong/likely/weak
 * signal — embedding similarity isn't a calibrated probability, so a band is
 * more truthful than two digits (eng review D2).
 */
export type ConfidenceBand = 'strong' | 'likely' | 'weak'

const STRONG_MIN = 0.66
const LIKELY_MIN = 0.5

export function confidenceBand(score: number): ConfidenceBand {
  if (score >= STRONG_MIN) return 'strong'
  if (score >= LIKELY_MIN) return 'likely'
  return 'weak'
}

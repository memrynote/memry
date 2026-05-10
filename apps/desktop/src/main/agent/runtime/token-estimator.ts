export const COMPACTION_THRESHOLD = 100_000

export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0
  }

  return Math.ceil(text.length / 4)
}

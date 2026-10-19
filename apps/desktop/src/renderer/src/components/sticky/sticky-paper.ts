import type { StickyPaper } from '@memry/contracts/settings-schemas'

/**
 * Sticky paper tints. The card keeps its paper and dark ink in every app
 * theme, as a paper note would; interaction color stays the user's `--tint`.
 */
export const STICKY_PAPER: Record<StickyPaper, string> = {
  peach: '#FFE3D5',
  butter: '#FFF1B8',
  mint: '#D6F0E0',
  lavender: '#E9E3FC'
}

export const STICKY_INK = '#2A2622'

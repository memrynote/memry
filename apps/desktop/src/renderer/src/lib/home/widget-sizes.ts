import type { WidgetSize } from './types'

export const SIZE_SPANS: Record<WidgetSize, { cols: number; rows: number }> = {
  S: { cols: 1, rows: 1 },
  M: { cols: 2, rows: 2 },
  L: { cols: 4, rows: 2 }
}

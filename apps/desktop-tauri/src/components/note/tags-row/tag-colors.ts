export interface TagColorConfig {
  background: string
  text: string
}

export const TAG_COLORS: Record<string, TagColorConfig> = {
  // Row 1: Warm spectrum (red → yellow → green)
  rose: { background: '#E07888', text: '#E07888' },
  coral: { background: '#D8846C', text: '#D8846C' },
  tangerine: { background: '#CC9456', text: '#CC9456' },
  amber: { background: '#C4A44E', text: '#C4A44E' },
  lemon: { background: '#B8B44C', text: '#B8B44C' },
  sage: { background: '#7CB86C', text: '#7CB86C' },
  emerald: { background: '#50B888', text: '#50B888' },

  // Row 2: Cool spectrum (green → blue → purple)
  mint: { background: '#4CC0AC', text: '#4CC0AC' },
  teal: { background: '#4AB8BE', text: '#4AB8BE' },
  cyan: { background: '#52AACC', text: '#52AACC' },
  sky: { background: '#64A0D8', text: '#64A0D8' },
  cobalt: { background: '#748CE0', text: '#748CE0' },
  indigo: { background: '#8A7CD6', text: '#8A7CD6' },
  violet: { background: '#A470D0', text: '#A470D0' },

  // Row 3: Purple → Pink + Neutrals
  plum: { background: '#C06CB0', text: '#C06CB0' },
  magenta: { background: '#D46C96', text: '#D46C96' },
  slate: { background: '#8494A8', text: '#8494A8' },
  sand: { background: '#ADA088', text: '#ADA088' },
  stone: { background: '#949490', text: '#949490' },
  mauve: { background: '#A494AA', text: '#A494AA' }
}

export const COLOR_NAMES = Object.keys(TAG_COLORS)

export const COLOR_ROWS = [
  ['rose', 'coral', 'tangerine', 'amber', 'lemon', 'sage', 'emerald'],
  ['mint', 'teal', 'cyan', 'sky', 'cobalt', 'indigo', 'violet'],
  ['plum', 'magenta', 'slate', 'sand', 'stone', 'mauve']
]

export function getTagColors(colorName: string): TagColorConfig {
  return TAG_COLORS[colorName] || TAG_COLORS.stone
}

export { withAlpha } from '@/lib/color'

export function getRandomColor(): string {
  const index = Math.floor(Math.random() * COLOR_NAMES.length)
  return COLOR_NAMES[index]
}

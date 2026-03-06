export interface TagColorConfig {
  background: string
  text: string
}

export const TAG_COLORS: Record<string, TagColorConfig> = {
  // Row 1: Warm to Cool
  rose: { background: '#fecdd3', text: '#be123c' },
  pink: { background: '#fbcfe8', text: '#be185d' },
  fuchsia: { background: '#f5d0fe', text: '#a21caf' },
  purple: { background: '#e9d5ff', text: '#7c3aed' },
  violet: { background: '#ddd6fe', text: '#6d28d9' },
  indigo: { background: '#c7d2fe', text: '#4f46e5' },
  blue: { background: '#bfdbfe', text: '#2563eb' },
  sky: { background: '#bae6fd', text: '#0284c7' },

  // Row 2: Greens to Oranges
  cyan: { background: '#a5f3fc', text: '#0891b2' },
  teal: { background: '#99f6e4', text: '#0d9488' },
  emerald: { background: '#a7f3d0', text: '#059669' },
  green: { background: '#bbf7d0', text: '#16a34a' },
  lime: { background: '#d9f99d', text: '#65a30d' },
  yellow: { background: '#fef08a', text: '#ca8a04' },
  amber: { background: '#fde68a', text: '#d97706' },
  orange: { background: '#fed7aa', text: '#ea580c' },

  // Row 3: Neutrals & Accents
  stone: { background: '#e7e5e4', text: '#57534e' },
  slate: { background: '#e2e8f0', text: '#475569' },
  gray: { background: '#e5e7eb', text: '#4b5563' },
  zinc: { background: '#e4e4e7', text: '#52525b' },
  neutral: { background: '#f5f5f4', text: '#525252' },
  warm: { background: '#fef3c7', text: '#92400e' },
  red: { background: '#fecaca', text: '#dc2626' },
  coral: { background: '#fed7d7', text: '#e11d48' }
}

export const COLOR_NAMES = Object.keys(TAG_COLORS)

export const COLOR_ROWS = [
  ['rose', 'pink', 'fuchsia', 'purple', 'violet', 'indigo', 'blue', 'sky'],
  ['cyan', 'teal', 'emerald', 'green', 'lime', 'yellow', 'amber', 'orange'],
  ['stone', 'slate', 'gray', 'zinc', 'neutral', 'warm', 'red', 'coral']
]

export function getTagColors(colorName: string): TagColorConfig {
  return TAG_COLORS[colorName] || TAG_COLORS.stone
}

export function getRandomColor(): string {
  const index = Math.floor(Math.random() * COLOR_NAMES.length)
  return COLOR_NAMES[index]
}

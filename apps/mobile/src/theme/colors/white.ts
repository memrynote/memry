export const white = {
  canvas: {
    background: '#ffffff',
    surface: '#f7f6f3',
    surfaceActive: '#efedea',
    card: '#ffffff',
    popover: '#ffffff'
  },
  text: {
    primary: '#37352f',
    secondary: '#6b6966',
    tertiary: '#9b9a97'
  },
  line: {
    border: '#e3e2e0',
    input: '#e3e2e0',
    ring: '#9b9a97'
  },
  ui: {
    primary: '#37352f',
    primaryForeground: '#ffffff',
    secondary: '#f7f6f3',
    muted: '#f7f6f3',
    mutedForeground: '#6b6966',
    accent: '#f7f6f3',
    destructive: '#e03e3e',
    destructiveForeground: '#ffffff',
    // #e03e3e is 4.0:1 on white, borderline for small text. Fills keep it,
    // text darkens to clear AA.
    destructiveText: '#d63333'
  },
  tint: {
    base: '#6366f1',
    foreground: '#ffffff'
  },
  // Terracotta is the marketing mark, not an in-app accent. It is allowed on
  // brand surfaces only (splash, paywall); anything interactive uses tint.
  brand: {
    base: '#ff671a',
    foreground: '#ffffff'
  },
  dot: {
    cyan: '#0891b2',
    purple: '#7c3aed',
    green: '#16a34a',
    orange: '#ea580c'
  },
  pastel: {
    sage: '#dbeddb',
    rose: '#ffe2dd',
    sand: '#fdecc8',
    lavender: '#e8deee',
    grey: '#e3e2e0'
  }
} as const

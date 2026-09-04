export const white = {
  canvas: {
    // The one paper (#2033). The editor WebView paints `--memry-paper` edge to
    // edge under the RN chrome with no border between them, so any difference
    // here is a hard seam across the note screen. Pure white was that seam;
    // #fdfcfb is the warmer of the two and the one desktop's `--background`
    // leans toward. It also buys `card` and `popover` a real step of elevation
    // they did not have while the canvas was the same white they are.
    background: '#fdfcfb',
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
    // DESIGN.md's global product accent. #6366f1 was Figma drift, not a second
    // approved accent.
    base: '#f97316',
    foreground: '#ffffff',
    // The accent at fill strength is 2.8:1 on the canvas, so it cannot carry
    // text or a small glyph. The darker step of the same hue clears AA, the
    // same split ui.destructive / ui.destructiveText already makes.
    text: '#c2410c'
  },
  // Terracotta is the marketing mark, not an in-app accent. It is allowed on
  // brand surfaces only (splash, paywall); anything interactive uses tint.
  brand: {
    base: '#ff671a',
    foreground: '#ffffff'
  },
  dot: {
    blue: '#2563eb',
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

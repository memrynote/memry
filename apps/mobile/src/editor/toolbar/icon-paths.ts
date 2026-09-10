import type { TextAlignment } from '@memry/contracts/webview-bridge'

/**
 * The toolbar's stroked marks, as `d` attributes on a 24x24 viewBox.
 *
 * Ported verbatim from the DOM toolbar so the native row draws the same glyphs
 * the WebView drew; `glyph.tsx` supplies the stroke, width and caps.
 */
export const TOOLBAR_PATHS = {
  insertBlocks: ['M12 5v14', 'M5 12h14'],
  image: ['M4 5.5h16v13H4z', 'm5 16 4-4 3 3 2-2 5 4', 'M8.5 9h.01'],
  undo: ['M9 7 4 12l5 5', 'M5 12h7a7 7 0 0 1 7 7'],
  redo: ['m15 7 5 5-5 5', 'M19 12h-7a7 7 0 0 0-7 7'],
  hideKeyboard: ['M4 6h16v10H4z', 'm8 19 4 2 4-2', 'M8 10h.01m4 0h.01m4 0h.01'],
  dismissPicker: ['m7 9 5 5 5-5'],
  blockActions: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
  back: ['m15 18-6-6 6-6'],
  bulletedList: ['M9 6h11M9 12h11M9 18h11', 'M4 6h.01M4 12h.01M4 18h.01'],
  link: [
    'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7L12 5',
    'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19'
  ],
  inlineCode: ['m8 9-3 3 3 3', 'm16 9 3 3-3 3', 'm14 5-4 14'],
  style: [
    'M12 4a8 8 0 0 0 0 16 2 2 0 0 0 2-2 2 2 0 0 1 2-2h1a3 3 0 0 0 3-3 9 9 0 0 0-8-9Z',
    'M8 11h.01',
    'M11.5 8h.01',
    'M15 10h.01'
  ]
} as const satisfies Readonly<Record<string, readonly string[]>>

export const ALIGNMENT_LABELS: Readonly<Record<TextAlignment, string>> = {
  left: 'Align left',
  center: 'Align centre',
  right: 'Align right'
}

/** Bar lengths, not a character: no font has a left/right-aligned `≡`. */
export const ALIGNMENT_PATHS: Readonly<Record<TextAlignment, readonly string[]>> = {
  left: ['M4 7h16', 'M4 12h10', 'M4 17h14'],
  center: ['M4 7h16', 'M7 12h10', 'M5 17h14'],
  right: ['M4 7h16', 'M10 12h10', 'M6 17h14']
}

/** Arrows against the same stack of bars, so the header row reads as one set. */
export const INDENT_PATHS: Readonly<Record<'nest' | 'unnest', readonly string[]>> = {
  nest: ['M4 7h16', 'M10 12h10', 'M4 17h16', 'M4 10 6.5 12 4 14'],
  unnest: ['M4 7h16', 'M10 12h10', 'M4 17h16', 'M6.5 10 4 12 6.5 14']
}

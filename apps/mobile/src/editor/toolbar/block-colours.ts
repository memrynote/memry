import type { BlockColour } from '@memry/contracts/webview-bridge'

export interface BlockColourValues {
  /** `null` on `default`: the run keeps the theme's own ink. */
  text: string | null
  /** `null` on `default`: nothing is painted behind the run. */
  background: string | null
}

/**
 * `COLORS_DEFAULT` from `@blocknote/core`, mirrored.
 *
 * The RN app does not depend on BlockNote, but the guest and desktop both paint
 * from that table, so a run coloured on the phone shows the swatch desktop
 * shows for the same stored `textColor` / `backgroundColor` string. Re-read the
 * values out of the installed package if BlockNote is ever upgraded.
 */
export const BLOCK_COLOUR_VALUES: Readonly<Record<BlockColour, BlockColourValues>> = {
  default: { text: null, background: null },
  gray: { text: '#9b9a97', background: '#ebeced' },
  brown: { text: '#64473a', background: '#e9e5e3' },
  red: { text: '#e03e3e', background: '#fbe4e4' },
  orange: { text: '#d9730d', background: '#f6e9d9' },
  yellow: { text: '#dfab01', background: '#fbf3db' },
  green: { text: '#4d6461', background: '#ddedea' },
  blue: { text: '#0b6e99', background: '#ddebf1' },
  purple: { text: '#6940a5', background: '#eae4f2' },
  pink: { text: '#ad1a72', background: '#f4dfeb' }
}

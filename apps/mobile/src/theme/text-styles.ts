import { fontFamilies, type FontFamily } from '@/theme/fonts'

export interface TextVariantStyle {
  fontFamily: FontFamily
  fontSize: number
  lineHeight: number
  letterSpacing: number
}

// letterSpacing is negative on the display and heading sizes because Figma
// stores tracking as a percentage of font size and these are authored at -1%
// or -2%. The resolved px value is what React Native takes.
export const textStyles = {
  largeTitle: {
    fontFamily: fontFamilies.display,
    fontSize: 34,
    lineHeight: 40,
    letterSpacing: -0.68
  },
  title1: { fontFamily: fontFamilies.display, fontSize: 28, lineHeight: 34, letterSpacing: -0.56 },
  title2: {
    fontFamily: fontFamilies.sansSemiBold,
    fontSize: 22,
    lineHeight: 28,
    letterSpacing: -0.22
  },
  title3: {
    fontFamily: fontFamilies.sansSemiBold,
    fontSize: 20,
    lineHeight: 25,
    letterSpacing: -0.2
  },
  headline: {
    fontFamily: fontFamilies.sansSemiBold,
    fontSize: 17,
    lineHeight: 22,
    letterSpacing: -0.17
  },
  body: { fontFamily: fontFamilies.sans, fontSize: 17, lineHeight: 24, letterSpacing: 0 },
  bodyEmphasis: {
    fontFamily: fontFamilies.sansMedium,
    fontSize: 17,
    lineHeight: 24,
    letterSpacing: 0
  },
  callout: { fontFamily: fontFamilies.sans, fontSize: 16, lineHeight: 21, letterSpacing: 0 },
  subhead: { fontFamily: fontFamilies.sans, fontSize: 15, lineHeight: 20, letterSpacing: 0 },
  subheadEmphasis: {
    fontFamily: fontFamilies.sansSemiBold,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: 0
  },
  footnote: { fontFamily: fontFamilies.sans, fontSize: 13, lineHeight: 18, letterSpacing: 0 },
  caption: { fontFamily: fontFamilies.sans, fontSize: 12, lineHeight: 16, letterSpacing: 0 },
  captionEmphasis: {
    fontFamily: fontFamilies.sansSemiBold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.12
  },
  tabLabel: {
    fontFamily: fontFamilies.sansMedium,
    fontSize: 10,
    lineHeight: 13,
    letterSpacing: 0.1
  },
  serifBody: { fontFamily: fontFamilies.serif, fontSize: 18, lineHeight: 28, letterSpacing: 0 },
  // DESIGN.md maps note titles to the structural display role, not the
  // editorial serif.
  noteTitle: {
    fontFamily: fontFamilies.display,
    fontSize: 28,
    lineHeight: 28,
    letterSpacing: -0.56
  },
  mono: { fontFamily: fontFamilies.mono, fontSize: 13, lineHeight: 20, letterSpacing: 0 }
} as const satisfies Record<string, TextVariantStyle>

export type TextVariant = keyof typeof textStyles

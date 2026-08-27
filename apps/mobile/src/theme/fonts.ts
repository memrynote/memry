import { CrimsonPro_400Regular } from '@expo-google-fonts/crimson-pro/400Regular'
import { CrimsonPro_600SemiBold } from '@expo-google-fonts/crimson-pro/600SemiBold'
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular'
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium'
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold'
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular'
import { SpaceGrotesk_500Medium } from '@expo-google-fonts/space-grotesk/500Medium'

// React Native picks a weight by PostScript family name, not by fontWeight.
// Setting fontWeight next to one of these makes Android synthesize a face or
// fall back, so weight is a role here and never a style prop.
export const fontFamilies = {
  sans: 'Inter_400Regular',
  sansMedium: 'Inter_500Medium',
  sansSemiBold: 'Inter_600SemiBold',
  display: 'SpaceGrotesk_500Medium',
  serif: 'CrimsonPro_400Regular',
  serifSemiBold: 'CrimsonPro_600SemiBold',
  mono: 'JetBrainsMono_400Regular'
} as const

export type FontFamily = (typeof fontFamilies)[keyof typeof fontFamilies]

export const fontAssets = {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  SpaceGrotesk_500Medium,
  CrimsonPro_400Regular,
  CrimsonPro_600SemiBold,
  JetBrainsMono_400Regular
}

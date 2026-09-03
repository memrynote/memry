import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

import { AppText } from '@/components/ui/app-text'
import type { Color } from '@/theme/colors'
import { radius, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export type ChipVariant = 'tag' | 'active' | 'tint'

export interface ChipProps {
  label: string
  variant?: ChipVariant
  style?: StyleProp<ViewStyle>
}

interface ChipSurface {
  background: Color
  label: Color
}

export function Chip({ label, variant = 'tag', style }: ChipProps) {
  const c = useColors()
  const surfaces: Record<ChipVariant, ChipSurface> = {
    tag: { background: c.canvas.surface, label: c.text.secondary },
    active: { background: c.pastel.rose, label: c.text.primary },
    tint: { background: c.canvas.surface, label: c.tint.text }
  }
  const surface = surfaces[variant]

  return (
    <View style={[styles.container, { backgroundColor: surface.background }, style]}>
      <AppText variant="captionEmphasis" color={surface.label}>
        {label}
      </AppText>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    height: 26,
    borderRadius: radius.full,
    paddingHorizontal: space.s8,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center'
  }
})

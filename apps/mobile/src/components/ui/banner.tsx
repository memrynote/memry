import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

import { AppText } from '@/components/ui/app-text'
import { Icon, type IconName } from '@/components/ui/icon'
import type { Color } from '@/theme/colors'
import { radius, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export type BannerVariant = 'read-only' | 'offline' | 'update'

export interface BannerProps {
  variant: BannerVariant
  title: string
  body: string
  style?: StyleProp<ViewStyle>
}

interface BannerSurface {
  background: Color
  icon: IconName
}

export function Banner({ variant, title, body, style }: BannerProps) {
  const c = useColors()
  const surfaces: Record<BannerVariant, BannerSurface> = {
    'read-only': { background: c.pastel.sand, icon: 'lock' },
    offline: { background: c.canvas.surface, icon: 'offline' },
    update: { background: c.pastel.rose, icon: 'warning' }
  }
  const surface = surfaces[variant]

  return (
    <View
      accessibilityRole="alert"
      style={[styles.container, { backgroundColor: surface.background }, style]}
    >
      <Icon name={surface.icon} size={20} color={c.text.primary} />
      <View style={styles.text}>
        <AppText variant="subheadEmphasis" color={c.text.primary}>
          {title}
        </AppText>
        <AppText variant="footnote" color={c.text.secondary}>
          {body}
        </AppText>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    borderRadius: radius.lg,
    paddingVertical: space.s12,
    paddingHorizontal: space.s16,
    gap: space.s12,
    flexDirection: 'row',
    alignItems: 'flex-start'
  },
  text: { flex: 1, gap: space.s2 }
})

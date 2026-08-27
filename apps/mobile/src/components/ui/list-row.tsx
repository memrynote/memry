import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

import { AppText } from '@/components/ui/app-text'
import { Icon, type IconName } from '@/components/ui/icon'
import { sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export type ListRowVariant = 'plain' | 'note' | 'folder' | 'setting'

export interface ListRowProps {
  title: string
  subtitle?: string
  variant?: ListRowVariant
  onPress?: () => void
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}

interface ListRowShape {
  height: number
  icon?: IconName
}

export function ListRow({
  title,
  subtitle,
  variant = 'plain',
  onPress,
  accessibilityLabel,
  style
}: ListRowProps) {
  const c = useColors()
  const shapes: Record<ListRowVariant, ListRowShape> = {
    plain: { height: 52 },
    note: { height: 64, icon: 'note' },
    folder: { height: 64, icon: 'folder' },
    setting: { height: 52, icon: 'settings' }
  }
  const shape = shapes[variant]

  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : 'none'}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          height: shape.height,
          backgroundColor: c.canvas.background,
          borderBottomColor: c.line.border
        },
        onPress && pressed && styles.pressed,
        style
      ]}
    >
      {shape.icon ? <Icon name={shape.icon} size={20} color={c.text.tertiary} /> : null}
      <View style={styles.text}>
        <AppText variant="body" color={c.text.primary}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText variant="footnote" color={c.text.secondary}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      <Icon name="chevron-right" size={18} color={c.text.tertiary} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s12,
    paddingHorizontal: sizes.gutter,
    borderBottomWidth: 1
  },
  text: { flex: 1, gap: space.s2 },
  pressed: { transform: [{ scale: 0.97 }] }
})

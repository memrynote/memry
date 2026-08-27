import { StyleSheet, useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native'

import { AppText } from '@/components/ui/app-text'
import { Icon } from '@/components/ui/icon'
import { sizes } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export interface ToastProps {
  message: string
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}

export function Toast({ message, accessibilityLabel, style }: ToastProps) {
  const c = useColors()
  const { width } = useWindowDimensions()

  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.container,
        { backgroundColor: c.ui.primary, maxWidth: width - sizes.gutter * 2 },
        style
      ]}
    >
      <Icon name="check" size={18} color={c.ui.primaryForeground} />
      <AppText
        variant="subhead"
        color={c.ui.primaryForeground}
        numberOfLines={1}
        style={styles.message}
      >
        {message}
      </AppText>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    height: 44,
    borderRadius: 14,
    paddingHorizontal: 14,
    gap: 10,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    // Figma's fixed width 240 is a floor here, per the deviations section, because it truncates
    minWidth: 240,
    boxShadow: [{ offsetX: 0, offsetY: 4, blurRadius: 8, color: 'rgba(0, 0, 0, 0.14)' }]
  },
  message: { flexShrink: 1 }
})

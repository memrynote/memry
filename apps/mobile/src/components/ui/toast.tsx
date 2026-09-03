import {
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle
} from 'react-native'

import { AppText } from '@/components/ui/app-text'
import { Icon, type IconName } from '@/components/ui/icon'
import { fontFamilies } from '@/theme/fonts'
import { sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export interface ToastAction {
  label: string
  onPress: () => void
}

export interface ToastProps {
  message: string
  /**
   * The trailing verb (boards 26F / 26I / 26M): `Undo`, `Open`, `View`.
   *
   * Reserved for work this device can genuinely take back or take you to. A
   * delete does NOT get one — undoing a tombstone that has already been pushed
   * means resurrecting an id the peers have retired, and an `Undo` that
   * sometimes silently fails is worse than no `Undo`.
   */
  action?: ToastAction
  /** `null` drops the leading glyph, which is what a toast with an action draws. */
  icon?: IconName | null
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}

export function Toast({ message, action, icon = 'check', accessibilityLabel, style }: ToastProps) {
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
      {icon === null ? null : <Icon name={icon} size={18} color={c.ui.primaryForeground} />}
      <AppText
        variant="subhead"
        color={c.ui.primaryForeground}
        numberOfLines={1}
        style={styles.message}
      >
        {message}
      </AppText>
      {action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action.label}
          hitSlop={10}
          onPress={action.onPress}
        >
          {/* The one place the marketing terracotta is allowed inside the app:
              it sits on the dark pill, never on a canvas surface, and it is the
              single interactive element in a component that is otherwise mute. */}
          <AppText variant="subhead" color={c.brand.base} style={styles.action}>
            {action.label}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    height: 48,
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
  message: { flexShrink: 1, flexGrow: 1 },
  action: { fontFamily: fontFamilies.sansSemiBold, marginStart: space.s4 }
})

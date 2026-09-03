import { useRef, type ReactNode } from 'react'
import { Pressable, StyleSheet, View, type AccessibilityActionEvent } from 'react-native'
import ReanimatedSwipeable, {
  type SwipeableMethods
} from 'react-native-gesture-handler/ReanimatedSwipeable'
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated'

import { AppText } from '@/components/ui/app-text'
import { Icon, type IconName } from '@/components/ui/icon'
import type { Color } from '@/theme/colors'
import { fontFamilies } from '@/theme/fonts'
import { space } from '@/theme/primitives'

/**
 * A row with trailing swipe actions.
 *
 * `actions` is a table the caller supplies: label, glyph, width and both
 * colours are values, so nothing here branches on which action it is drawing.
 * A destructive action is a row with a destructive background, not a variant.
 */

export interface SwipeAction {
  label: string
  icon: IconName
  width: number
  background: Color
  foreground: Color
  onPress: () => void
}

export interface SwipeRowProps {
  actions: SwipeAction[]
  children: ReactNode
}

function SwipeActions({
  actions,
  translation,
  total,
  onAction
}: {
  actions: SwipeAction[]
  translation: SharedValue<number>
  total: number
  onAction: (action: SwipeAction) => void
}) {
  // `translation` is the row's own horizontal offset: 0 closed, -total fully
  // open. Adding `total` parks the strip exactly off the trailing edge at rest
  // and slides it flush as the row travels.
  const slide = useAnimatedStyle(() => ({
    transform: [{ translateX: translation.value + total }]
  }))

  return (
    <Animated.View style={[styles.actions, slide]}>
      {actions.map((action) => (
        <Pressable
          key={action.label}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={() => onAction(action)}
          style={[styles.action, { width: action.width, backgroundColor: action.background }]}
        >
          <Icon name={action.icon} size={16} color={action.foreground} />
          <AppText variant="caption" color={action.foreground} style={styles.actionLabel}>
            {action.label}
          </AppText>
        </Pressable>
      ))}
    </Animated.View>
  )
}

export function SwipeRow({ actions, children }: SwipeRowProps) {
  const swipeable = useRef<SwipeableMethods>(null)
  const total = actions.reduce((sum, action) => sum + action.width, 0)

  const fire = (action: SwipeAction) => {
    // Close first, or the row stays open behind the dialog the action opens
    // and is still open when that dialog is dismissed.
    swipeable.current?.close()
    action.onPress()
  }

  const runAccessibilityAction = (event: AccessibilityActionEvent) => {
    const action = actions.find((candidate) => candidate.label === event.nativeEvent.actionName)
    if (action) fire(action)
  }

  return (
    // The custom actions hang off THIS view rather than the buttons. iOS
    // surfaces accessibilityCustomActions only on the focused accessibility
    // element, and the library holds the action strip at opacity 0 while the
    // row is closed, which UIKit drops from the accessibility tree entirely.
    <View
      accessible
      accessibilityActions={actions.map((action) => ({ name: action.label, label: action.label }))}
      onAccessibilityAction={runAccessibilityAction}
    >
      {/* `renderRightActions` is a physical-side API with no logical variant.
          That is a gesture-handler limit, not a choice made here. */}
      <ReanimatedSwipeable
        ref={swipeable}
        overshootRight={false}
        renderRightActions={(_progress, translation) => (
          <SwipeActions actions={actions} translation={translation} total={total} onAction={fire} />
        )}
      >
        {children}
      </ReanimatedSwipeable>
    </View>
  )
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row' },
  // Board 27 sets the glyph beside the label, not above it: at 72pt the row
  // fits, and stacking makes the strip read as a tile rather than a button.
  action: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.s6 },
  actionLabel: { fontFamily: fontFamilies.sansMedium }
})

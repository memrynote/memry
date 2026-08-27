import type { ReactNode } from 'react'
import { Modal, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

import { SheetHandle } from '@/components/ui/sheet-handle'
import { radius } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export interface BottomSheetProps {
  visible: boolean
  onClose: () => void
  children: ReactNode
  accessibilityLabel?: string
  closeAccessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}

export function BottomSheet({
  visible,
  onClose,
  children,
  accessibilityLabel,
  closeAccessibilityLabel = 'Close',
  style
}: BottomSheetProps) {
  const c = useColors()

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={closeAccessibilityLabel}
          onPress={onClose}
          style={[StyleSheet.absoluteFill, styles.scrim, { backgroundColor: c.text.primary }]}
        />
        <View
          accessibilityViewIsModal
          accessibilityLabel={accessibilityLabel}
          style={[styles.sheet, { backgroundColor: c.canvas.popover }, style]}
        >
          <SheetHandle />
          {children}
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  // The theme has no scrim token, so the scrim is the palette's ink at 40 percent
  scrim: { opacity: 0.4 },
  sheet: {
    borderTopStartRadius: radius.xl,
    borderTopEndRadius: radius.xl
  }
})

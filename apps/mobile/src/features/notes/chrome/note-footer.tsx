import type { ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '@/components/ui/app-text'
import { Icon } from '@/components/ui/icon'
import { radius, sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export interface NoteFooterProps {
  tabCount: number
  onFind: () => void
  onQuickOpen: () => void
  onTabs: () => void
  onMore: () => void
}

/** The keyboard-hidden note chrome from Paper board 29D. */
export function NoteFooter({ tabCount, onFind, onQuickOpen, onTabs, onMore }: NoteFooterProps) {
  const c = useColors()
  const insets = useSafeAreaInsets()

  return (
    <View
      accessibilityRole="toolbar"
      accessibilityLabel="Note tools"
      style={[
        styles.root,
        {
          height: sizes.row + insets.bottom,
          paddingBottom: space.s6 + insets.bottom,
          backgroundColor: c.canvas.background,
          borderTopColor: c.line.border
        }
      ]}
    >
      <FooterButton label="Find in note" onPress={onFind}>
        <Icon name="search" size={22} color={c.text.primary} strokeWidth={1.8} />
      </FooterButton>
      <FooterButton label="Find or create a note" onPress={onQuickOpen}>
        <Icon name="plus" size={23} color={c.text.primary} strokeWidth={1.8} />
      </FooterButton>
      <FooterButton
        label={`${tabCount} background ${tabCount === 1 ? 'tab' : 'tabs'}`}
        onPress={onTabs}
      >
        <View style={[styles.tabCount, { borderColor: c.text.primary }]}>
          <AppText variant="captionEmphasis" color={c.text.primary}>
            {tabCount}
          </AppText>
        </View>
      </FooterButton>
      <FooterButton label="More note actions" onPress={onMore}>
        <View style={styles.hamburger} accessibilityElementsHidden>
          <View style={[styles.hamburgerLine, { backgroundColor: c.text.primary }]} />
          <View style={[styles.hamburgerLine, { backgroundColor: c.text.primary }]} />
          <View style={[styles.hamburgerLine, { backgroundColor: c.text.primary }]} />
        </View>
      </FooterButton>
    </View>
  )
}

function FooterButton({
  label,
  onPress,
  children
}: {
  label: string
  onPress: () => void
  children: ReactNode
}) {
  const c = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        pressed && { backgroundColor: c.canvas.surfaceActive }
      ]}
    >
      {children}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: {
    height: sizes.row,
    flexDirection: 'row',
    alignItems: 'center',
    paddingStart: space.s12,
    paddingEnd: space.s12,
    paddingVertical: space.s6,
    borderTopWidth: StyleSheet.hairlineWidth
  },
  button: {
    flex: 1,
    height: sizes.tapTarget,
    minWidth: sizes.tapTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg
  },
  tabCount: {
    width: 23,
    height: 23,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.8,
    borderRadius: radius.sm
  },
  hamburger: {
    width: 23,
    height: 23,
    justifyContent: 'center',
    gap: space.s4,
    paddingStart: space.s4,
    paddingEnd: space.s4
  },
  hamburgerLine: { height: 1.8, borderRadius: radius.full }
})

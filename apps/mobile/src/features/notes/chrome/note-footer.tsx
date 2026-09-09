import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect'
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'

import { AppText } from '@/components/ui/app-text'
import { Icon } from '@/components/ui/icon'
import { useFloatingBarOffset } from '@/components/ui/tab-bar'
import { radius, sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

// Compile-time capability, so it cannot flip while the app runs. The package
// ships a non-iOS build that returns false and renders GlassView as a plain View.
const liquidGlass = isLiquidGlassAvailable()

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
  const bottom = useFloatingBarOffset()

  return (
    <View
      accessibilityRole="toolbar"
      accessibilityLabel="Note tools"
      style={[styles.root, { bottom }]}
    >
      {liquidGlass ? (
        <GlassView style={styles.surface} glassEffectStyle="regular" />
      ) : (
        <View
          style={[
            styles.surface,
            { backgroundColor: c.canvas.card, borderWidth: 1, borderColor: c.line.border }
          ]}
        />
      )}
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
      style={styles.button}
    >
      {({ pressed }) => (
        // Glass rather than a fill so the note keeps refracting through the
        // pressed key; `clear` is the thinner of the two materials, which is
        // what separates it from the bar behind it.
        <>
          {pressed ? (
            liquidGlass ? (
              <GlassView style={styles.pressed} glassEffectStyle="clear" />
            ) : (
              <View style={[styles.pressed, { backgroundColor: c.canvas.surfaceActive }]} />
            )
          ) : null}
          {children}
        </>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    start: sizes.gutter,
    end: sizes.gutter,
    height: sizes.row,
    flexDirection: 'row',
    alignItems: 'center',
    paddingStart: space.s6,
    paddingEnd: space.s6,
    paddingVertical: space.s6,
    borderRadius: radius.full
  },
  // Liquid Glass takes the corner radius on the effect view itself rather than
  // from a clipping parent, so the fallback fill carries the same shape.
  surface: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    start: 0,
    end: 0,
    borderRadius: radius.full
  },
  button: {
    flex: 1,
    height: sizes.tapTarget,
    minWidth: sizes.tapTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full
  },
  pressed: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    start: 0,
    end: 0,
    borderRadius: radius.full
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

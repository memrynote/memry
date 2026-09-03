import { useState } from 'react'
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native'

import { AppText } from '@/components/ui/app-text'
import { Icon, type IconName } from '@/components/ui/icon'
import { sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

// Measured off the Figma icon row. 18 is not on the space scale, so it stays a
// local constant rather than growing the scale for one component.
const ACTION_GAP = 18

interface NavBarActionBase {
  /** The accessible name, and the row's React key. */
  label: string
  onPress: () => void
}

export interface NavBarIconAction extends NavBarActionBase {
  icon: IconName
}

/**
 * A word action (`Edit`, `Done`), drawn in tint beside the glyphs.
 *
 * It lives here rather than at the call site because a bar's trailing group
 * has to be MEASURED for the title centring below, and a Pressable smuggled in
 * next to `NavBarInline` would centre the title against a zero-width group.
 * Icon or word is the only thing that varies, so it is a variant of the action
 * rather than a second component.
 */
export interface NavBarTextAction extends NavBarActionBase {
  text: string
}

export type NavBarAction = NavBarIconAction | NavBarTextAction

export interface NavBarLargeTitleProps {
  title: string
  actions?: NavBarAction[]
}

export interface NavBarInlineProps {
  title: string
  back?: { label: string; onPress: () => void; showLabel?: boolean }
  actions?: NavBarAction[]
}

interface ActionRowProps {
  actions: NavBarAction[]
  onLayout?: (event: LayoutChangeEvent) => void
}

function ActionRow({ actions, onLayout }: ActionRowProps) {
  const c = useColors()
  return (
    <View style={styles.actionRow} onLayout={onLayout}>
      {actions.map((action) => (
        <Pressable
          key={action.label}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          hitSlop={10}
          onPress={action.onPress}
          style={({ pressed }) => pressed && styles.pressed}
        >
          {'text' in action ? (
            <AppText variant="headline" color={c.tint.base}>
              {action.text}
            </AppText>
          ) : (
            <Icon name={action.icon} size={24} color={c.text.primary} />
          )}
        </Pressable>
      ))}
    </View>
  )
}

export function NavBarLargeTitle({ title, actions = [] }: NavBarLargeTitleProps) {
  const c = useColors()
  return (
    <View style={[styles.largeRoot, { backgroundColor: c.canvas.background }]}>
      <View style={styles.largeRow}>
        <AppText
          variant="largeTitle"
          color={c.text.primary}
          numberOfLines={1}
          style={styles.largeTitle}
        >
          {title}
        </AppText>
        <ActionRow actions={actions} />
      </View>
    </View>
  )
}

export function NavBarInline({ title, back, actions = [] }: NavBarInlineProps) {
  const c = useColors()
  const [leadingWidth, setLeadingWidth] = useState(0)
  const [trailingWidth, setTrailingWidth] = useState(0)

  // iOS centres the title on the bar, not between the two groups. A symmetric
  // inset off the wider group keeps it centred, and the trailing gap is what a
  // long title truncates against so it never sits flush with the back label.
  const inset = Math.max(space.s8 + leadingWidth, sizes.gutter + trailingWidth) + space.s8

  return (
    <View style={[styles.inlineRoot, { backgroundColor: c.canvas.background }]}>
      {back ? (
        <Pressable
          // The accessible NAME is `Back to <folder>` and moves with the
          // destination, so it cannot be a selector. `testID` is what becomes
          // an accessibility identifier on iOS, and the offline matrix leaves
          // the note screen through this control on every pass.
          testID="nav-back"
          accessibilityRole="button"
          accessibilityLabel={`Back to ${back.label}`}
          hitSlop={{ top: 10, bottom: 10 }}
          onPress={back.onPress}
          onLayout={(e) => setLeadingWidth(e.nativeEvent.layout.width)}
          style={({ pressed }) => [styles.backGroup, pressed && styles.pressed]}
        >
          <Icon name="chevron-left" size={24} color={c.tint.base} />
          {/* The label can be hidden, the accessible name above cannot: a bare
              chevron with no name is unusable. */}
          {back.showLabel === false ? null : (
            <AppText variant="body" color={c.tint.base}>
              {back.label}
            </AppText>
          )}
        </Pressable>
      ) : (
        <View />
      )}

      <View
        pointerEvents="none"
        style={[styles.titleLayer, { paddingStart: inset, paddingEnd: inset }]}
      >
        <AppText variant="headline" color={c.text.primary} numberOfLines={1}>
          {title}
        </AppText>
      </View>

      <ActionRow actions={actions} onLayout={(e) => setTrailingWidth(e.nativeEvent.layout.width)} />
    </View>
  )
}

const styles = StyleSheet.create({
  largeRoot: {
    height: sizes.navBarLarge,
    justifyContent: 'flex-end',
    paddingBottom: space.s8,
    paddingHorizontal: sizes.gutter
  },
  largeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  largeTitle: { flexShrink: 1 },
  inlineRoot: {
    height: sizes.navBar,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingStart: space.s8,
    paddingEnd: sizes.gutter
  },
  backGroup: { flexDirection: 'row', alignItems: 'center', gap: space.s2 },
  titleLayer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    start: 0,
    end: 0,
    alignItems: 'center',
    justifyContent: 'center'
  },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: ACTION_GAP },
  pressed: { transform: [{ scale: 0.97 }] }
})

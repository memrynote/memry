import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect'
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '@/components/ui/app-text'
import { Icon, type IconName } from '@/components/ui/icon'
import { radius, sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export interface TabBarItem {
  key: string
  label: string
  icon: IconName
  focused: boolean
  onPress: () => void
  onLongPress: () => void
}

export interface TabBarProps {
  items: TabBarItem[]
  // A node rather than a colour so a caller can swap the surface behind the row.
  background?: ReactNode
}

// Compile-time capability, so it cannot flip while the app runs. The package
// ships a non-iOS build that returns false and renders GlassView as a plain View.
const liquidGlass = isLiquidGlassAvailable()

// A floating capsule clears the home indicator; on a device without one it
// still needs a gap of its own. Shared with the note screen's footer so the two
// bars sit at the same height.
export function useFloatingBarOffset() {
  const insets = useSafeAreaInsets()
  return Math.max(insets.bottom, space.s12)
}

// The bar floats over the tab screens so their content can pass under the
// glass; every tab screen pads its content by this much to stay clear of it.
export function useTabBarHeight() {
  return useFloatingBarOffset() + sizes.tabBar + space.s8
}

export function TabBar({ items, background }: TabBarProps) {
  const c = useColors()

  return (
    <View style={styles.bar}>
      {background ??
        (liquidGlass ? (
          <GlassView style={styles.surface} glassEffectStyle="regular" />
        ) : (
          <View
            style={[
              styles.surface,
              { backgroundColor: c.canvas.card, borderWidth: 1, borderColor: c.line.border }
            ]}
          />
        ))}
      <View style={styles.row}>
        {items.map((item) => (
          <Pressable
            key={item.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: item.focused }}
            accessibilityLabel={item.label}
            onPress={item.onPress}
            onLongPress={item.onLongPress}
            style={styles.item}
          >
            {item.focused ? (
              // Glass rather than a fill so the list keeps refracting through
              // the selected tab as it scrolls; `clear` is the thinner of the
              // two materials, which is what separates it from the bar behind.
              liquidGlass ? (
                <GlassView style={styles.pill} glassEffectStyle="clear" />
              ) : (
                <View style={[styles.pill, { backgroundColor: c.canvas.surfaceActive }]} />
              )
            ) : null}
            <Icon name={item.icon} size={24} color={item.focused ? c.tint.text : c.text.tertiary} />
            <AppText variant="tabLabel" color={item.focused ? c.tint.text : c.text.secondary}>
              {item.label}
            </AppText>
          </Pressable>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { borderRadius: radius.full },
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
  row: { height: sizes.tabBar, flexDirection: 'row', paddingHorizontal: space.s4 },
  // 24 icon, 4 gap and a 13 tall label fill the 41 left after the pill's inset.
  pill: { position: 'absolute', top: 0, bottom: 0, start: 0, end: 0, borderRadius: radius.full },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.s4,
    marginVertical: space.s4,
    borderRadius: radius.full
  }
})

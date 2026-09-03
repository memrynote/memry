import type { ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '@/components/ui/app-text'
import { Icon, type IconName } from '@/components/ui/icon'
import { sizes, space } from '@/theme/primitives'
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
  // A node rather than a colour so translucency can land later by passing a
  // blur surface. expo-blur is not a dependency yet.
  background?: ReactNode
}

export function TabBar({ items, background }: TabBarProps) {
  const c = useColors()
  const insets = useSafeAreaInsets()

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom, borderTopColor: c.line.border }]}>
      {background ?? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: c.canvas.background }]} />
      )}
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
  root: { borderTopWidth: 1 },
  // 8 top padding, 24 icon, 4 gap and a 13 tall label add up to the 49 strip.
  row: { height: sizes.tabBar, flexDirection: 'row', paddingTop: space.s8 },
  item: { flex: 1, alignItems: 'center', gap: space.s4 }
})

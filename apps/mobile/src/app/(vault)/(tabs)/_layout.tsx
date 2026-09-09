import { Tabs } from 'expo-router'
import { StyleSheet, View } from 'react-native'

import type { IconName } from '@/components/ui/icon'
import { TabBar, useFloatingBarOffset, type TabBarItem } from '@/components/ui/tab-bar'
import { sizes } from '@/theme/primitives'

const TABS = [
  { name: 'home', label: 'Home', icon: 'home' },
  { name: 'notes', label: 'Notes', icon: 'note' },
  { name: 'tasks', label: 'Tasks', icon: 'task' },
  { name: 'journal', label: 'Journal', icon: 'journal' },
  { name: 'more', label: 'More', icon: 'more' }
] as const satisfies readonly { name: string; label: string; icon: IconName }[]

// A component rather than JSX inside the `tabBar` render prop: that prop is
// called as a plain function, so a hook in it would not be a hook of its own.
function FloatingTabBar({ items }: { items: TabBarItem[] }) {
  const bottom = useFloatingBarOffset()
  return (
    <View style={[styles.floating, { bottom }]}>
      <TabBar items={items} />
    </View>
  )
}

export default function TabsLayout() {
  return (
    <Tabs
      initialRouteName="notes"
      screenOptions={{ headerShown: false }}
      tabBar={({ state, navigation }) => {
        const active = state.routes[state.index]
        // A screen pushed inside a tab, the note editor, owns the full height.
        if ((active.state?.index ?? 0) > 0) return null

        const items = state.routes.flatMap<TabBarItem>((route, index) => {
          const meta = TABS.find((tab) => tab.name === route.name)
          if (!meta) return []
          return [
            {
              key: route.key,
              label: meta.label,
              icon: meta.icon,
              focused: state.index === index,
              onPress: () => {
                const event = navigation.emit({
                  type: 'tabPress',
                  target: route.key,
                  canPreventDefault: true
                })
                if (state.index !== index && !event.defaultPrevented) {
                  navigation.navigate(route.name)
                }
              },
              onLongPress: () => {
                navigation.emit({ type: 'tabLongPress', target: route.key })
              }
            }
          ]
        })

        // Absolute so the screens keep the full height and their content
        // scrolls under the glass instead of stopping above it.
        return <FloatingTabBar items={items} />
      }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen key={tab.name} name={tab.name} />
      ))}
    </Tabs>
  )
}

const styles = StyleSheet.create({
  floating: { position: 'absolute', start: sizes.gutter, end: sizes.gutter }
})

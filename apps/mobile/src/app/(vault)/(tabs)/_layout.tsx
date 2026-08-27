import { Tabs } from 'expo-router'

import type { IconName } from '@/components/ui/icon'
import { TabBar, type TabBarItem } from '@/components/ui/tab-bar'

const TABS = [
  { name: 'home', label: 'Home', icon: 'home' },
  { name: 'notes', label: 'Notes', icon: 'note' },
  { name: 'tasks', label: 'Tasks', icon: 'task' },
  { name: 'journal', label: 'Journal', icon: 'journal' },
  { name: 'more', label: 'More', icon: 'more' }
] as const satisfies readonly { name: string; label: string; icon: IconName }[]

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

        return <TabBar items={items} />
      }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen key={tab.name} name={tab.name} />
      ))}
    </Tabs>
  )
}

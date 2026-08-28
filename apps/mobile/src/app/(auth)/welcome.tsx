import { StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'

import { AppText } from '@/components/ui/app-text'
import { Button } from '@/components/ui/button'
import { Icon, type IconName } from '@/components/ui/icon'
import { space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

// Auth screens inset 24 rather than the 16 gutter the vault shell uses.
const GUTTER = 24
// Icon slot is wider than the 22px glyph so the three titles share one lane.
const ICON_SLOT = 28

const promises: { icon: IconName; title: string; detail: string }[] = [
  {
    icon: 'shield',
    title: 'End-to-end encrypted',
    detail: 'Your keys never leave your devices.'
  },
  {
    icon: 'offline',
    title: 'Works offline',
    detail: 'Write on a plane. It syncs when you land.'
  },
  {
    icon: 'note',
    title: 'The same vault as desktop',
    detail: 'Notes, tasks, journal, calendar — all of it.'
  }
]

function PromiseRow({ icon, title, detail }: (typeof promises)[number]) {
  const c = useColors()
  return (
    <View style={styles.promise}>
      <View style={styles.iconSlot}>
        <Icon name={icon} size={22} color={c.text.primary} />
      </View>
      <View style={styles.promiseText}>
        <AppText variant="headline">{title}</AppText>
        <AppText variant="subhead" color={c.text.secondary}>
          {detail}
        </AppText>
      </View>
    </View>
  )
}

/** Welcome (Paper `02 · Auth — Welcome`), the first screen without a session. */
export default function WelcomeScreen() {
  const c = useColors()

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.canvas.background }]}>
      <View style={styles.body}>
        <AppText variant="largeTitle">{'Your vault,\nin your pocket.'}</AppText>
        <AppText variant="body" color={c.text.secondary} style={styles.lede}>
          Everything you write stays encrypted on your devices. We can’t read it, and neither can
          anyone who takes our servers.
        </AppText>
        <View style={styles.promises}>
          {promises.map((promise) => (
            <PromiseRow key={promise.title} {...promise} />
          ))}
        </View>
      </View>

      <View style={styles.footer}>
        <Button label="Sign in" onPress={() => router.push('/sign-in')} />
        <AppText variant="footnote" color={c.text.secondary} style={styles.footnote}>
          New to Memry? Create your vault on the desktop app first — that’s where your recovery
          phrase is generated.
        </AppText>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  body: { flex: 1, paddingHorizontal: GUTTER, paddingTop: space.s48 },
  lede: { paddingTop: space.s12 },
  promises: { paddingTop: space.s40, gap: space.s20 },
  promise: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  iconSlot: { width: ICON_SLOT, flexShrink: 0, paddingTop: 1 },
  promiseText: { flex: 1, gap: space.s2 },
  footer: { paddingHorizontal: GUTTER, paddingBottom: space.s8, gap: space.s8 },
  footnote: { textAlign: 'center', paddingHorizontal: space.s8 }
})

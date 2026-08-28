import { StyleSheet, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '@/components/ui/app-text'
import { space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

// One step above largeTitle and used only here, so it stays a local override
// rather than growing the shared type scale for a single surface.
const wordmark = { fontSize: 40, lineHeight: 48, letterSpacing: -1.2 }

/** The wordmark alone, for the overlay that covers the native-to-JS handoff. */
export function BrandWordmark() {
  const c = useColors()
  return (
    <AppText variant="largeTitle" color={c.brand.foreground} style={wordmark}>
      Memry
    </AppText>
  )
}

export interface BrandSplashProps {
  status?: string
}

/**
 * Brand splash (Paper `01 · Auth — Splash`). Also what the native splash hands
 * off to, so the two must stay the same colour or the launch flashes.
 */
export function BrandSplash({ status }: BrandSplashProps) {
  const c = useColors()
  const insets = useSafeAreaInsets()

  return (
    <View style={[styles.root, { backgroundColor: c.brand.base }]}>
      <StatusBar style="light" />
      <View style={styles.center}>
        <BrandWordmark />
      </View>
      {status ? (
        // The board floats the home indicator 24px off the bottom edge; on a
        // device it is flush, so the status line rides the real inset instead.
        <AppText
          variant="footnote"
          color={c.brand.foreground}
          style={[styles.status, { paddingBottom: insets.bottom + space.s8 }]}
        >
          {status}
        </AppText>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  status: { opacity: 0.8, textAlign: 'center' }
})

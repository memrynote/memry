import { useCallback } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'

import { AppText } from '@/components/ui/app-text'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { AUTH_GUTTER } from '@/features/auth/chrome'
import { signOut } from '@/sync/auth-client'
import { sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

const SETUP_GUIDE_URL = 'https://memry.app/docs/getting-started'

/**
 * Signed in, but the account has no vault (Paper `05 · Auth — No vault yet`).
 * A vault is only ever created on desktop, where the recovery phrase can be
 * written down, so this is a dead end by design rather than a failure.
 */
export default function NoVaultScreen() {
  const c = useColors()

  const leave = useCallback(async () => {
    await signOut()
    router.replace('/welcome')
  }, [])

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.canvas.background }]}>
      <View style={styles.spacer} />
      <View style={styles.body}>
        <Icon name="lock" size={44} color={c.text.tertiary} strokeWidth={1.25} />
        <AppText variant="title2" style={styles.centered}>
          No vault on this account yet
        </AppText>
        <AppText variant="body" color={c.text.secondary} style={styles.centered}>
          A vault is created on the desktop app, where your recovery phrase is generated and written
          down. Once it exists, sign in here and it will appear.
        </AppText>
      </View>

      <View style={styles.footer}>
        <Button
          label="How to set up on desktop"
          variant="outline"
          onPress={() => void WebBrowser.openBrowserAsync(SETUP_GUIDE_URL)}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          onPress={leave}
          style={styles.signOut}
        >
          <AppText variant="body" color={c.tint.text}>
            Sign out
          </AppText>
        </Pressable>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  spacer: { height: sizes.navBar },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.s16,
    paddingHorizontal: space.s32
  },
  centered: { textAlign: 'center' },
  footer: { paddingHorizontal: AUTH_GUTTER, paddingBottom: space.s8, gap: space.s4 },
  signOut: { height: sizes.tapTarget, alignItems: 'center', justifyContent: 'center' }
})

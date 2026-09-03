import { useCallback, useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'

import { AppText } from '@/components/ui/app-text'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { AUTH_GUTTER } from '@/features/auth/chrome'
import { requestDeviceUnlock } from '@/lib/device-unlock'
import { radius, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

type Phase = 'prompting' | 'refused'

/**
 * Biometric gate (Paper `09 · Auth — Device unlock`).
 *
 * The board draws the iOS sheet; that sheet is the system's and comes from
 * `authenticateAsync`, so what this screen owns is the quiet backdrop behind
 * it and the way out when the prompt is dismissed.
 */
export default function DeviceUnlockScreen() {
  const c = useColors()
  const [phase, setPhase] = useState<Phase>('prompting')

  // The prompt runs inside the effect rather than through a callback the
  // effect calls, so nothing sets state synchronously on the mount pass.
  // Bumping the nonce is how the retry button asks for another prompt.
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const outcome = await requestDeviceUnlock()
      if (cancelled) return
      // 'unavailable' means the gate cannot be enforced on this device, so it
      // opens rather than stranding someone who has a perfectly good key.
      if (outcome === 'passed' || outcome === 'unavailable') {
        router.replace('/notes')
        return
      }
      setPhase('refused')
    })()
    return () => {
      cancelled = true
    }
  }, [nonce])

  const retry = useCallback(() => {
    setPhase('prompting')
    setNonce((n) => n + 1)
  }, [])

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.canvas.background }]}>
      <View style={styles.body}>
        <View style={[styles.mark, { backgroundColor: c.canvas.surface }]}>
          <Icon name="face-id" size={40} color={c.text.secondary} />
        </View>
        <AppText variant="title2" style={styles.centered}>
          Unlock Memry
        </AppText>
        <AppText variant="body" color={c.text.secondary} style={styles.centered}>
          {phase === 'prompting'
            ? 'Confirm it is you to open your vault on this device.'
            : 'Face ID was dismissed. Try again, or enter your recovery phrase instead.'}
        </AppText>
      </View>

      <View style={styles.actions}>
        <Button label="Try Face ID again" onPress={retry} disabled={phase === 'prompting'} />
        <Button
          label="Use recovery phrase instead"
          variant="outline"
          onPress={() => router.replace('/unlock')}
        />
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.s16,
    paddingHorizontal: space.s32
  },
  mark: {
    width: 72,
    height: 72,
    borderRadius: radius.xxl,
    alignItems: 'center',
    justifyContent: 'center'
  },
  centered: { textAlign: 'center' },
  actions: { paddingHorizontal: AUTH_GUTTER, paddingBottom: space.s8, gap: space.s8 }
})

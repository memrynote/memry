import { useCallback, useMemo, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'

import { AppText } from '@/components/ui/app-text'
import { Button } from '@/components/ui/button'
import { TextField } from '@/components/ui/text-field'
import { AUTH_GUTTER, BackBar } from '@/features/auth/chrome'
import { GoogleMark } from '@/features/auth/google-mark'
import {
  GoogleSignInCancelled,
  googleSignInConfig,
  signInWithGoogle
} from '@/features/auth/google-sign-in'
import { extractErrorMessage } from '@/lib/errors'
import { requestOtp } from '@/sync/auth-client'
import { radius, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

// The board authors this label at 0.06em on 12px. captionEmphasis carries a
// different tracking, so the resolved px value overrides it here.
const fieldLabel = { letterSpacing: 0.72 }
const SOCIAL_HEIGHT = 50

/** Sign in, step one (Paper `03 · Auth — Sign in, email`). */
export default function SignInScreen() {
  const c = useColors()
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const google = useMemo(() => googleSignInConfig(), [])

  const sendCode = useCallback(async () => {
    const address = email.trim()
    setBusy(true)
    setError(null)
    try {
      await requestOtp(address)
      router.push({ pathname: '/verify', params: { email: address } })
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not send the code. Check the address and retry.'))
    } finally {
      setBusy(false)
    }
  }, [email])

  const continueWithGoogle = useCallback(async () => {
    if (!google) return
    setBusy(true)
    setError(null)
    try {
      const result = await signInWithGoogle(google)
      router.replace(result.needsSetup ? '/no-vault' : '/vaults')
    } catch (err) {
      // A dismissed sheet is a choice, not a failure worth an error line.
      if (err instanceof GoogleSignInCancelled) return
      setError(extractErrorMessage(err, 'Google sign-in failed. Try again.'))
    } finally {
      setBusy(false)
    }
  }, [google])

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.canvas.background }]}>
      <BackBar />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.body}>
          <View style={styles.heading}>
            <AppText variant="largeTitle">Sign in</AppText>
            <AppText variant="body" color={c.text.secondary}>
              We’ll email you a six-digit code. No password to remember.
            </AppText>
          </View>

          <View style={styles.field}>
            <AppText variant="captionEmphasis" color={c.text.secondary} style={fieldLabel}>
              EMAIL
            </AppText>
            <TextField
              value={email}
              onChangeText={setEmail}
              error={error ?? undefined}
              placeholder="you@example.com"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              accessibilityLabel="Email address"
              editable={!busy}
              autoFocus
            />
          </View>

          <Button
            label="Send code"
            onPress={sendCode}
            busy={busy}
            disabled={email.trim().length === 0}
            accessibilityLabel="Send code"
          />

          {google ? (
            <>
              <View style={styles.divider}>
                <View style={[styles.rule, { backgroundColor: c.line.border }]} />
                <AppText variant="footnote" color={c.text.secondary}>
                  or
                </AppText>
                <View style={[styles.rule, { backgroundColor: c.line.border }]} />
              </View>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Continue with Google"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={continueWithGoogle}
                style={({ pressed }) => [
                  styles.social,
                  { backgroundColor: c.canvas.background, borderColor: c.line.border },
                  pressed && styles.pressed
                ]}
              >
                <GoogleMark />
                <AppText variant="bodyEmphasis">Continue with Google</AppText>
              </Pressable>
            </>
          ) : null}
        </View>

        <View style={styles.legal}>
          <AppText variant="caption" color={c.text.secondary} style={styles.centered}>
            Signing in creates no plaintext copy of your vault. Memry stores anonymous usage
            telemetry only.
          </AppText>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  body: { flex: 1, paddingHorizontal: AUTH_GUTTER, paddingTop: space.s24, gap: space.s24 },
  heading: { gap: space.s8 },
  field: { gap: space.s8 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: space.s12, paddingTop: space.s8 },
  rule: { flex: 1, height: 1 },
  social: {
    height: SOCIAL_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.s8,
    borderRadius: radius.lg,
    borderWidth: 1
  },
  pressed: { transform: [{ scale: 0.97 }] },
  legal: { paddingHorizontal: AUTH_GUTTER, paddingBottom: space.s8 },
  centered: { textAlign: 'center' }
})

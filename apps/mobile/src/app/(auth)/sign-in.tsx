import { useCallback, useState } from 'react'
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'

import { AppText } from '@/components/ui/app-text'
import { Button } from '@/components/ui/button'
import { TextField } from '@/components/ui/text-field'
import { AUTH_GUTTER, BackBar } from '@/features/auth/chrome'
import { extractErrorMessage } from '@/lib/errors'
import { requestOtp } from '@/sync/auth-client'
import { space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

// The board authors this label at 0.06em on 12px. captionEmphasis carries a
// different tracking, so the resolved px value overrides it here.
const fieldLabel = { letterSpacing: 0.72 }

/** Sign in, step one (Paper `03 · Auth — Sign in, email`). */
export default function SignInScreen() {
  const c = useColors()
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
  legal: { paddingHorizontal: AUTH_GUTTER, paddingBottom: space.s8 },
  centered: { textAlign: 'center' }
})

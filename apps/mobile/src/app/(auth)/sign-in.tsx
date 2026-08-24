import { useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, TextInput } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { Spacing } from '@/constants/theme'
import { extractErrorMessage } from '@/lib/errors'
import { requestOtp, verifyOtpAndRegisterDevice } from '@/sync/auth-client'

/**
 * Sign-in (T043): e-mail → one-time code → device registration. An account
 * with no vault yet is out of US1 scope — seed it from desktop first.
 */
export default function SignInScreen() {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sendCode = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await requestOtp(email.trim())
      setStep('code')
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not send the code. Check the address and retry.'))
    } finally {
      setBusy(false)
    }
  }, [email])

  const verify = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await verifyOtpAndRegisterDevice(email.trim(), code.trim())
      if (result.needsSetup) {
        setError(
          'This account has no vault yet. Set Memry up on your desktop first, then sign in here.'
        )
        return
      }
      router.replace('/vaults')
    } catch (err) {
      setError(extractErrorMessage(err, 'Sign-in failed. Check the code and retry.'))
    } finally {
      setBusy(false)
    }
  }, [email, code])

  return (
    <SafeAreaView style={styles.safe}>
      <ThemedView style={styles.container}>
        <ThemedText type="title">Sign in</ThemedText>

        {step === 'email' ? (
          <>
            <ThemedText type="small">
              Enter the e-mail of your Memry account. We send a one-time code.
            </ThemedText>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              accessibilityLabel="E-mail address"
              editable={!busy}
            />
            <Pressable
              style={styles.button}
              onPress={sendCode}
              disabled={busy || email.trim().length === 0}
              accessibilityRole="button"
              accessibilityLabel="Send code"
            >
              {busy ? <ActivityIndicator /> : <ThemedText type="smallBold">Send code</ThemedText>}
            </Pressable>
          </>
        ) : (
          <>
            <ThemedText type="small">Enter the code we sent to {email.trim()}.</ThemedText>
            <TextInput
              style={styles.input}
              value={code}
              onChangeText={setCode}
              placeholder="123456"
              keyboardType="number-pad"
              autoComplete="one-time-code"
              accessibilityLabel="One-time code"
              editable={!busy}
            />
            <Pressable
              style={styles.button}
              onPress={verify}
              disabled={busy || code.trim().length === 0}
              accessibilityRole="button"
              accessibilityLabel="Verify code"
            >
              {busy ? <ActivityIndicator /> : <ThemedText type="smallBold">Verify</ThemedText>}
            </Pressable>
            <Pressable
              onPress={() => setStep('email')}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Use a different e-mail"
            >
              <ThemedText type="link">Use a different e-mail</ThemedText>
            </Pressable>
          </>
        )}

        {error ? (
          <ThemedText type="small" style={styles.error} accessibilityRole="alert">
            {error}
          </ThemedText>
        ) : null}
      </ThemedView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: {
    flex: 1,
    padding: Spacing.four,
    gap: Spacing.three
  },
  input: {
    borderWidth: 1,
    borderColor: 'rgba(127,127,127,0.4)',
    borderRadius: 8,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16
  },
  button: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(127,127,127,0.4)',
    paddingVertical: Spacing.two
  },
  error: { color: '#c0392b' }
})

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Redirect, router, useLocalSearchParams } from 'expo-router'

import { AppText } from '@/components/ui/app-text'
import { CodeInput } from '@/components/ui/code-input'
import { AUTH_GUTTER, BackBar } from '@/features/auth/chrome'
import { extractErrorMessage } from '@/lib/errors'
import { resendOtp, verifyOtpAndRegisterDevice } from '@/sync/auth-client'
import { sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

const CODE_LENGTH = 6
const RESEND_COOLDOWN_SECONDS = 60

const countdown = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

/**
 * Sign in, step two (Paper `04 · Auth — Sign in, code`). The board carries no
 * submit button, so a full code verifies itself.
 */
export default function VerifyScreen() {
  const c = useColors()
  const { email } = useLocalSearchParams<{ email?: string }>()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(RESEND_COOLDOWN_SECONDS)
  // Which code the screen already spent, so an unchanged value cannot fire a
  // second request when the effect re-runs.
  const attempted = useRef<string | null>(null)

  const verify = useCallback(
    async (value: string) => {
      if (!email) return
      setBusy(true)
      setError(null)
      try {
        const result = await verifyOtpAndRegisterDevice(email, value)
        if (result.needsSetup) {
          router.replace('/no-vault')
          return
        }
        router.replace('/vaults')
      } catch (err) {
        setError(extractErrorMessage(err, 'That code did not work. Check it and try again.'))
      } finally {
        setBusy(false)
      }
    },
    [email]
  )

  useEffect(() => {
    if (busy || code.length !== CODE_LENGTH || attempted.current === code) return
    attempted.current = code
    void verify(code)
  }, [busy, code, verify])

  useEffect(() => {
    if (secondsLeft <= 0) return
    const timer = setTimeout(() => setSecondsLeft((left) => left - 1), 1000)
    return () => clearTimeout(timer)
  }, [secondsLeft])

  const resend = useCallback(async () => {
    if (!email) return
    setError(null)
    setCode('')
    attempted.current = null
    setSecondsLeft(RESEND_COOLDOWN_SECONDS)
    try {
      await resendOtp(email)
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not send another code. Try again in a moment.'))
    }
  }, [email])

  if (!email) return <Redirect href="/sign-in" />

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.canvas.background }]}>
      <BackBar />
      <View style={styles.body}>
        <View style={styles.heading}>
          <AppText variant="largeTitle">Check your email</AppText>
          <AppText variant="body" color={c.text.secondary}>
            We sent a code to {email}.
          </AppText>
        </View>

        <CodeInput
          value={code}
          onChangeText={setCode}
          length={CODE_LENGTH}
          editable={!busy}
          autoFocus
          accessibilityLabel={`Six-digit code sent to ${email}`}
        />

        {error ? (
          <AppText variant="footnote" color={c.ui.destructiveText} accessibilityRole="alert">
            {error}
          </AppText>
        ) : null}

        <View style={styles.resend}>
          <AppText variant="subhead" color={c.text.secondary}>
            Didn’t get it?
          </AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Resend code"
            accessibilityState={{ disabled: secondsLeft > 0 }}
            disabled={secondsLeft > 0}
            onPress={resend}
            style={styles.resendAction}
          >
            <AppText variant="bodyEmphasis" color={secondsLeft > 0 ? c.text.tertiary : c.tint.base}>
              {secondsLeft > 0 ? `Resend in ${countdown(secondsLeft)}` : 'Resend code'}
            </AppText>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  body: { flex: 1, paddingHorizontal: AUTH_GUTTER, paddingTop: space.s24, gap: 28 },
  heading: { gap: space.s8 },
  resend: { alignItems: 'center', gap: space.s4 },
  resendAction: { height: sizes.tapTarget, justifyContent: 'center' }
})

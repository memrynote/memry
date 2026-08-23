import { useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, TextInput } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { Spacing } from '@/constants/theme'
import { extractErrorMessage } from '@/lib/errors'
import { InvalidPhraseError, WrongPhraseError, unlockVaultWithPhrase } from '@/lib/vault-unlock'
import { loadCurrentVaultId, loadSession } from '@/sync/auth-client'

/**
 * Vault unlock (T044). The 24-word recovery phrase is the credential — the
 * product has no separate vault password (G0 record); Argon2id runs on-device
 * and the derived key is stored only after the server verifier matches, so a
 * wrong phrase leaves NOTHING half-unlocked.
 */
export default function UnlockScreen() {
  const [phrase, setPhrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const unlock = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const session = await loadSession()
      const vaultId = await loadCurrentVaultId()
      if (!session || !vaultId) {
        router.replace('/sign-in')
        return
      }
      await unlockVaultWithPhrase(vaultId, session.accessToken, phrase)
      router.replace('/notes')
    } catch (err) {
      if (err instanceof WrongPhraseError) {
        setError(
          'That phrase does not match this account. Nothing was unlocked — check the words and try again.'
        )
      } else if (err instanceof InvalidPhraseError) {
        setError('A recovery phrase is 24 words. Check for typos or missing words.')
      } else {
        setError(extractErrorMessage(err, 'Unlock failed. Try again.'))
      }
    } finally {
      setBusy(false)
    }
  }, [phrase])

  return (
    <SafeAreaView style={styles.safe}>
      <ThemedView style={styles.container}>
        <ThemedText type="title">Unlock your vault</ThemedText>
        <ThemedText type="small">
          Enter your 24-word recovery phrase. The key never leaves this device.
        </ThemedText>
        <TextInput
          style={styles.input}
          value={phrase}
          onChangeText={setPhrase}
          placeholder="apple banana cherry …"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          numberOfLines={4}
          secureTextEntry={false}
          accessibilityLabel="Recovery phrase, 24 words"
          editable={!busy}
        />
        <Pressable
          style={styles.button}
          onPress={unlock}
          disabled={busy || phrase.trim().length === 0}
          accessibilityRole="button"
          accessibilityLabel="Unlock vault"
        >
          {busy ? (
            <>
              <ActivityIndicator />
              <ThemedText type="small">Deriving keys…</ThemedText>
            </>
          ) : (
            <ThemedText type="smallBold">Unlock</ThemedText>
          )}
        </Pressable>
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
  container: { flex: 1, padding: Spacing.four, gap: Spacing.three },
  input: {
    borderWidth: 1,
    borderColor: 'rgba(127,127,127,0.4)',
    borderRadius: 8,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    minHeight: 96,
    fontSize: 16,
    textAlignVertical: 'top'
  },
  button: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(127,127,127,0.4)',
    paddingVertical: Spacing.two,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.two
  },
  error: { color: '#c0392b' }
})

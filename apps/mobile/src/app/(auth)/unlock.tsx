import { useCallback, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { wordlist } from '@scure/bip39/wordlists/english.js'

import { AppText } from '@/components/ui/app-text'
import { Button } from '@/components/ui/button'
import { AUTH_GUTTER, BackBar } from '@/features/auth/chrome'
import { emptyPhrase, suggest } from '@/features/auth/phrase-entry'
import { PhraseGrid } from '@/features/auth/phrase-grid'
import { extractErrorMessage } from '@/lib/errors'
import { InvalidPhraseError, WrongPhraseError, unlockVaultWithPhrase } from '@/lib/vault-unlock'
import { loadCurrentVaultId, loadSession } from '@/sync/auth-client'
import { radius, sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

/**
 * Vault unlock (Paper `08 · Auth — Unlock, recovery phrase`).
 *
 * The 24-word BIP39 phrase is the whole credential: the product has no vault
 * password, so board `07 · Unlock, password` has no implementation and this is
 * the only way in. Argon2id runs on-device and the derived key reaches
 * secure-store only after the server verifier matches, so a wrong phrase
 * leaves nothing half-unlocked.
 */
export default function UnlockScreen() {
  const c = useColors()
  const [words, setWords] = useState<string[]>(emptyPhrase)
  const [focused, setFocused] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const suggestions = useMemo(() => suggest(words[focused] ?? '', wordlist), [words, focused])

  const complete = words.every((word) => word.length > 0)

  const accept = useCallback(
    (suggestion: string) => {
      const next = [...words]
      next[focused] = suggestion
      setWords(next)
    },
    [words, focused]
  )

  const unlock = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const session = await loadSession()
      const vaultId = await loadCurrentVaultId()
      if (!session || !vaultId) {
        router.replace('/welcome')
        return
      }
      await unlockVaultWithPhrase(vaultId, session.accessToken, words.join(' '))
      router.replace('/notes')
    } catch (err) {
      if (err instanceof WrongPhraseError) {
        setError(
          'That phrase does not match this account. Nothing was unlocked — check the words and try again.'
        )
      } else if (err instanceof InvalidPhraseError) {
        setError('Those words are not a valid recovery phrase. Check the spelling and the order.')
      } else {
        setError(extractErrorMessage(err, 'Unlock failed. Try again.'))
      }
    } finally {
      setBusy(false)
    }
  }, [words])

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.canvas.background }]}>
      <BackBar />
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.heading}>
          <AppText variant="largeTitle">Recovery phrase</AppText>
          <AppText variant="body" color={c.text.secondary}>
            Enter the twenty-four words in order, from the sheet you wrote down when you created
            this vault.
          </AppText>
        </View>

        <PhraseGrid
          words={words}
          onChange={setWords}
          focused={focused}
          onFocusIndex={setFocused}
          editable={!busy}
        />

        {suggestions.length > 0 ? (
          <View style={styles.suggestions}>
            {suggestions.map((suggestion) => (
              <Pressable
                key={suggestion}
                accessibilityRole="button"
                accessibilityLabel={`Use ${suggestion} for word ${focused + 1}`}
                onPress={() => accept(suggestion)}
                style={[styles.suggestion, { backgroundColor: c.canvas.surface }]}
              >
                <AppText variant="subhead">{suggestion}</AppText>
              </Pressable>
            ))}
          </View>
        ) : null}

        {error ? (
          <AppText variant="footnote" color={c.ui.destructiveText} accessibilityRole="alert">
            {error}
          </AppText>
        ) : null}
      </ScrollView>

      <View style={styles.actions}>
        <Button
          label="Unlock vault"
          onPress={unlock}
          disabled={!complete}
          busy={busy}
          accessibilityLabel="Unlock vault"
        />
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  body: { paddingHorizontal: AUTH_GUTTER, paddingTop: space.s24, gap: space.s20 },
  heading: { gap: space.s8 },
  suggestions: { flexDirection: 'row', gap: space.s8 },
  suggestion: {
    height: sizes.tapTarget,
    paddingHorizontal: space.s16,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center'
  },
  actions: { paddingHorizontal: AUTH_GUTTER, paddingBottom: space.s8, paddingTop: space.s8 }
})

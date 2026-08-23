import { useEffect, useState } from 'react'
import { ActivityIndicator, ScrollView, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams } from 'expo-router'
import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { Spacing } from '@/constants/theme'
import { openVaultDb } from '@/db/index'
import { loadCurrentVaultId } from '@/sync/auth-client'
import { ensureNoteBody } from '@/sync/body-fetch'

/**
 * Read-only note preview (T050): plain markdown text render — an explicit
 * placeholder until the Phase 4 WebView editor replaces it. Opening a note
 * outside the 30-day body window triggers the on-demand fetch (T048).
 */
export default function NotePreviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const [title, setTitle] = useState('')
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!id) return
      const vaultId = await loadCurrentVaultId()
      if (!vaultId) return
      const db = await openVaultDb(vaultId)

      const meta = await db.getFirstAsync<{ payload: string | null }>(
        'SELECT payload FROM sync_items WHERE id = ?',
        [id]
      )
      try {
        const payload = meta?.payload ? (JSON.parse(meta.payload) as { title?: string }) : {}
        if (!cancelled) setTitle(payload.title ?? 'Untitled')
      } catch {
        if (!cancelled) setTitle('Untitled')
      }

      const readBody = async () => {
        const row = await db.getFirstAsync<{ markdown: string }>(
          'SELECT markdown FROM note_bodies WHERE item_id = ?',
          [id]
        )
        return row?.markdown ?? null
      }

      const local = await readBody()
      if (!cancelled) setMarkdown(local)

      // On-demand: pull the blob/body when missing, refresh when it lands.
      if (!cancelled) setFetching(true)
      const updated = await ensureNoteBody(vaultId, id)
      if (!cancelled) {
        if (updated || local === null) setMarkdown(await readBody())
        setFetching(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  return (
    <SafeAreaView style={styles.safe}>
      <Stack.Screen options={{ title }} />
      <ThemedView style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <ThemedText type="title">{title}</ThemedText>
          {markdown === null ? (
            fetching ? (
              <>
                <ActivityIndicator />
                <ThemedText type="small">Fetching this note…</ThemedText>
              </>
            ) : (
              <ThemedText type="small">
                This note has not been downloaded yet. Connect and reopen it.
              </ThemedText>
            )
          ) : (
            <ThemedText style={styles.body} accessibilityLabel="Note content">
              {markdown}
            </ThemedText>
          )}
        </ScrollView>
      </ThemedView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { flex: 1 },
  scroll: { padding: Spacing.three, gap: Spacing.three },
  body: { fontSize: 15, lineHeight: 22 }
})

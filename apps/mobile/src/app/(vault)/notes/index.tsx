import { useCallback, useEffect, useState } from 'react'
import { FlatList, Pressable, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, useFocusEffect } from 'expo-router'
import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { Spacing } from '@/constants/theme'
import { openVaultDb } from '@/db/index'
import { loadCurrentVaultId } from '@/sync/auth-client'
import { getSyncEngine } from '@/sync/engine'
import { getEditorSession } from '@/editor/session'
import { createNote } from '@/features/notes/note-ops'
import {
  createNoteFromTemplate,
  listTemplates,
  type TemplateSummary
} from '@/features/notes/from-template'
import { subscribeReadOnly } from '@/sync/read-only-mode'

interface NoteRow {
  id: string
  title: string
  folderPath: string
  updatedAt: number
  hasBody: boolean
}

interface Section {
  folder: string
  notes: NoteRow[]
}

/**
 * Notes browse (T049): folder tree + note list, read-only. Folders come from
 * the note payloads' folderPath projection; notes without a pulled payload
 * yet show as pending rows.
 */
export default function NotesScreen() {
  const [sections, setSections] = useState<Section[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const [vaultId, setVaultId] = useState<string | null>(null)
  const [templates, setTemplates] = useState<TemplateSummary[]>([])
  const [choosingTemplate, setChoosingTemplate] = useState(false)
  const [readOnly, setReadOnly] = useState(false)

  const reload = useCallback(async () => {
    const vid = await loadCurrentVaultId()
    if (!vid) return
    setVaultId(vid)
    const db = await openVaultDb(vid)
    const rows = await db.getAllAsync<{
      id: string
      payload: string | null
      updated_at: number
      body: number | null
    }>(
      `SELECT s.id, s.payload, s.updated_at, (SELECT 1 FROM note_bodies b WHERE b.item_id = s.id) AS body
       FROM sync_items s
       WHERE s.type = 'note' AND s.deleted_at IS NULL AND s.payload_state = 'full'
       ORDER BY s.updated_at DESC`
    )
    const pending = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sync_items WHERE type = 'note' AND deleted_at IS NULL AND payload_state = 'metadata-only'`
    )
    setPendingCount(pending?.n ?? 0)

    const byFolder = new Map<string, NoteRow[]>()
    for (const row of rows) {
      let title = 'Untitled'
      let folderPath = ''
      try {
        const payload = row.payload
          ? (JSON.parse(row.payload) as { title?: string; folderPath?: string | null })
          : {}
        title = payload.title ?? 'Untitled'
        folderPath = payload.folderPath ?? ''
      } catch {
        // unparseable payload: keep defaults
      }
      const list = byFolder.get(folderPath) ?? []
      list.push({
        id: row.id,
        title,
        folderPath,
        updatedAt: row.updated_at,
        hasBody: row.body === 1
      })
      byFolder.set(folderPath, list)
    }

    const next = [...byFolder.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([folder, notes]) => ({ folder, notes }))
    setSections(next)
  }, [])

  useFocusEffect(
    useCallback(() => {
      void reload()
    }, [reload])
  )

  useEffect(() => {
    if (!vaultId) return
    const engine = getSyncEngine(vaultId)
    return engine.onSynced(() => {
      void reload()
    })
  }, [vaultId, reload])

  useEffect(() => subscribeReadOnly((state) => setReadOnly(state.readOnly)), [])

  useEffect(() => {
    if (!vaultId) return
    void getEditorSession(vaultId).then((session) => listTemplates(session.db).then(setTemplates))
  }, [vaultId])

  /**
   * Create is offline-first like every other write: the note exists locally the
   * moment it is tapped, and the outbox carries it whenever there is a network.
   */
  const create = useCallback(
    async (templateId?: string) => {
      if (!vaultId) return
      const session = await getEditorSession(vaultId)
      const ctx = {
        db: session.db,
        outbox: session.outbox,
        vaultId,
        deviceId: session.deviceId
      }
      const noteId = templateId
        ? await createNoteFromTemplate(ctx, templateId, { title: 'Untitled' })
        : await createNote(ctx, { title: 'Untitled' })
      setChoosingTemplate(false)
      if (noteId) {
        await reload()
        router.push(`/notes/${noteId}`)
      }
    },
    [reload, vaultId]
  )

  const flat: ({ type: 'folder'; name: string } | { type: 'note'; note: NoteRow })[] = []
  for (const section of sections) {
    if (section.folder) flat.push({ type: 'folder', name: section.folder })
    for (const note of section.notes) flat.push({ type: 'note', note })
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ThemedView style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="title">Notes</ThemedText>
          {readOnly ? null : (
            <View style={styles.headerActions}>
              <Pressable
                onPress={() => void create()}
                style={styles.headerButton}
                accessibilityRole="button"
                accessibilityLabel="New note"
              >
                <ThemedText type="smallBold">New</ThemedText>
              </Pressable>
              {templates.length > 0 ? (
                <Pressable
                  onPress={() => setChoosingTemplate((value) => !value)}
                  style={styles.headerButton}
                  accessibilityRole="button"
                  accessibilityLabel="New note from template"
                >
                  <ThemedText type="smallBold">Template</ThemedText>
                </Pressable>
              ) : null}
            </View>
          )}
        </View>
        {choosingTemplate
          ? templates.map((template) => (
              <Pressable
                key={template.id}
                onPress={() => void create(template.id)}
                style={styles.templateRow}
                accessibilityRole="button"
                accessibilityLabel={`New note from ${template.name}`}
              >
                <ThemedText>{template.name}</ThemedText>
              </Pressable>
            ))
          : null}
        {pendingCount > 0 ? (
          <ThemedText type="small">{pendingCount} more items still syncing…</ThemedText>
        ) : null}
        <FlatList
          data={flat}
          keyExtractor={(item) => (item.type === 'folder' ? `f:${item.name}` : item.note.id)}
          renderItem={({ item }) =>
            item.type === 'folder' ? (
              <View style={styles.folderRow} accessibilityRole="header">
                <ThemedText type="smallBold">{item.name}</ThemedText>
              </View>
            ) : (
              <Pressable
                style={styles.noteRow}
                onPress={() => router.push(`/notes/${item.note.id}`)}
                accessibilityRole="button"
                accessibilityLabel={`Open note ${item.note.title}`}
              >
                <ThemedText>{item.note.title}</ThemedText>
                {!item.note.hasBody ? <ThemedText type="small">tap to fetch</ThemedText> : null}
              </Pressable>
            )
          }
          ListEmptyComponent={
            <ThemedText type="small">
              Nothing here yet. Notes appear as the first sync progresses.
            </ThemedText>
          }
        />
      </ThemedView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { flex: 1, padding: Spacing.three, gap: Spacing.two },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerActions: { flexDirection: 'row', gap: Spacing.two },
  headerButton: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
  templateRow: { minHeight: 44, justifyContent: 'center' },
  folderRow: { paddingTop: Spacing.three, paddingBottom: Spacing.one },
  noteRow: {
    paddingVertical: Spacing.two,
    paddingStart: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(127,127,127,0.2)',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  }
})

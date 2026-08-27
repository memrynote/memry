import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import type { BridgeCfg } from '@memry/contracts/webview-bridge'
import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { Spacing } from '@/constants/theme'
import { EditorView, type EditorControls } from '@/editor/editor-view'
import { formatG3Report } from '@/editor/__rig__/latency'
import type { OpenDoc } from '@/editor/doc-manager'
import { getEditorSession, type EditorSession } from '@/editor/session'
import { queryWikiCandidates, resolveWikiTarget } from '@/editor/wiki-links'
import { insertAttachment, pickDocument, pickImage } from '@/features/attachments/insert'
import { resolveAsset } from '@/features/attachments/resolve'
import { NoteManageSheet } from '@/features/notes/manage'
import {
  clearPendingSeed,
  readNotePayload,
  takePendingSeed,
  type NoteOpsContext,
  type NotePayload
} from '@/features/notes/note-ops'
import { NoteProperties } from '@/features/notes/properties'
import { NoteTags } from '@/features/notes/tags'
import { useColorScheme } from '@/hooks/use-color-scheme'
import { extractErrorMessage } from '@/lib/errors'
import { createLogger } from '@/lib/logger'
import { loadCurrentVaultId } from '@/sync/auth-client'
import { getSyncEngine } from '@/sync/engine'
import { subscribeReadOnly } from '@/sync/read-only-mode'

const log = createLogger('NoteScreen')

/**
 * The note editor (T064). Replaces the US1 read-only preview.
 *
 * The Y.Doc is opened by the doc manager and handed to the WebView; this screen
 * owns only the things around it — the header actions, the metadata sheets, and
 * the flush on background transition (T076).
 */
export default function NoteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const scheme = useColorScheme()

  const [session, setSession] = useState<EditorSession | null>(null)
  const [doc, setDoc] = useState<OpenDoc | null>(null)
  const [payload, setPayload] = useState<NotePayload | null>(null)
  // The markdown body as the pull path materialized it. Only ever used to seed
  // a doc that has no CRDT state, so it cannot overwrite real content.
  const [seedMarkdown, setSeedMarkdown] = useState<string | undefined>(undefined)
  const [readOnly, setReadOnly] = useState(false)
  const [managing, setManaging] = useState(false)
  const [showMeta, setShowMeta] = useState(false)
  // Dev-build bridge counters + keystroke latency, read on demand (T075).
  const [metrics, setMetrics] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const controls = useRef<EditorControls | null>(null)

  useEffect(() => subscribeReadOnly((state) => setReadOnly(state.readOnly)), [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!id) return
      const vaultId = await loadCurrentVaultId()
      if (!vaultId || cancelled) return

      const editorSession = await getEditorSession(vaultId)
      const openDoc = await editorSession.docs.openDoc(id)
      const notePayload = await readNotePayload(editorSession.db, id)
      // From the CREATE marker, not from `note_bodies`: the record applier
      // fills that table for every pulled note from its create-time content,
      // and seeding an older note from it would duplicate the body on every
      // device once the server's CRDT state merged in.
      const seed = openDoc.isEmpty() ? await takePendingSeed(editorSession.db, id) : undefined

      if (cancelled) return
      setSession(editorSession)
      setDoc(openDoc)
      setPayload(notePayload)
      setSeedMarkdown(seed)
      // Consumed once. A second open after the seed became real content must
      // not re-apply it.
      if (seed) void clearPendingSeed(editorSession.db, id)
    })().catch((err: unknown) => {
      // Without this the screen is a bare spinner forever and the failure
      // surfaces only as an unhandled rejection nobody reads.
      const message = extractErrorMessage(err, 'This note could not be opened.')
      log.error('Opening the note failed', { noteId: id, error: message })
      if (!cancelled) setLoadError(message)
    })
    return () => {
      cancelled = true
    }
  }, [id])

  // Remote CRDT updates reach the open doc through the sync engine's pull; this
  // is what makes a desktop edit appear in the open editor rather than only
  // after a reopen.
  useEffect(() => {
    if (!session || !id) return
    const engine = getSyncEngine(session.vaultId)
    return engine.onSynced((summary) => {
      void (async () => {
        // Feed the pulled CRDT rows into whichever docs are open FIRST: the
        // editor is showing one of them, and a payload refresh alone would
        // update the title while the body silently stayed behind.
        if (summary.changedNoteIds.length > 0) {
          await session.docs.refreshOpenDocs(summary.changedNoteIds)
        }
        const refreshed = await readNotePayload(session.db, id)
        if (refreshed) setPayload(refreshed)
      })()
    })
  }, [id, session])

  // Background transition: flush the bridge, then drain the outbox (T076). The
  // order matters — flushing first is what puts the last keystrokes INTO the
  // outbox before the drain reads it.
  useEffect(() => {
    if (!session) return
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') return
      // Flush the bridge and WAIT for what it shook loose to be durable, then
      // drain. Draining first would read the outbox before the last keystrokes
      // had finished their round trip through the WebView.
      void (async () => {
        await controls.current?.flush()
        await session.flush()
      })().catch((err) => {
        log.warn('Background drain failed', {
          error: err instanceof Error ? err.message : String(err)
        })
      })
    })
    return () => subscription.remove()
  }, [session])

  const ctx: NoteOpsContext | null = useMemo(
    () =>
      session
        ? {
            db: session.db,
            outbox: session.outbox,
            vaultId: session.vaultId,
            deviceId: session.deviceId
          }
        : null,
    [session]
  )

  const cfg: BridgeCfg = useMemo(
    () => ({
      theme: scheme === 'dark' ? 'dark' : 'light',
      locale: 'en',
      // RTL follows the app's own layout direction, which is what the shared
      // logical-property CSS is written against.
      rtl: false,
      reducedMotion: false,
      readOnly
    }),
    [readOnly, scheme]
  )

  const onNavigate = useCallback(
    (target: string) => {
      if (!session) return
      void (async () => {
        const noteId = await resolveWikiTarget(session.db, target)
        if (noteId) router.push(`/(vault)/notes/${noteId}`)
        // A link with no target is a real state (the note has not been created
        // yet), not an error — the desktop shows the same nothing-happens.
      })()
    },
    [session]
  )

  const onWikiQuery = useCallback(
    async (query: string) => (session ? queryWikiCandidates(session.db, query) : []),
    [session]
  )

  const onAssetRequest = useCallback(
    async (ref: string) => {
      if (!session || !id) return { status: 'missing' as const }
      return resolveAsset({ db: session.db, transfer: session.attachments }, id, ref)
    },
    [id, session]
  )

  const onInsert = useCallback(
    async (kind: 'image' | 'file') => {
      if (!ctx || !session || !id) return
      const picked = kind === 'image' ? await pickImage() : await pickDocument()
      if (!picked) return
      const result = await insertAttachment(ctx, session.attachments, id, picked)
      if (!result) return
      setPayload(await readNotePayload(ctx.db, id))
      // The editor owns the block structure; the host only names the reference
      // and its type, so a PDF becomes a file block rather than a broken image.
      controls.current?.insertAttachment(result.ref, result.filename, result.mimeType)
    },
    [ctx, id, session]
  )

  if (loadError) {
    return (
      <SafeAreaView style={styles.safe}>
        <ThemedView style={styles.center}>
          <ThemedText type="small">{loadError}</ThemedText>
        </ThemedView>
      </SafeAreaView>
    )
  }

  if (!doc || !id) {
    return (
      <SafeAreaView style={styles.safe}>
        <ThemedView style={styles.center}>
          <ActivityIndicator />
        </ThemedView>
      </SafeAreaView>
    )
  }

  const title = payload?.title ?? 'Untitled'

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <Stack.Screen
        options={{
          title,
          headerRight: () => (
            <View style={styles.headerActions}>
              <HeaderButton label="Undo" onPress={() => controls.current?.undo()} />
              <HeaderButton label="Redo" onPress={() => controls.current?.redo()} />
              <HeaderButton label="Info" onPress={() => setShowMeta((value) => !value)} />
              <HeaderButton label="More" onPress={() => setManaging(true)} />
            </View>
          )
        }}
      />

      {readOnly ? (
        <ThemedView style={styles.banner}>
          <ThemedText type="small">
            Read-only right now. Your edits stay on this device and sync when writing is available
            again.
          </ThemedText>
        </ThemedView>
      ) : null}

      {showMeta ? (
        <ScrollView style={styles.meta} contentContainerStyle={styles.metaContent}>
          <NoteTags
            ctx={ctx}
            noteId={id}
            tags={payload?.tags ?? []}
            readOnly={readOnly}
            onChanged={(tags) => setPayload((prev) => (prev ? { ...prev, tags } : prev))}
          />
          <NoteProperties
            ctx={ctx}
            noteId={id}
            properties={payload?.properties ?? {}}
            readOnly={readOnly}
            onChanged={(properties) =>
              setPayload((prev) => (prev ? { ...prev, properties } : prev))
            }
          />
          <View style={styles.insertRow}>
            <HeaderButton label="Insert image" onPress={() => void onInsert('image')} />
            <HeaderButton label="Insert file" onPress={() => void onInsert('file')} />
          </View>
          {__DEV__ ? (
            <View style={styles.insertRow}>
              <HeaderButton
                label="Bridge metrics"
                onPress={() =>
                  setMetrics(
                    controls.current
                      ? formatG3Report(controls.current.measure())
                      : 'editor not ready'
                  )
                }
              />
              <HeaderButton
                label="Reset metrics"
                onPress={() => {
                  controls.current?.resetMeasurement()
                  setMetrics(null)
                }}
              />
            </View>
          ) : null}
          {metrics ? (
            <ThemedText type="small" style={styles.metrics} accessibilityLabel="Bridge metrics">
              {metrics}
            </ThemedText>
          ) : null}
        </ScrollView>
      ) : null}

      <EditorView
        doc={doc}
        cfg={cfg}
        onNavigate={onNavigate}
        onWikiQuery={onWikiQuery}
        onAssetRequest={onAssetRequest}
        seedMarkdown={seedMarkdown}
        onReady={(next) => {
          controls.current = next
        }}
      />

      <NoteManageSheet
        visible={managing}
        ctx={ctx}
        noteId={id}
        title={title}
        folderPath={payload?.folderPath ?? ''}
        onClose={() => setManaging(false)}
        onChanged={() => {
          if (session) void readNotePayload(session.db, id).then(setPayload)
        }}
        onDeleted={() => router.back()}
      />
    </SafeAreaView>
  )
}

function HeaderButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.headerButton}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <ThemedText type="small">{label}</ThemedText>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headerActions: { flexDirection: 'row', gap: Spacing.two },
  headerButton: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
  banner: { paddingHorizontal: Spacing.three, paddingVertical: Spacing.two },
  meta: { maxHeight: 260 },
  metaContent: { padding: Spacing.three, gap: Spacing.two },
  insertRow: { flexDirection: 'row', gap: Spacing.three },
  metrics: { fontFamily: 'Menlo', fontSize: 11 }
})

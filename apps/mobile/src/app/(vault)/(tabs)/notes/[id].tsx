import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import type { BridgeCfg } from '@memry/contracts/webview-bridge'
import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { AppText } from '@/components/ui/app-text'
import { Chip } from '@/components/ui/chip'
import { Icon } from '@/components/ui/icon'
import { NavBarInline, type NavBarAction } from '@/components/ui/nav-bar'
import { Spacing } from '@/constants/theme'
import { EditorView, type EditorControls } from '@/editor/editor-view'
import { formatG3Report } from '@/editor/__rig__/latency'
import type { OpenDoc } from '@/editor/doc-manager'
import { getEditorSession, type EditorSession } from '@/editor/session'
import { queryWikiCandidates, resolveWikiTarget } from '@/editor/wiki-links'
import { insertAttachment, pickDocument, pickImage } from '@/features/attachments/insert'
import { resolveAsset } from '@/features/attachments/resolve'
import { editGate, type NoteMode } from '@/features/notes/edit-gate'
import { NoteManageSheet } from '@/features/notes/manage'
import {
  clearPendingSeed,
  materializedBody,
  readNoteRecord,
  resolveSeedMarkdown,
  shouldSeedFromMarkdown,
  toEpochMs,
  type NoteOpsContext,
  type NotePayload,
  type NoteRecord
} from '@/features/notes/note-ops'
import { NoteProperties } from '@/features/notes/properties'
import { NoteTags } from '@/features/notes/tags'
import { editedRelative } from '@/features/search/subtitle'
import { useColorScheme } from '@/hooks/use-color-scheme'
import { extractErrorMessage } from '@/lib/errors'
import { createLogger } from '@/lib/logger'
import { loadCurrentVaultId } from '@/sync/auth-client'
import { ensureNoteBody } from '@/sync/body-fetch'
import { getSyncEngine } from '@/sync/engine'
import { subscribeReadOnly } from '@/sync/read-only-mode'
import { fontFamilies } from '@/theme/fonts'
import { sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

const log = createLogger('NoteScreen')

// Board 28/29 numbers that are not on the space scale, kept local rather than
// growing the scale for one screen (the nav bar's action gap makes the same
// call).
const HEADER_GAP = 14
const EDIT_NAV_SLOT = 100
const EDIT_NAV_GAP = 18

/**
 * How long the editor must be quiet before `Saved` is claimed.
 *
 * Long enough that a flush is not fired between two keystrokes, short enough
 * that a pause reads as saved rather than as a stuck indicator.
 */
const SAVE_SETTLE_MS = 800

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
  const c = useColors()

  const [session, setSession] = useState<EditorSession | null>(null)
  const [doc, setDoc] = useState<OpenDoc | null>(null)
  const [payload, setPayload] = useState<NotePayload | null>(null)
  // The markdown body as the pull path materialized it. Only ever used to seed
  // a doc that has no CRDT state, so it cannot overwrite real content.
  const [seedMarkdown, setSeedMarkdown] = useState<string | undefined>(undefined)
  const [updatedAt, setUpdatedAt] = useState(0)
  const [readAt, setReadAt] = useState(0)
  const [vaultReadOnly, setVaultReadOnly] = useState(false)
  const [mode, setMode] = useState<NoteMode>('read')
  const [saveState, setSaveState] = useState<'saved' | 'saving'>('saved')
  const [managing, setManaging] = useState(false)
  const [showMeta, setShowMeta] = useState(false)
  // Dev-build bridge counters + keystroke latency, read on demand (T075).
  const [metrics, setMetrics] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const controls = useRef<EditorControls | null>(null)
  const localUpdates = useRef(0)

  useEffect(() => subscribeReadOnly((state) => setVaultReadOnly(state.readOnly)), [])

  const gate = editGate({ vaultReadOnly, mode })

  const applyRecord = useCallback((record: NoteRecord | null) => {
    setPayload(record?.payload ?? null)
    setUpdatedAt(record?.updatedAt ?? 0)
    // The clock is read WITH the record rather than in the render body, which
    // is where `Date.now()` is impure. It also means the relative label moves
    // when the note does, not on an unrelated re-render.
    setReadAt(Date.now())
  }, [])

  // The seed marker is cleared only once the seed has actually LANDED — the
  // guest parses the markdown into blocks, which arrives here as an ordinary
  // local update. Clearing it at read time would lose the note's only copy of
  // its body to a back-navigation or a kill in between.
  useEffect(() => {
    if (!doc || !session || !id || !seedMarkdown) return
    let done = false
    const unsubscribe = doc.onLocalUpdate(() => {
      // ONCE. `seedMarkdown` never changes, so without this the listener stays
      // attached and issues an unqueued DELETE per ~24 ms keystroke batch — on
      // the same single SQLite connection the persist path is using.
      if (done) return
      done = true
      unsubscribe()
      void clearPendingSeed(session.db, id).catch(() => {})
    })
    return unsubscribe
  }, [doc, id, seedMarkdown, session])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!id) return
      const vaultId = await loadCurrentVaultId()
      if (!vaultId || cancelled) return

      const editorSession = await getEditorSession(vaultId)
      const openDoc = await editorSession.docs.openDoc(id)
      const record = await readNoteRecord(editorSession.db, id)
      const seed = openDoc.isEmpty() ? await resolveSeedMarkdown(editorSession.db, id) : undefined

      if (cancelled) return
      setSession(editorSession)
      setDoc(openDoc)
      applyRecord(record)
      setSeedMarkdown(seed)

      // The network probe runs AFTER the screen is up, never in front of it.
      // Offline it can spend minutes waiting out `withRetry`, and this path
      // used to be nothing but local SQLite reads — blocking on it turns
      // opening a note into a bare spinner for the whole duration.
      if (!seed && openDoc.isEmpty()) {
        void (async () => {
          const outcome = await ensureNoteBody(vaultId, id)
          if (cancelled) return
          if (outcome === 'updated') {
            await openDoc.refreshFromServer()
            return
          }
          if (
            !shouldSeedFromMarkdown({
              docIsEmpty: openDoc.isEmpty(),
              createdHere: false,
              probe: outcome
            })
          ) {
            return
          }
          const body = await materializedBody(editorSession.db, id)
          if (!cancelled && body) setSeedMarkdown(body)
        })()
      }
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
  }, [applyRecord, id])

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
        const refreshed = await readNoteRecord(session.db, id)
        if (refreshed) applyRecord(refreshed)
      })()
    })
  }, [applyRecord, id, session])

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

  /**
   * What backs `Saved`, so it reports disk rather than decorating the bar.
   *
   * `applyFromGuest` persists the update and enqueues it BEFORE it advances the
   * owned doc, so by the time `onLocalUpdate` fires everything the host has
   * RECEIVED is already durable. What that says nothing about is the ~24 ms
   * batch still inside the WebView, which is why the indicator only returns to
   * `Saved` once a `flush()` that no later update overtook has resolved — the
   * same round trip the background transition relies on.
   */
  useEffect(() => {
    if (!doc || gate !== 'editing') return
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = doc.onLocalUpdate(() => {
      localUpdates.current += 1
      setSaveState('saving')
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const seen = localUpdates.current
        const settled = controls.current?.flush()
        // No controls means no way to prove the WebView has handed everything
        // over, and an unprovable `Saved` is worse than no indicator at all.
        if (!settled) return
        void settled.then(() => {
          if (localUpdates.current === seen) setSaveState('saved')
        })
      }, SAVE_SETTLE_MS)
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsubscribe()
    }
  }, [doc, gate])

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
      // The guest applies this live (`mounted.editor.isEditable = !cfg.readOnly`),
      // so read↔edit is a prop flip on the running WebView — no remount, and no
      // second renderer for the reading surface.
      readOnly: gate !== 'editing'
    }),
    [gate, scheme]
  )

  const onNavigate = useCallback(
    (target: string) => {
      if (!session) return
      void (async () => {
        const noteId = await resolveWikiTarget(session.db, target)
        if (noteId) router.push(`/(vault)/(tabs)/notes/${noteId}`)
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
      applyRecord(await readNoteRecord(ctx.db, id))
      // The editor owns the block structure; the host only names the reference
      // and its type, so a PDF becomes a file block rather than a broken image.
      controls.current?.insertAttachment(result.ref, result.filename, result.mimeType)
    },
    [applyRecord, ctx, id, session]
  )

  const finishEditing = useCallback(() => {
    void (async () => {
      try {
        await controls.current?.flush()
        setSaveState('saved')
      } finally {
        setMode('read')
      }
    })().catch((err: unknown) => {
      log.warn('Flushing on Done failed', {
        error: err instanceof Error ? err.message : String(err)
      })
    })
  }, [])

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
  const folderSegments = (payload?.folderPath ?? '').split('/').filter((part) => part.length > 0)
  const parentFolder = folderSegments[folderSegments.length - 1] ?? 'Notes'
  const editedAt = toEpochMs(payload?.modifiedAt, updatedAt)

  const readActions: NavBarAction[] = [
    // Never offered on a locked vault: the mode flip could not produce an
    // editable surface there, only an editor that refuses every keystroke.
    ...(gate === 'reading'
      ? [{ text: 'Edit', label: 'Edit', onPress: () => setMode('edit') }]
      : []),
    { icon: 'more', label: 'More', onPress: () => setManaging(true) }
  ]

  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: c.canvas.background }]}
      edges={['top', 'left', 'right']}
    >
      <Stack.Screen options={{ headerShown: false }} />

      {gate === 'editing' ? (
        <View style={[styles.editNav, { borderBottomColor: c.line.border }]}>
          <View style={styles.saveSlot}>
            <Icon
              name={saveState === 'saved' ? 'check' : 'sync'}
              size={18}
              color={c.text.secondary}
            />
            <AppText variant="footnote" color={c.text.secondary} style={styles.saveLabel}>
              {saveState === 'saved' ? 'Saved' : 'Saving…'}
            </AppText>
          </View>
          <View style={styles.doneSlot}>
            {/* Board 29 draws no `···` here, but board 30's editor toolbar is
                unbuilt and this is the only way to reach undo, redo and the
                insert buttons while editing. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="More"
              hitSlop={10}
              onPress={() => setManaging(true)}
            >
              <Icon name="more" size={24} color={c.text.primary} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Done"
              hitSlop={10}
              onPress={finishEditing}
            >
              <AppText variant="body" color={c.tint.base} style={styles.doneLabel}>
                Done
              </AppText>
            </Pressable>
          </View>
        </View>
      ) : (
        // `NavBarInline` carries no bottom border of its own, so board 28's is
        // added here the way the folder screen adds board 27's. The bar's title
        // is empty because the serif heading below IS the title.
        <View style={[styles.navBorder, { borderBottomColor: c.line.border }]}>
          <NavBarInline
            title=""
            back={{ label: parentFolder, onPress: () => router.back() }}
            actions={readActions}
          />
        </View>
      )}

      {gate === 'locked' ? (
        <ThemedView style={styles.banner}>
          <ThemedText type="small">
            Read-only right now. Your edits stay on this device and sync when writing is available
            again.
          </ThemedText>
        </ThemedView>
      ) : null}

      {/* Board 28 draws this block at `padding-inline: 20`. It is 16 here
          because the WebView below is `padding-inline: 16px`
          (editor-web/src/styles.css), and at 20 the native title sits 4pt right
          of the prose it titles. */}
      <View style={styles.header}>
        <AppText variant="serifTitle">{title}</AppText>
        {gate === 'editing' ? null : (
          <View style={styles.metaRow}>
            {/* Board 28 draws these 24pt tall. The shipped chip is 26, and one
                board does not outrank a primitive every other screen uses. */}
            {(payload?.tags ?? []).map((tag) => (
              <Chip key={tag} label={tag} variant="tag" />
            ))}
            {editedAt > 0 ? (
              <AppText variant="caption" color={c.text.secondary}>
                {`Edited ${editedRelative(editedAt, readAt)}`}
              </AppText>
            ) : null}
          </View>
        )}
      </View>

      {showMeta ? (
        <ScrollView style={styles.meta} contentContainerStyle={styles.metaContent}>
          <View style={styles.insertRow}>
            <HeaderButton label="Close details" onPress={() => setShowMeta(false)} />
          </View>
          {/* `gate === 'locked'`, not `!== 'editing'`: tags and properties are
              metadata, not body, and reading the note is no reason to freeze
              them. Only the vault's own read-only state is. */}
          <NoteTags
            ctx={ctx}
            noteId={id}
            tags={payload?.tags ?? []}
            readOnly={gate === 'locked'}
            onChanged={(tags) => setPayload((prev) => (prev ? { ...prev, tags } : prev))}
          />
          <NoteProperties
            ctx={ctx}
            noteId={id}
            properties={payload?.properties ?? {}}
            readOnly={gate === 'locked'}
            onChanged={(properties) =>
              setPayload((prev) => (prev ? { ...prev, properties } : prev))
            }
          />
          <View style={styles.insertRow}>
            <HeaderButton label="Undo" onPress={() => controls.current?.undo()} />
            <HeaderButton label="Redo" onPress={() => controls.current?.redo()} />
          </View>
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
        onOpenDetails={() => setShowMeta(true)}
        onChanged={() => {
          if (session) void readNoteRecord(session.db, id).then(applyRecord)
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
  navBorder: { borderBottomWidth: 1 },
  editNav: {
    height: sizes.navBar,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: sizes.gutter,
    borderBottomWidth: 1
  },
  saveSlot: {
    width: EDIT_NAV_SLOT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s6
  },
  saveLabel: { lineHeight: 16 },
  doneSlot: {
    width: EDIT_NAV_SLOT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: EDIT_NAV_GAP
  },
  doneLabel: { fontFamily: fontFamilies.sansSemiBold },
  header: { paddingTop: space.s20, paddingHorizontal: sizes.gutter, gap: HEADER_GAP },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.s8 },
  headerButton: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
  banner: { paddingHorizontal: Spacing.three, paddingVertical: Spacing.two },
  meta: { maxHeight: 260 },
  metaContent: { padding: Spacing.three, gap: Spacing.two },
  insertRow: { flexDirection: 'row', gap: Spacing.three },
  metrics: { fontFamily: 'Menlo', fontSize: 11 }
})

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, AppState, Pressable, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'
import type { BridgeCfg } from '@memry/contracts/webview-bridge'
import { AppText } from '@/components/ui/app-text'
import { Icon } from '@/components/ui/icon'
import { NavBarInline } from '@/components/ui/nav-bar'
import { EditorView, type EditorControls } from '@/editor/editor-view'
import { formatG3Report } from '@/editor/__rig__/latency'
import { beginTrace, mark } from '@/editor/__rig__/open-trace'
import type { OpenDoc } from '@/editor/doc-manager'
import { getEditorSession, type EditorSession } from '@/editor/session'
import { queryWikiCandidates, resolveWikiTarget } from '@/editor/wiki-links'
import { insertAttachment, pickDocument, pickImage } from '@/features/attachments/insert'
import { resolveAsset } from '@/features/attachments/resolve'
import { AddPropertySheet } from '@/features/notes/add-property-sheet'
import { AddTagSheet } from '@/features/notes/add-tag-sheet'
import { editGate } from '@/features/notes/edit-gate'
import { NoteManageSheet } from '@/features/notes/manage'
import {
  addTag,
  clearPendingSeed,
  materializedBody,
  readNoteRecord,
  resolveSeedMarkdown,
  setNoteProperty,
  setNoteTags,
  shouldSeedFromMarkdown,
  type MobilePropertyType,
  type NoteOpsContext,
  type NotePayload,
  type NoteRecord
} from '@/features/notes/note-ops'
import { NoteProperties } from '@/features/notes/properties'
import { propertyTypes } from '@/features/notes/property-types'
import { NoteTags } from '@/features/notes/tags'
import { useColorScheme } from '@/hooks/use-color-scheme'
import { extractErrorMessage } from '@/lib/errors'
import { createLogger } from '@/lib/logger'
import { loadCurrentVaultId } from '@/sync/auth-client'
import { ensureNoteBody } from '@/sync/body-fetch'
import { getSyncEngine } from '@/sync/engine'
import { subscribeReadOnly } from '@/sync/read-only-mode'
import { sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

const log = createLogger('NoteScreen')

// Board 32's stack gap. 14 is not on the space scale, and one screen does not
// earn a new step on it.
const BODY_GAP = 14

/**
 * How long the editor must be quiet before `Saved` is claimed.
 *
 * Long enough that a flush is not fired between two keystrokes, short enough
 * that a pause reads as saved rather than as a stuck indicator.
 */
const SAVE_SETTLE_MS = 800

/**
 * The note editor (boards 28, 32 and 33). Journals open through the same
 * screen.
 *
 * The Y.Doc is opened by the doc manager and handed to the WebView; this screen
 * owns only the things around it — the nav bar, the title, the inline metadata
 * and the flush on background transition (T076).
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
  const [vaultReadOnly, setVaultReadOnly] = useState(false)
  const [saveState, setSaveState] = useState<'saved' | 'saving'>('saved')
  const [managing, setManaging] = useState(false)
  const [tagsEditing, setTagsEditing] = useState(false)
  const [addingTag, setAddingTag] = useState(false)
  const [addingProperty, setAddingProperty] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const controls = useRef<EditorControls | null>(null)
  const localUpdates = useRef(0)

  useEffect(() => subscribeReadOnly((state) => setVaultReadOnly(state.readOnly)), [])

  const gate = editGate({ vaultReadOnly })

  const applyRecord = useCallback((record: NoteRecord | null) => {
    setPayload(record?.payload ?? null)
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
    if (id) beginTrace(id)
    let cancelled = false
    void (async () => {
      if (!id) return
      const vaultId = await loadCurrentVaultId()
      if (!vaultId || cancelled) return

      const editorSession = await getEditorSession(vaultId)
      mark(id, 'sessionReady')
      const openDoc = await editorSession.docs.openDoc(id)
      mark(id, 'docOpen')
      const record = await readNoteRecord(editorSession.db, id)
      mark(id, 'recordRead')
      const seed = openDoc.isEmpty() ? await resolveSeedMarkdown(editorSession.db, id) : undefined
      mark(id, 'seedResolved')

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
      // so the note is editable from the first frame and only a locked vault
      // takes that away.
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

  const tags = payload?.tags ?? []
  const properties = payload?.properties ?? {}

  const pickTag = (tag: string): void => {
    setAddingTag(false)
    const next = addTag(tags, tag)
    if (next === tags) return
    setPayload((prev) => (prev ? { ...prev, tags: next } : prev))
    if (ctx && id) void setNoteTags(ctx, id, next)
  }

  const createProperty = (name: string, type: MobilePropertyType): void => {
    setAddingProperty(false)
    const value = propertyTypes[type].emptyValue
    setPayload((prev) => (prev ? { ...prev, properties: { ...properties, [name]: value } } : prev))
    if (ctx && id) void setNoteProperty(ctx, id, name, value)
  }

  if (loadError) {
    return (
      <SafeAreaView
        style={[styles.safe, { backgroundColor: c.canvas.background }]}
        edges={['left', 'right']}
      >
        <View style={styles.center}>
          <AppText variant="footnote" color={c.text.secondary}>
            {loadError}
          </AppText>
        </View>
      </SafeAreaView>
    )
  }

  if (!doc || !id) {
    return (
      <SafeAreaView
        style={[styles.safe, { backgroundColor: c.canvas.background }]}
        edges={['left', 'right']}
      >
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      </SafeAreaView>
    )
  }

  const title = payload?.title ?? 'Untitled'
  const folderSegments = (payload?.folderPath ?? '').split('/').filter((part) => part.length > 0)
  const parentFolder = folderSegments[folderSegments.length - 1] ?? 'Notes'

  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: c.canvas.background }]}
      edges={['left', 'right']}
    >
      {/* `NavBarInline` carries no bottom border of its own, so board 28's is
          added here the way the folder screen adds board 27's. The bar's title
          is empty because the display heading below IS the title. */}
      <View style={[styles.navBorder, { borderBottomColor: c.line.border }]}>
        <NavBarInline
          title=""
          back={{ label: parentFolder, onPress: () => router.back() }}
          center={
            <View style={styles.saveSlot}>
              <Icon
                name={saveState === 'saved' ? 'check' : 'sync'}
                size={18}
                color={c.text.secondary}
              />
              <AppText variant="footnote" color={c.text.secondary}>
                {saveState === 'saved' ? 'Saved' : 'Saving…'}
              </AppText>
            </View>
          }
          actions={[{ icon: 'more', label: 'More', onPress: () => setManaging(true) }]}
        />
      </View>

      {gate === 'locked' ? (
        <View style={styles.banner}>
          <AppText variant="footnote" color={c.text.secondary}>
            Read-only right now. Your edits stay on this device and sync when writing is available
            again.
          </AppText>
        </View>
      ) : null}

      {/* Board 32 draws this block at `padding-inline: 20`. It is 16 here
          because the WebView below is `padding-inline: 16px`
          (editor-web/src/styles.css), and at 20 the native title sits 4pt right
          of the prose it titles. */}
      <Pressable style={styles.body} onPress={() => setTagsEditing(false)}>
        <AppText variant="noteTitle">{title}</AppText>
        {/* `gate === 'locked'`, not the editor's own state: tags and properties
            are metadata, not body, and reading the note is no reason to freeze
            them. Only the vault's own read-only state is. */}
        <NoteTags
          ctx={ctx}
          noteId={id}
          tags={tags}
          readOnly={gate === 'locked'}
          editing={tagsEditing}
          onEditingChange={setTagsEditing}
          onAdd={() => setAddingTag(true)}
          onChanged={(next) => setPayload((prev) => (prev ? { ...prev, tags: next } : prev))}
        />
        <NoteProperties
          ctx={ctx}
          noteId={id}
          properties={properties}
          readOnly={gate === 'locked'}
          onChanged={(next) => setPayload((prev) => (prev ? { ...prev, properties: next } : prev))}
          onAddProperty={() => setAddingProperty(true)}
          onAddTag={() => setAddingTag(true)}
          onInteract={() => setTagsEditing(false)}
        />
      </Pressable>

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

      <AddTagSheet
        visible={addingTag}
        db={session?.db ?? null}
        existing={tags}
        onClose={() => setAddingTag(false)}
        onPick={pickTag}
      />

      <AddPropertySheet
        visible={addingProperty}
        existingNames={Object.keys(properties)}
        onClose={() => setAddingProperty(false)}
        onCreate={createProperty}
      />

      <NoteManageSheet
        visible={managing}
        ctx={ctx}
        noteId={id}
        title={title}
        folderPath={payload?.folderPath ?? ''}
        onClose={() => setManaging(false)}
        editor={{
          undo: () => controls.current?.undo(),
          redo: () => controls.current?.redo(),
          insert: (kind) => void onInsert(kind),
          measure: () =>
            controls.current ? formatG3Report(controls.current.measure()) : 'editor not ready',
          resetMeasurement: () => controls.current?.resetMeasurement()
        }}
        onChanged={() => {
          if (session) void readNoteRecord(session.db, id).then(applyRecord)
        }}
        onDeleted={() => router.back()}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  navBorder: { borderBottomWidth: 1 },
  saveSlot: { flexDirection: 'row', alignItems: 'center', gap: space.s6 },
  banner: { paddingHorizontal: sizes.gutter, paddingVertical: space.s8 },
  body: { paddingTop: space.s16, paddingHorizontal: sizes.gutter, gap: BODY_GAP }
})

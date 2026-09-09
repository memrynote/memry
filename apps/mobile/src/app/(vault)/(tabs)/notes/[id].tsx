import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Animated, AppState, Share, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'
import type { BridgeCfg, EditorAttachmentBlockType } from '@memry/contracts/webview-bridge'
import { AppText } from '@/components/ui/app-text'
import { Icon } from '@/components/ui/icon'
import { NavBarInline } from '@/components/ui/nav-bar'
import { PromptDialog } from '@/components/ui/prompt-dialog'
import { EditorView, type EditorControls } from '@/editor/editor-view'
import { beginTrace, mark } from '@/editor/__rig__/open-trace'
import type { OpenDoc } from '@/editor/doc-manager'
import { getEditorSession, type EditorSession } from '@/editor/session'
import { queryWikiCandidates, resolveWikiTarget } from '@/editor/wiki-links'
import { insertAttachment, pickDocument, pickImage } from '@/features/attachments/insert'
import { resolveAsset } from '@/features/attachments/resolve'
import { AddPropertySheet } from '@/features/notes/add-property-sheet'
import { AddTagSheet } from '@/features/notes/add-tag-sheet'
import { readBookmarkKeys, toggleBookmark } from '@/features/notes/bookmarks'
import { NoteFooter } from '@/features/notes/chrome/note-footer'
import { NoteMoreSheet } from '@/features/notes/chrome/note-more-sheet'
import { QuickOpenModal } from '@/features/notes/chrome/quick-open-modal'
import { editGate } from '@/features/notes/edit-gate'
import { MoveSheet } from '@/features/notes/move-sheet'
import {
  addTag,
  clearPendingSeed,
  createNote,
  deleteNote,
  duplicateNote,
  materializedBody,
  readNoteRecord,
  renameNote,
  resolveSeedMarkdown,
  setNoteProperty,
  setNoteTags,
  shouldSeedFromMarkdown,
  type MobilePropertyType,
  type NoteOpsContext,
  type NotePayload,
  type NoteRecord
} from '@/features/notes/note-ops'
import { readNotesSnapshot, type NotesSnapshot } from '@/features/notes/notes-repo'
import { NoteProperties } from '@/features/notes/properties'
import { propertyTypes } from '@/features/notes/property-types'
import { NoteTags } from '@/features/notes/tags'
import { useWorkspaceTabs } from '@/features/workspace-tabs/provider'
import { WorkspaceTabsModal } from '@/features/workspace-tabs/workspace-tabs-modal'
import { extractErrorMessage } from '@/lib/errors'
import { createLogger } from '@/lib/logger'
import { loadCurrentVaultId } from '@/sync/auth-client'
import { ensureNoteBody } from '@/sync/body-fetch'
import { getSyncEngine } from '@/sync/engine'
import { getReadOnlyState, subscribeReadOnly } from '@/sync/read-only-mode'
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

function showFailure(action: string, error: unknown): void {
  const message = extractErrorMessage(error, 'That could not be completed.')
  log.error(`${action} failed`, { error: message })
  Alert.alert(`${action} failed`, message)
}

type NoteOverlay =
  | { kind: 'none' }
  | { kind: 'quick-open' }
  | { kind: 'more' }
  | { kind: 'rename' }
  | { kind: 'move'; snapshot: NotesSnapshot }

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
  const c = useColors()
  const {
    tabs: openTabs,
    register: registerTab,
    open: openTab,
    close: closeTab,
    setVisible: setTabsVisible
  } = useWorkspaceTabs()

  const [session, setSession] = useState<EditorSession | null>(null)
  const [doc, setDoc] = useState<OpenDoc | null>(null)
  const [payload, setPayload] = useState<NotePayload | null>(null)
  // The markdown body as the pull path materialized it. Only ever used to seed
  // a doc that has no CRDT state, so it cannot overwrite real content.
  const [seedMarkdown, setSeedMarkdown] = useState<string | undefined>(undefined)
  const [vaultReadOnly, setVaultReadOnly] = useState(false)
  const [saveState, setSaveState] = useState<'saved' | 'saving'>('saved')
  const [overlay, setOverlay] = useState<NoteOverlay>({ kind: 'none' })
  const [keyboardVisible, setKeyboardVisible] = useState<boolean | null>(null)
  const [editorPanelOpen, setEditorPanelOpen] = useState(false)
  const [bookmarked, setBookmarked] = useState(false)
  const [addingTag, setAddingTag] = useState(false)
  const [addingProperty, setAddingProperty] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [headerHeight, setHeaderHeight] = useState(0)
  /**
   * Where the WebView's document is scrolled to, driven from the guest.
   *
   * The header floats OVER the editor, so this is the only way it can move with
   * the body: the reader is scrolling a document this side does not own, and
   * there is no native scroll view under the header to attach it to.
   */
  const [scrollY] = useState(() => new Animated.Value(0))
  const controls = useRef<EditorControls | null>(null)
  const localUpdates = useRef(0)
  const currentIdRef = useRef(id)
  const currentDocRef = useRef(doc)

  useEffect(() => {
    currentIdRef.current = id
    currentDocRef.current = doc
  }, [doc, id])

  useEffect(() => subscribeReadOnly((state) => setVaultReadOnly(state.readOnly)), [])

  const gate = editGate({ vaultReadOnly })
  const writable = gate === 'editing'

  const allowMutation = useCallback((action: string): boolean => {
    if (!getReadOnlyState().readOnly) return true
    Alert.alert('Read-only right now', `${action} is disabled until writing is available again.`)
    return false
  }, [])

  const applyRecord = useCallback((record: NoteRecord | null) => {
    setPayload(record?.payload ?? null)
  }, [])

  useEffect(() => {
    if (!id || !payload) return
    registerTab({ id, title: payload.title ?? 'Untitled' })
  }, [id, payload, registerTab])

  useEffect(() => {
    if (!id || !session) return
    let cancelled = false
    void readBookmarkKeys(session.db).then((keys) => {
      if (!cancelled) setBookmarked(keys.has(`note:${id}`))
    })
    return () => {
      cancelled = true
    }
  }, [id, session])

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
      // Constant, not the device scheme (#2033). The guest HAS a dark
      // palette; the app does not — `useColors()` returns the white theme on
      // any device — so following the scheme here painted a near-black page
      // inside white chrome. When a real RN dark palette lands, this is one of
      // the two sites that re-wires (`app/_layout.tsx` is the other).
      theme: 'light',
      locale: 'en',
      // RTL follows the app's own layout direction, which is what the shared
      // logical-property CSS is written against.
      rtl: false,
      reducedMotion: false,
      // The guest applies this live (`mounted.editor.isEditable = !cfg.readOnly`),
      // so the note is editable from the first frame and only a locked vault
      // takes that away.
      readOnly: gate !== 'editing',
      // The document starts below the floating header rather than behind it.
      // Measured, not assumed: tags and properties wrap, so this block's height
      // is the note's own and changes while the reader edits it.
      headerHeight
    }),
    [gate, headerHeight]
  )

  /**
   * How far the header has been pushed off the top: exactly the document's own
   * scroll offset, negated.
   *
   * No `diffClamp`, no collapse behaviour. The title, the tags and the
   * properties are the first rows of the note, not chrome, so they leave the
   * top with the paragraph beside them and come back only when the reader is
   * back at the top of the document. Nothing here is pinned.
   *
   * Unbounded on purpose — the slot this is drawn in is only as tall as the
   * header and clips (`EditorView`'s `chrome` style), so travel past its own
   * height is simply out of sight.
   */
  const headerOffset = useMemo(() => Animated.multiply(scrollY, -1), [scrollY])

  const onNavigate = useCallback(
    (target: string) => {
      if (!session) return
      void (async () => {
        const noteId = await resolveWikiTarget(session.db, target)
        if (noteId) {
          const record = await readNoteRecord(session.db, noteId)
          openTab({ id: noteId, title: record?.payload.title ?? 'Untitled' })
        }
        // A link with no target is a real state (the note has not been created
        // yet), not an error — the desktop shows the same nothing-happens.
      })()
    },
    [openTab, session]
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
    async (request: { blockType: EditorAttachmentBlockType; referenceBlockId?: string }) => {
      const sourceId = id
      const sourceDoc = doc
      const sourceControls = controls.current
      const sourceCtx = ctx
      const sourceSession = session
      if (
        !sourceCtx ||
        !sourceSession ||
        !sourceId ||
        !sourceDoc ||
        !sourceControls ||
        !allowMutation('Adding attachments')
      )
        return
      const picked = request.blockType === 'image' ? await pickImage() : await pickDocument()
      if (!picked) return
      if (
        currentIdRef.current !== sourceId ||
        currentDocRef.current !== sourceDoc ||
        controls.current !== sourceControls ||
        !allowMutation('Adding attachments')
      )
        return
      const result = await insertAttachment(sourceCtx, sourceSession.attachments, sourceId, picked)
      if (!result) return
      if (
        currentIdRef.current !== sourceId ||
        currentDocRef.current !== sourceDoc ||
        controls.current !== sourceControls
      )
        return
      const nextRecord = await readNoteRecord(sourceCtx.db, sourceId)
      if (
        currentIdRef.current !== sourceId ||
        currentDocRef.current !== sourceDoc ||
        controls.current !== sourceControls
      )
        return
      applyRecord(nextRecord)
      // The editor owns the block structure; the host only names the reference
      // and its type, so a PDF becomes a file block rather than a broken image.
      sourceControls.insertAttachment(
        result.ref,
        result.filename,
        result.mimeType,
        request.blockType,
        request.referenceBlockId
      )
    },
    [allowMutation, applyRecord, ctx, doc, id, session]
  )

  const refreshRecord = useCallback(() => {
    if (session && id) void readNoteRecord(session.db, id).then(applyRecord)
  }, [applyRecord, id, session])

  const openQuickNote = useCallback(
    (note: { id: string; title: string }) => {
      setOverlay({ kind: 'none' })
      openTab(note)
    },
    [openTab]
  )

  const createQuickNote = useCallback(
    async (title: string) => {
      if (!ctx || !allowMutation('Creating notes')) return
      try {
        const noteId = await createNote(ctx, { title })
        setOverlay({ kind: 'none' })
        openTab({ id: noteId, title: title.trim() || 'Untitled' })
      } catch (error) {
        showFailure('Create note', error)
      }
    },
    [allowMutation, ctx, openTab]
  )

  const openMove = useCallback(async () => {
    if (!session || !allowMutation('Moving notes')) return
    setOverlay({ kind: 'none' })
    try {
      const snapshot = await readNotesSnapshot(session.db)
      setOverlay({ kind: 'move', snapshot })
    } catch (error) {
      showFailure('Move note', error)
    }
  }, [allowMutation, session])

  const runBookmark = useCallback(async () => {
    if (!ctx || !id || !allowMutation('Changing bookmarks')) return
    setOverlay({ kind: 'none' })
    try {
      await toggleBookmark(ctx, 'note', id, bookmarked)
      setBookmarked(!bookmarked)
    } catch (error) {
      showFailure('Bookmark', error)
    }
  }, [allowMutation, bookmarked, ctx, id])

  const runDuplicate = useCallback(async () => {
    if (!ctx || !id || !allowMutation('Duplicating notes')) return
    setOverlay({ kind: 'none' })
    try {
      const editor = controls.current
      if (!editor || !doc) throw new Error('The editor is not ready yet')
      await editor.flush()
      const body = await editor.exportMarkdown()
      if (!allowMutation('Duplicating notes')) return
      const newId = await duplicateNote(ctx, id, { body, crdtState: doc.encodeState() })
      if (!newId) return
      const record = await readNoteRecord(ctx.db, newId)
      openTab({ id: newId, title: record?.payload.title ?? 'Untitled copy' })
    } catch (error) {
      showFailure('Duplicate note', error)
    }
  }, [allowMutation, ctx, doc, id, openTab])

  const runShare = useCallback(async () => {
    if (!ctx || !id) return
    setOverlay({ kind: 'none' })
    try {
      const editor = controls.current
      if (!editor) throw new Error('The editor is not ready yet')
      const body = await editor.exportMarkdown()
      const title = payload?.title ?? 'Untitled'
      await Share.share({ title, message: `# ${title}\n\n${body}` })
    } catch (error) {
      showFailure('Share', error)
    }
  }, [ctx, id, payload])

  const confirmDelete = useCallback(() => {
    if (!ctx || !id || !allowMutation('Deleting notes')) return
    const title = payload?.title ?? 'Untitled'
    setOverlay({ kind: 'none' })
    Alert.alert(
      `Delete “${title}”?`,
      'The note is removed here and on every synced device. Links pointing at it will break.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            if (!allowMutation('Deleting notes')) return
            void (async () => {
              // Drain the guest before writing the tombstone. A late body
              // update newer than the delete can otherwise resurrect it.
              const editor = controls.current
              const deletingDoc = doc
              if (!editor || !deletingDoc) throw new Error('The editor is not ready yet')
              await editor.flush()
              if (!allowMutation('Deleting notes')) return
              deletingDoc.setWritable(false)
              try {
                await deleteNote(ctx, id)
              } catch (error) {
                deletingDoc.setWritable(true)
                throw error
              }
              const tab = openTabs.find((candidate) => candidate.destination.noteId === id)
              if (tab) closeTab(tab.id)
              else router.replace('/notes')
            })().catch((error: unknown) => showFailure('Delete note', error))
          }
        }
      ]
    )
  }, [allowMutation, closeTab, ctx, doc, id, openTabs, payload])

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

  if (!doc || !id || !session) {
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
          actions={[{ icon: 'more', label: 'More', onPress: () => setOverlay({ kind: 'more' }) }]}
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

      <EditorView
        doc={doc}
        cfg={cfg}
        onNavigate={onNavigate}
        onWikiQuery={onWikiQuery}
        onAssetRequest={onAssetRequest}
        onInsertRequest={(request) => void onInsert(request)}
        onKeyboardVisibilityChange={setKeyboardVisible}
        onPanelVisibilityChange={setEditorPanelOpen}
        onScroll={(y) => scrollY.setValue(y)}
        // Handed over rather than rendered here. It has to paint ON TOP of the
        // WebView, and the WebView is a sibling of this whole stack — a header
        // in this tree draws under it whatever its `zIndex` says. The document
        // reserves `headerHeight` of top padding for it, so it covers paper at
        // rest and scrolls off with the body rather than clipping it.
        chrome={
          <Animated.View
            onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}
            style={[
              // Opaque, because the body now runs UNDER it: a translucent
              // header would show the prose passing behind the title.
              { backgroundColor: c.canvas.background },
              { transform: [{ translateY: headerOffset }] }
            ]}
          >
            {/* Board 32 draws this block at `padding-inline: 20`. It is 16 here
                because the WebView below is `padding-inline: 16px`
                (editor-web/src/styles.css), and at 20 the native title sits 4pt
                right of the prose it titles. */}
            <View style={styles.body}>
              <AppText variant="noteTitle">{title}</AppText>
              {/* `gate === 'locked'`, not the editor's own state: tags and
                  properties are metadata, not body, and reading the note is no
                  reason to freeze them. Only the vault's own read-only state
                  is. */}
              <NoteTags
                ctx={ctx}
                noteId={id}
                tags={tags}
                readOnly={gate === 'locked'}
                onOpenTag={(tag) => router.push(`/notes/tag?name=${encodeURIComponent(tag)}`)}
                onChanged={(next) => setPayload((prev) => (prev ? { ...prev, tags: next } : prev))}
              />
              <NoteProperties
                ctx={ctx}
                noteId={id}
                properties={properties}
                readOnly={gate === 'locked'}
                onChanged={(next) =>
                  setPayload((prev) => (prev ? { ...prev, properties: next } : prev))
                }
                onAddProperty={() => setAddingProperty(true)}
                onAddTag={() => setAddingTag(true)}
              />
            </View>
          </Animated.View>
        }
        // Handed over for the same reason the header is: it floats over the
        // WebView, and the WebView is a sibling of this whole stack.
        footer={
          keyboardVisible === false && !editorPanelOpen ? (
            <NoteFooter
              tabCount={Math.max(1, openTabs.length)}
              onFind={() => controls.current?.openFind()}
              onQuickOpen={() => setOverlay({ kind: 'quick-open' })}
              onTabs={() => setTabsVisible(true)}
              onMore={() => setOverlay({ kind: 'more' })}
            />
          ) : null
        }
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

      <QuickOpenModal
        visible={overlay.kind === 'quick-open'}
        db={session.db}
        currentNote={{ title, ...(payload?.content ? { excerpt: payload.content } : {}) }}
        canCreate={writable}
        onClose={() => setOverlay({ kind: 'none' })}
        onOpen={openQuickNote}
        onCreate={(nextTitle) => void createQuickNote(nextTitle)}
      />

      <WorkspaceTabsModal
        onNewTab={() => {
          setOverlay({ kind: 'quick-open' })
        }}
      />

      <NoteMoreSheet
        visible={overlay.kind === 'more'}
        title={title}
        bookmarked={bookmarked}
        readOnly={!writable}
        onClose={() => setOverlay({ kind: 'none' })}
        onToggleBookmark={() => void runBookmark()}
        onRename={() => setOverlay({ kind: 'rename' })}
        onMove={() => void openMove()}
        onDuplicate={() => void runDuplicate()}
        onShare={() => void runShare()}
        onDelete={confirmDelete}
      />

      <PromptDialog
        visible={overlay.kind === 'rename'}
        title="Rename note"
        initialValue={title}
        confirmLabel="Rename"
        onCancel={() => setOverlay({ kind: 'none' })}
        onConfirm={(nextTitle) => {
          setOverlay({ kind: 'none' })
          if (!ctx || !allowMutation('Renaming notes')) return
          void renameNote(ctx, id, nextTitle)
            .then(refreshRecord)
            .catch((error: unknown) => {
              showFailure('Rename note', error)
            })
        }}
      />

      {overlay.kind === 'move' ? (
        <MoveSheet
          visible
          ctx={writable ? ctx : null}
          target={{ kind: 'note', id, folderPath: payload?.folderPath ?? '' }}
          snapshot={overlay.snapshot}
          onClose={() => setOverlay({ kind: 'none' })}
          onMoved={() => {
            setOverlay({ kind: 'none' })
            refreshRecord()
          }}
        />
      ) : null}
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

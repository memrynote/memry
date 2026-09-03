import { useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'

import { AppText } from '@/components/ui/app-text'
import { FAB } from '@/components/ui/fab'
import { NavBarInline } from '@/components/ui/nav-bar'
import { SwipeRow } from '@/components/ui/swipe-row'
import { TreeRow, TreeSectionHeader } from '@/components/ui/tree-row'
import { openVaultDb } from '@/db/index'
import { getEditorSession } from '@/editor/session'
import { resolveIcon } from '@/features/notes/icon-value'
import { createNote, type NoteOpsContext } from '@/features/notes/note-ops'
import { folderTarget, noteSwipeActions, noteTarget, useRowMenu } from '@/features/notes/row-menu'
import { readNotesSnapshot, readSortMode, type NotesSnapshot } from '@/features/notes/notes-repo'
import {
  buildFolderTree,
  findFolder,
  flattenFolderTree,
  MOBILE_SORT_DEFAULT,
  NOTE_FILE_TYPE_TONE,
  type FolderNode,
  type MobileSortMode,
  type NoteEntry
} from '@/features/notes/tree'
import { createLogger } from '@/lib/logger'
import { loadCurrentVaultId } from '@/sync/auth-client'
import { getSyncEngine } from '@/sync/engine'
import { subscribeReadOnly } from '@/sync/read-only-mode'
import { sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

const log = createLogger('NoteFolderScreen')

const EMPTY_SNAPSHOT: NotesSnapshot = {
  entries: [],
  icons: new Map(),
  customIcons: new Map(),
  folderPaths: new Set(),
  bookmarks: new Set(),
  pendingCount: 0
}
const NOTHING_EXPANDED: ReadonlySet<string> = new Set<string>()

type FolderScreenRow =
  | { kind: 'folders-header' }
  | { kind: 'notes-header'; count: number }
  | { kind: 'folder'; node: FolderNode }
  | { kind: 'note'; note: NoteEntry }

/**
 * One folder (board 27), reached as `/notes/folder?path=<encoded>`.
 *
 * A STATIC route beside the dynamic `[id].tsx`: expo-router prefers the static
 * segment and note ids are UUIDs, so the two never collide. A `[path].tsx`
 * would shred a nested folder path across segments.
 */
export default function NoteFolderScreen() {
  const c = useColors()
  const { path: pathParam } = useLocalSearchParams<{ path?: string }>()
  const path = pathParam ?? ''

  const [snapshot, setSnapshot] = useState<NotesSnapshot>(EMPTY_SNAPSHOT)
  const [sort, setSort] = useState<MobileSortMode>(MOBILE_SORT_DEFAULT)
  const [vaultId, setVaultId] = useState<string | null>(null)
  const [readOnly, setReadOnly] = useState(false)
  const [ctx, setCtx] = useState<NoteOpsContext | null>(null)

  const reload = useCallback(async () => {
    const vid = await loadCurrentVaultId()
    if (!vid) return
    setVaultId(vid)
    const db = await openVaultDb(vid)
    setSnapshot(await readNotesSnapshot(db))
    setSort(await readSortMode(db))
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
    void getEditorSession(vaultId)
      .then((session) =>
        setCtx({
          db: session.db,
          outbox: session.outbox,
          vaultId,
          deviceId: session.deviceId
        })
      )
      .catch((err: unknown) =>
        log.error('Opening the editor session failed', { error: String(err) })
      )
  }, [vaultId])

  const node = useMemo(
    () => findFolder(buildFolderTree(snapshot.entries, snapshot.icons, snapshot.folderPaths), path),
    [snapshot.entries, snapshot.icons, snapshot.folderPaths, path]
  )

  const menu = useRowMenu({
    ctx,
    snapshot,
    readOnly,
    onChanged: () => void reload(),
    onSearchInFolder: (folderPath) =>
      router.push(`/notes/search?path=${encodeURIComponent(folderPath)}`)
  })

  const rows = useMemo<FolderScreenRow[]>(() => {
    if (!node) return []
    // With nothing expanded this emits one row per direct subfolder and then
    // the folder's own notes, already in the list screen's sort order. Sorting
    // here instead would be a second comparator to keep in step with `tree.ts`.
    const flattened = flattenFolderTree(node, { expanded: NOTHING_EXPANDED, sort, query: '' })
    const out: FolderScreenRow[] = []
    const folders = flattened.filter((row) => row.kind === 'folder')
    if (folders.length > 0) {
      out.push({ kind: 'folders-header' })
      for (const row of folders) out.push({ kind: 'folder', node: row.node })
    }
    out.push({ kind: 'notes-header', count: node.notes.length })
    for (const row of flattened) {
      if (row.kind === 'note') out.push({ kind: 'note', note: row.note })
    }
    return out
  }, [node, sort])

  const segments = path.split('/').filter((segment) => segment.length > 0)
  const leaf = segments.length > 0 ? segments[segments.length - 1] : ''
  const title = node?.name || leaf || 'Folder'

  const create = useCallback(async () => {
    if (!vaultId) return
    const session = await getEditorSession(vaultId)
    const ctx = {
      db: session.db,
      outbox: session.outbox,
      vaultId,
      deviceId: session.deviceId
    }
    const noteId = await createNote(ctx, { title: 'Untitled', folderPath: path })
    // Navigate FIRST. `reload()` re-reads the whole note list over the one
    // SQLite connection the bootstrap sync is also using, so awaiting it
    // put an unbounded wait between the tap and the editor — on a vault
    // still seeding, long enough that the offline matrix timed out looking
    // for an editor that had been created but never opened. Nothing on the
    // note screen comes from that list, and `useFocusEffect` reloads the
    // index on the way back, so the await bought nothing.
    router.push(`/notes/${noteId}`)
  }, [vaultId, path])

  return (
    <SafeAreaView
      edges={['left', 'right']}
      style={[styles.safe, { backgroundColor: c.canvas.background }]}
    >
      {/* The board's trailing `···` is dropped: every row in the list screen's
          sheet is either inert here (`Expand all` / `Collapse all`, with no
          expansion state to act on) or wrong (`New from template` creates at
          the vault root, not in this folder). The border is board 27's and
          `NavBarInline` has none, so it is added at this call site. */}
      <View style={[styles.navBorder, { borderBottomColor: c.line.border }]}>
        <NavBarInline
          title={title}
          back={{ label: 'Notes', onPress: () => router.back(), showLabel: false }}
        />
      </View>

      <FlatList
        data={rows}
        keyExtractor={(row) => {
          if (row.kind === 'folder') return `f:${row.node.path}`
          if (row.kind === 'note') return `n:${row.note.id}`
          return row.kind
        }}
        renderItem={({ item }) => {
          switch (item.kind) {
            case 'folders-header':
              return <TreeSectionHeader label="FOLDERS" />
            case 'notes-header':
              return (
                <TreeSectionHeader label={`NOTES — ${item.count}`} style={styles.notesHeader} />
              )
            // Folder rows carry no SWIPE actions — a folder's verbs are a
            // batch over every note beneath it, which is a different change
            // from a note's — but they do carry the long-press menu.
            case 'folder':
              return (
                <TreeRow
                  label={item.node.name}
                  level={0}
                  folder={{ expanded: false }}
                  icon={resolveIcon(item.node.icon, snapshot.customIcons)}
                  count={item.node.noteCount}
                  chevron
                  accessibilityLabel={`Open folder ${item.node.name}`}
                  bookmarked={menu.isBookmarked(folderTarget(item.node.path, item.node.noteCount))}
                  onPress={() =>
                    router.push(`/notes/folder?path=${encodeURIComponent(item.node.path)}`)
                  }
                  onLongPress={(pageY) =>
                    menu.open(folderTarget(item.node.path, item.node.noteCount), pageY)
                  }
                />
              )
            case 'note': {
              const row = (
                <TreeRow
                  label={item.note.title}
                  level={0}
                  icon={resolveIcon(item.note.icon, snapshot.customIcons)}
                  tone={NOTE_FILE_TYPE_TONE[item.note.fileType]}
                  accessibilityLabel={`Open note ${item.note.title}`}
                  bookmarked={menu.isBookmarked(noteTarget(item.note))}
                  onPress={() => router.push(`/notes/${item.note.id}`)}
                  onLongPress={(pageY) => menu.open(noteTarget(item.note), pageY)}
                />
              )
              if (readOnly) return row
              return <SwipeRow actions={noteSwipeActions(item.note, c, menu)}>{row}</SwipeRow>
            }
          }
        }}
        ListEmptyComponent={
          // A folder is a projection of the notes' `folderPath`s, so one really
          // can cease to exist while this screen sits in the stack.
          <AppText variant="footnote" color={c.text.secondary} style={styles.empty}>
            This folder is empty.
          </AppText>
        }
      />

      {readOnly ? null : (
        <FAB onPress={() => void create()} accessibilityLabel="New note" style={styles.fab} />
      )}

      {menu.overlay}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  navBorder: { borderBottomWidth: 1 },
  notesHeader: { marginTop: space.s4 },
  empty: { paddingHorizontal: sizes.gutter, paddingTop: sizes.gutter },
  fab: { position: 'absolute', end: sizes.gutter, bottom: sizes.gutter }
})

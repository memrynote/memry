import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Pressable, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, useFocusEffect } from 'expo-router'

import { AppText } from '@/components/ui/app-text'
import { BottomSheet } from '@/components/ui/bottom-sheet'
import { FAB } from '@/components/ui/fab'
import { Icon, type IconName } from '@/components/ui/icon'
import { SearchField } from '@/components/ui/search-field'
import { TreeRow } from '@/components/ui/tree-row'
import { openVaultDb, type VaultDb } from '@/db/index'
import { getEditorSession } from '@/editor/session'
import {
  createNoteFromTemplate,
  listTemplates,
  type TemplateSummary
} from '@/features/notes/from-template'
import { createNote } from '@/features/notes/note-ops'
import {
  readExpandedFolders,
  readNotesSnapshot,
  readSortMode,
  writeExpandedFolders,
  writeSortMode,
  type NotesSnapshot
} from '@/features/notes/notes-repo'
import { SheetRow, SortSheet } from '@/features/notes/sort-sheet'
import {
  allFolderPaths,
  buildFolderTree,
  flattenFolderTree,
  MOBILE_SORT_DEFAULT,
  NOTE_FILE_TYPE_TONE,
  type MobileSortMode
} from '@/features/notes/tree'
import { loadCurrentVaultId } from '@/sync/auth-client'
import { getSyncEngine } from '@/sync/engine'
import { subscribeReadOnly } from '@/sync/read-only-mode'
import { sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

const EMPTY_SNAPSHOT: NotesSnapshot = { entries: [], icons: new Map(), pendingCount: 0 }

/** The two panes are mutually exclusive, so one value carries both. */
type MoreSheet = 'closed' | 'actions' | 'templates'

/**
 * Notes browse (board 26): the folder tree, the sort sheet and search. Every
 * nesting, counting, ordering and filtering rule lives in `tree.ts` and every
 * query in `notes-repo.ts`; this screen owns state and rows only.
 */
export default function NotesScreen() {
  const c = useColors()
  const [snapshot, setSnapshot] = useState<NotesSnapshot>(EMPTY_SNAPSHOT)
  const [vaultId, setVaultId] = useState<string | null>(null)
  const [db, setDb] = useState<VaultDb | null>(null)
  const [templates, setTemplates] = useState<TemplateSummary[]>([])
  const [readOnly, setReadOnly] = useState(false)
  const [sort, setSort] = useState<MobileSortMode>(MOBILE_SORT_DEFAULT)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [sortOpen, setSortOpen] = useState(false)
  const [moreSheet, setMoreSheet] = useState<MoreSheet>('closed')

  const reload = useCallback(async () => {
    const vid = await loadCurrentVaultId()
    if (!vid) return
    setVaultId(vid)
    const opened = await openVaultDb(vid)
    setDb(opened)
    setSnapshot(await readNotesSnapshot(opened))
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

  const prefsLoaded = useRef(false)
  useEffect(() => {
    // Once, and only once: `reload()` runs on every focus, and re-reading the
    // stored preferences there would undo a change made in this session.
    if (!db || prefsLoaded.current) return
    prefsLoaded.current = true
    void (async () => {
      setSort(await readSortMode(db))
      setExpanded(await readExpandedFolders(db))
    })()
  }, [db])

  const applySort = useCallback(
    (mode: MobileSortMode) => {
      setSort(mode)
      if (db) void writeSortMode(db, mode)
    },
    [db]
  )

  const applyExpanded = useCallback(
    (next: ReadonlySet<string>) => {
      setExpanded(next)
      if (db) void writeExpandedFolders(db, next)
    },
    [db]
  )

  const toggleFolder = useCallback(
    (path: string) => {
      const next = new Set(expanded)
      if (!next.delete(path)) next.add(path)
      applyExpanded(next)
    },
    [expanded, applyExpanded]
  )

  const tree = useMemo(
    () => buildFolderTree(snapshot.entries, snapshot.icons),
    [snapshot.entries, snapshot.icons]
  )
  const rows = useMemo(
    () => flattenFolderTree(tree, { expanded, sort, query }),
    [tree, expanded, sort, query]
  )

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
      // No title for the template path: `createNoteFromTemplate` falls back to
      // the TEMPLATE's name, and passing 'Untitled' defeats that — every note
      // made from a template would be called Untitled and they would all
      // derive the same path.
      const noteId = templateId
        ? await createNoteFromTemplate(ctx, templateId)
        : await createNote(ctx, { title: 'Untitled' })
      if (noteId) {
        // Navigate FIRST. `reload()` re-reads the whole note list over the one
        // SQLite connection the bootstrap sync is also using, so awaiting it
        // put an unbounded wait between the tap and the editor — on a vault
        // still seeding, long enough that the offline matrix timed out looking
        // for an editor that had been created but never opened. Nothing on the
        // note screen comes from that list, and `useFocusEffect` reloads the
        // index on the way back, so the await bought nothing.
        router.push(`/notes/${noteId}`)
      }
    },
    [vaultId]
  )

  const navActions: { icon: IconName; label: string; onPress: () => void }[] = [
    { icon: 'sort', label: 'Sort notes', onPress: () => setSortOpen(true) },
    { icon: 'search', label: 'Search notes', onPress: () => setSearching(true) },
    { icon: 'more', label: 'More actions', onPress: () => setMoreSheet('actions') }
  ]

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safe, { backgroundColor: c.canvas.background }]}
    >
      {searching ? (
        <View style={styles.searchRow}>
          <SearchField
            style={styles.searchField}
            placeholder="Search notes"
            autoFocus
            returnKeyType="search"
            clearButtonMode="while-editing"
            value={query}
            onChangeText={setQuery}
          />
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setQuery('')
              setSearching(false)
            }}
          >
            <AppText color={c.tint.base}>Cancel</AppText>
          </Pressable>
        </View>
      ) : (
        <View style={styles.navRow}>
          {navActions.map((action) => (
            <Pressable
              key={action.label}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              hitSlop={10}
              onPress={action.onPress}
            >
              <Icon name={action.icon} size={24} color={c.text.primary} />
            </Pressable>
          ))}
        </View>
      )}

      {snapshot.pendingCount > 0 ? (
        <AppText variant="footnote" color={c.text.secondary} style={styles.pending}>
          {`${snapshot.pendingCount} more items still syncing…`}
        </AppText>
      ) : null}

      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        renderItem={({ item }) =>
          item.kind === 'folder' ? (
            <TreeRow
              label={item.node.name}
              level={item.level}
              folder={{ expanded: item.expanded, icon: item.node.icon }}
              // Collapsed folders only: an open folder's contents already
              // answer what the count was answering.
              count={item.expanded ? undefined : item.node.noteCount}
              accessibilityLabel={`Open folder ${item.node.name}`}
              onToggle={() => toggleFolder(item.node.path)}
              onPress={() =>
                router.push(`/notes/folder?path=${encodeURIComponent(item.node.path)}`)
              }
            />
          ) : (
            <TreeRow
              label={item.note.title}
              level={item.level}
              tone={NOTE_FILE_TYPE_TONE[item.note.fileType]}
              accessibilityLabel={`Open note ${item.note.title}`}
              onPress={() => router.push(`/notes/${item.note.id}`)}
            />
          )
        }
        ListEmptyComponent={
          <AppText variant="footnote" color={c.text.secondary} style={styles.empty}>
            {query.trim().length > 0
              ? 'No notes match that search.'
              : 'Nothing here yet. Notes appear as the first sync progresses.'}
          </AppText>
        }
      />

      {readOnly ? null : (
        <FAB onPress={() => void create()} accessibilityLabel="New note" style={styles.fab} />
      )}

      <SortSheet
        visible={sortOpen}
        sort={sort}
        onSelect={applySort}
        onClose={() => setSortOpen(false)}
      />

      <BottomSheet
        visible={moreSheet !== 'closed'}
        onClose={() => setMoreSheet('closed')}
        accessibilityLabel={moreSheet === 'templates' ? 'Choose a template' : 'Notes actions'}
      >
        {moreSheet === 'templates' ? (
          templates.map((template) => (
            <SheetRow
              key={template.id}
              label={template.name}
              onPress={() => {
                setMoreSheet('closed')
                void create(template.id)
              }}
            />
          ))
        ) : (
          <>
            <SheetRow
              label="Expand all"
              onPress={() => {
                applyExpanded(new Set(allFolderPaths(tree)))
                setMoreSheet('closed')
              }}
            />
            <SheetRow
              label="Collapse all"
              onPress={() => {
                applyExpanded(new Set())
                setMoreSheet('closed')
              }}
            />
            {/* No `New folder`: a mobile folder is a projection of the notes'
                `folderPath`s, so an empty one cannot exist — see the
                `listFolders` doc comment in `manage.tsx`. */}
            {templates.length > 0 && !readOnly ? (
              <SheetRow label="New from template" onPress={() => setMoreSheet('templates')} />
            ) : null}
          </>
        )}
      </BottomSheet>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  navRow: {
    height: sizes.navBar,
    paddingHorizontal: sizes.gutter,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space.s20
  },
  searchRow: {
    height: sizes.navBar,
    paddingHorizontal: sizes.gutter,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s12
  },
  searchField: { flex: 1 },
  pending: { paddingHorizontal: sizes.gutter, paddingBottom: space.s8 },
  empty: { paddingHorizontal: sizes.gutter, paddingTop: space.s12 },
  fab: { position: 'absolute', end: sizes.gutter, bottom: sizes.gutter }
})

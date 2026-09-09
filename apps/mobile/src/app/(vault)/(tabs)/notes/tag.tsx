import { useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'

import { AppText } from '@/components/ui/app-text'
import { NavBarInline } from '@/components/ui/nav-bar'
import { SwipeRow } from '@/components/ui/swipe-row'
import { TreeRow } from '@/components/ui/tree-row'
import { openVaultDb } from '@/db/index'
import { getEditorSession } from '@/editor/session'
import { resolveIcon } from '@/features/notes/icon-value'
import { readNoteIdsWithTag, type NoteOpsContext } from '@/features/notes/note-ops'
import { readNotesSnapshot, readSortMode, type NotesSnapshot } from '@/features/notes/notes-repo'
import { noteSwipeActions, noteTarget, useRowMenu } from '@/features/notes/row-menu'
import {
  MOBILE_SORT_DEFAULT,
  NOTE_FILE_TYPE_TONE,
  sortNotes,
  type MobileSortMode
} from '@/features/notes/tree'
import { createLogger } from '@/lib/logger'
import { loadCurrentVaultId } from '@/sync/auth-client'
import { getSyncEngine } from '@/sync/engine'
import { subscribeReadOnly } from '@/sync/read-only-mode'
import { sizes } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

const log = createLogger('NoteTagScreen')

const EMPTY_SNAPSHOT: NotesSnapshot = {
  entries: [],
  icons: new Map(),
  customIcons: new Map(),
  folderPaths: new Set(),
  bookmarks: new Set(),
  pendingCount: 0
}

/**
 * Every note carrying one tag, reached as `/notes/tag?name=<encoded>`.
 *
 * A STATIC route beside the dynamic `[id].tsx`, the way `folder.tsx` is: the
 * router prefers the static segment and note ids are UUIDs, so the two never
 * collide. This is what a tag chip on the note screen opens — tapping a tag
 * asks "what else is tagged this", which had no answer on mobile before.
 */
export default function NoteTagScreen() {
  const c = useColors()
  const { name } = useLocalSearchParams<{ name?: string }>()
  const tag = name ?? ''

  const [snapshot, setSnapshot] = useState<NotesSnapshot>(EMPTY_SNAPSHOT)
  const [tagged, setTagged] = useState<ReadonlySet<string>>(() => new Set<string>())
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
    setTagged(await readNoteIdsWithTag(db, tag))
    setSort(await readSortMode(db))
  }, [tag])

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

  const menu = useRowMenu({
    ctx,
    snapshot,
    readOnly,
    onChanged: () => void reload(),
    onSearchInFolder: (folderPath) =>
      router.push(`/notes/search?path=${encodeURIComponent(folderPath)}`)
  })

  // The list screen's own comparator, so a tag list is ordered the way every
  // other note list on the device is.
  const notes = useMemo(
    () =>
      sortNotes(
        snapshot.entries.filter((entry) => tagged.has(entry.id)),
        sort
      ),
    [snapshot.entries, sort, tagged]
  )

  return (
    <SafeAreaView
      edges={['left', 'right']}
      style={[styles.safe, { backgroundColor: c.canvas.background }]}
    >
      <View style={[styles.navBorder, { borderBottomColor: c.line.border }]}>
        <NavBarInline
          title={tag}
          back={{ label: 'Back', onPress: () => router.back(), showLabel: false }}
        />
      </View>

      <FlatList
        data={notes}
        keyExtractor={(note) => note.id}
        renderItem={({ item }) => {
          const row = (
            <TreeRow
              label={item.title}
              level={0}
              icon={resolveIcon(item.icon, snapshot.customIcons)}
              tone={NOTE_FILE_TYPE_TONE[item.fileType]}
              accessibilityLabel={`Open note ${item.title}`}
              bookmarked={menu.isBookmarked(noteTarget(item))}
              onPress={() => router.push(`/notes/${item.id}`)}
              onLongPress={(pageY) => menu.open(noteTarget(item), pageY)}
            />
          )
          if (readOnly) return row
          return <SwipeRow actions={noteSwipeActions(item, c, menu)}>{row}</SwipeRow>
        }}
        ListEmptyComponent={
          <AppText variant="footnote" color={c.text.secondary} style={styles.empty}>
            No notes carry this tag.
          </AppText>
        }
      />

      {menu.overlay}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  navBorder: { borderBottomWidth: 1 },
  empty: { paddingHorizontal: sizes.gutter, paddingTop: sizes.gutter }
})

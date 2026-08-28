import { useCallback, useMemo, useState } from 'react'
import { Alert, FlatList, Modal, Platform, Pressable, StyleSheet, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'

import { AppText } from '@/components/ui/app-text'
import { Icon } from '@/components/ui/icon'
import { SearchField } from '@/components/ui/search-field'
import { TreeRow } from '@/components/ui/tree-row'
import { isUnder, moveFolder, parentPath } from '@/features/notes/folder-ops'
import { moveNote, type NoteOpsContext } from '@/features/notes/note-ops'
import type { NotesSnapshot } from '@/features/notes/notes-repo'
import { resolveIcon, type ResolvedIcon } from '@/features/notes/icon-value'
import { buildFolderTree, findFolder, type FolderNode } from '@/features/notes/tree'
import { extractErrorMessage } from '@/lib/errors'
import { createLogger } from '@/lib/logger'
import { fontFamilies } from '@/theme/fonts'
import { sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

const log = createLogger('MoveSheet')

/**
 * Move a note to a folder (board 35).
 *
 * The destination is a PATH STRING throughout, `''` for the vault root, never
 * a node reference. A folder on mobile is a projection of the notes'
 * `folderPath`s, so a destination that has no folder behind it yet is a
 * perfectly ordinary value rather than a tree that has to be mutated first.
 */

/**
 * What is being moved. A folder move is the same picker with two differences:
 * the destinations exclude its own subtree, and the thing that travels is
 * every note under it rather than one note.
 */
export type MoveTarget =
  { kind: 'note'; id: string; folderPath: string } | { kind: 'folder'; path: string }

export interface MoveSheetProps {
  visible: boolean
  ctx: NoteOpsContext | null
  target: MoveTarget
  /** The tree the screen already read, so this sheet never re-queries SQLite. */
  snapshot: NotesSnapshot
  onClose: () => void
  onMoved: () => void
}

/** Where the target lives now; `''` is the vault root. */
function originOf(target: MoveTarget): string {
  return target.kind === 'note' ? target.folderPath : parentPath(target.path)
}

function targetKey(target: MoveTarget): string {
  return target.kind === 'note' ? `n:${target.id}` : `f:${target.path}`
}

interface PickerRow {
  path: string
  name: string
  icon: string | null
  level: number
  expandable: boolean
  expanded: boolean
}

function topSegment(path: string): string {
  const slash = path.indexOf('/')
  return slash === -1 ? path : path.slice(0, slash)
}

/**
 * Expansion is keyed on TOP-LEVEL paths, and opening one reveals its whole
 * folder subtree. Board 35 draws a chevron on level-0 rows only, so a model
 * where each depth needs its own toggle leaves a three-level vault with a
 * subtree the user has no control to reach.
 */
function buildRows(
  root: FolderNode,
  expandedTops: ReadonlySet<string>,
  query: string
): PickerRow[] {
  const matches = (node: FolderNode): boolean =>
    node.name.toLowerCase().includes(query) || node.folders.some(matches)

  const rows: PickerRow[] = []
  const emit = (node: FolderNode, level: number): void => {
    const open = expandedTops.has(topSegment(node.path))
    // A query forces every kept folder open and takes the toggles away, the
    // same rule `flattenFolderTree` applies to the notes list.
    const children = query === '' ? (open ? node.folders : []) : node.folders.filter(matches)
    rows.push({
      path: node.path,
      name: node.name,
      icon: node.icon,
      level,
      expandable: query === '' && level === 0 && node.folders.length > 0,
      // Whether the children are actually drawn, not whether this row can
      // toggle: a nested folder never toggles, but its subfolders are listed
      // right below it and an open folder is what that is.
      expanded: children.length > 0
    })
    for (const child of children) emit(child, level + 1)
  }

  for (const folder of root.folders) {
    if (query === '' || matches(folder)) emit(folder, 0)
  }
  return rows
}

type SheetRow =
  { kind: 'root' } | { kind: 'folder'; row: PickerRow } | { kind: 'pending'; path: string }

function DestinationRow({
  label,
  level,
  icon,
  expanded,
  selected,
  current,
  onPress,
  onToggle
}: {
  label: string
  level: number
  icon: ResolvedIcon | null
  expanded: boolean
  selected: boolean
  current: boolean
  onPress: () => void
  onToggle?: () => void
}) {
  const shared = {
    label,
    level,
    folder: { expanded },
    icon,
    selected,
    onPress,
    onToggle,
    accessibilityLabel: `Move to ${label}`
  }
  // `count` and `trailingLabel` are mutually exclusive in `TreeRowProps`, so
  // the current-folder marker is a second element rather than one prop set to
  // `undefined` — which fits neither half of that union.
  return current ? <TreeRow {...shared} trailingLabel="current" /> : <TreeRow {...shared} />
}

export function MoveSheet(props: MoveSheetProps) {
  const { visible, target, onClose } = props
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      {/* Its OWN provider. A Modal is a separate native window, so the insets
          the app root measured do not reach inside it and the SafeAreaView
          below resolves every edge to 0 — the nav row lands on top of the
          status bar. This is the library's documented fix for modals. */}
      <SafeAreaProvider>
        {/* Keyed by the note, so opening the sheet mounts it and the draft
            selection starts from that note's folder by construction. */}
        {visible ? <MoveSheetBody key={targetKey(target)} {...props} /> : null}
      </SafeAreaProvider>
    </Modal>
  )
}

function MoveSheetBody({ ctx, target, snapshot, onClose, onMoved }: MoveSheetProps) {
  const c = useColors()
  const currentPath = originOf(target)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(currentPath)
  // Seeded with the note's own branch so the sheet opens showing where it is
  // now instead of making the user hunt for it.
  const [expandedTops, setExpandedTops] = useState<ReadonlySet<string>>(
    () => new Set(currentPath === '' ? [] : [topSegment(currentPath)])
  )

  const tree = useMemo(
    () => buildFolderTree(snapshot.entries, snapshot.icons, snapshot.folderPaths),
    [snapshot.entries, snapshot.icons, snapshot.folderPaths]
  )
  const folderRows = useMemo(() => {
    const rows = buildRows(tree, expandedTops, query.trim().toLowerCase())
    // A folder cannot be moved into itself or into anything below it: the
    // subtree would be detached from every path its notes still name. Hiding
    // those rows is the guard the user sees; `renameFolder` has the other one.
    if (target.kind !== 'folder') return rows
    return rows.filter((row) => !isUnder(row.path, target.path))
  }, [tree, expandedTops, query, target])

  const rows = useMemo<SheetRow[]>(() => {
    // The root is drawn under a query too. It is the un-file destination and
    // has no name for a folder-name search to match, so filtering it out would
    // make the one destination that always exists unreachable.
    const out: SheetRow[] = [{ kind: 'root' }]
    for (const row of folderRows) out.push({ kind: 'folder', row })
    // A path that is not a folder yet: without a row of its own, naming a new
    // folder would select something the sheet never shows.
    if (selected !== '' && findFolder(tree, selected) === null) {
      out.push({ kind: 'pending', path: selected })
    }
    return out
  }, [folderRows, selected, tree])

  const toggle = useCallback((path: string) => {
    setExpandedTops((current) => {
      const next = new Set(current)
      if (!next.delete(path)) next.add(path)
      return next
    })
  }, [])

  const promptNewFolder = useCallback(() => {
    Alert.prompt(
      'New folder',
      undefined,
      (name) => {
        const trimmed = name.trim()
        if (trimmed.length === 0) return
        // Nothing is created here. A folder is a projection of the notes'
        // `folderPath`s, so it comes into existence the moment a note is moved
        // into it; there is no folder record to write.
        setSelected(selected === '' ? trimmed : `${selected}/${trimmed}`)
      },
      'plain-text'
    )
  }, [selected])

  const commitMove = useCallback(async () => {
    if (!ctx) return
    try {
      if (target.kind === 'note') await moveNote(ctx, target.id, selected === '' ? null : selected)
      else await moveFolder(ctx, target.path, selected)
      onMoved()
      onClose()
    } catch (err) {
      log.error('Moving failed', { target: targetKey(target), error: String(err) })
      Alert.alert('Move failed', extractErrorMessage(err, 'That could not be moved.'))
    }
  }, [ctx, target, selected, onMoved, onClose])

  const canMove = ctx !== null && selected !== currentPath

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.canvas.background }]}>
      <View style={[styles.nav, { borderBottomColor: c.line.border }]}>
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.navSlot}>
          <AppText color={c.tint.base}>Cancel</AppText>
        </Pressable>
        <AppText variant="headline" style={styles.navTitle}>
          {target.kind === 'folder' ? 'Move folder' : 'Move to'}
        </AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canMove }}
          disabled={!canMove}
          onPress={() => void commitMove()}
          style={[styles.navSlot, styles.navSlotEnd]}
        >
          <AppText color={canMove ? c.tint.base : c.text.tertiary} style={styles.navAction}>
            Move
          </AppText>
        </Pressable>
      </View>

      <View style={styles.searchRow}>
        <SearchField
          placeholder="Search folders"
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          autoCapitalize="none"
        />
      </View>

      <FlatList
        data={rows}
        keyExtractor={(row) => {
          if (row.kind === 'folder') return `f:${row.row.path}`
          if (row.kind === 'pending') return `p:${row.path}`
          return row.kind
        }}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => {
          switch (item.kind) {
            case 'root':
              return (
                <DestinationRow
                  label="No folder"
                  level={0}
                  icon={null}
                  expanded={false}
                  selected={selected === ''}
                  current={currentPath === ''}
                  onPress={() => setSelected('')}
                />
              )
            case 'folder':
              return (
                <DestinationRow
                  label={item.row.name}
                  level={item.row.level}
                  icon={resolveIcon(item.row.icon, snapshot.customIcons)}
                  expanded={item.row.expanded}
                  selected={selected === item.row.path}
                  current={currentPath === item.row.path}
                  onPress={() => setSelected(item.row.path)}
                  onToggle={item.row.expandable ? () => toggle(item.row.path) : undefined}
                />
              )
            case 'pending':
              return (
                <DestinationRow
                  label={item.path}
                  level={0}
                  icon={null}
                  expanded={false}
                  selected
                  current={false}
                  onPress={() => setSelected(item.path)}
                />
              )
          }
        }}
        ListFooterComponent={
          // `Alert.prompt` is iOS-only. An affordance that is simply absent on
          // Android beats one that is present and does nothing when tapped.
          Platform.OS === 'ios' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New folder here"
              onPress={promptNewFolder}
              style={styles.newFolder}
            >
              <Icon name="plus" size={16} color={c.tint.base} />
              <AppText variant="subhead" color={c.tint.base}>
                New folder here
              </AppText>
            </Pressable>
          ) : null
        }
      />

      <AppText variant="caption" color={c.text.secondary} style={styles.footnote}>
        {target.kind === 'folder'
          ? 'Moving a folder takes its notes with it — every link keeps working.'
          : 'Moving a note keeps every link to it working — links point at the note, not its path.'}
      </AppText>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  nav: {
    height: sizes.navBar,
    paddingHorizontal: sizes.gutter,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1
  },
  navSlot: { width: 80, justifyContent: 'center' },
  // RN's `textAlign` has no logical `end`, so the trailing label is aligned by
  // the flex container instead, which does follow the layout direction.
  navSlotEnd: { alignItems: 'flex-end' },
  navTitle: { flex: 1, textAlign: 'center' },
  navAction: { fontFamily: fontFamilies.sansSemiBold },
  searchRow: { paddingVertical: space.s12, paddingHorizontal: sizes.gutter },
  newFolder: {
    height: 40,
    marginTop: space.s4,
    paddingStart: sizes.gutter,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s6
  },
  footnote: { paddingBottom: space.s12, paddingHorizontal: space.s24, textAlign: 'center' }
})

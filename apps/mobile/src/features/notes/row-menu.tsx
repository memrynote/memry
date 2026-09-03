import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Alert, Share, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'

import { ContextMenu } from '@/components/ui/context-menu'
import { PromptDialog } from '@/components/ui/prompt-dialog'
import type { SwipeAction } from '@/components/ui/swipe-row'
import { Toast, type ToastAction } from '@/components/ui/toast'
import { TreeRow } from '@/components/ui/tree-row'
import { toggleBookmark } from '@/features/notes/bookmarks'
import {
  createFolder,
  createNoteInFolder,
  deleteFolder,
  duplicateFolder,
  folderName,
  joinPath,
  parentPath,
  renameFolder,
  siblingNames,
  uniqueName
} from '@/features/notes/folder-ops'
import { resolveIcon } from '@/features/notes/icon-value'
import { MoveSheet } from '@/features/notes/move-sheet'
import {
  deleteNote,
  duplicateNote,
  materializedBody,
  renameNote,
  type NoteOpsContext
} from '@/features/notes/note-ops'
import type { NotesSnapshot } from '@/features/notes/notes-repo'
import {
  bookmarkRefFor,
  rowActionGroups,
  targetLabel,
  type RowActionId,
  type RowTarget
} from '@/features/notes/row-actions'
import { NOTE_FILE_TYPE_TONE, type NoteEntry } from '@/features/notes/tree'
import { extractErrorMessage } from '@/lib/errors'
import { createLogger } from '@/lib/logger'
import type { ThemeColors } from '@/theme/colors'
import { sizes, space } from '@/theme/primitives'

const log = createLogger('RowMenu')

/**
 * Every flow the notes-tree long press opens (boards 26B–26O), in one place.
 *
 * Two screens draw the tree — the list and a single folder — and every verb
 * behaves identically on both, so the wiring is a hook rather than a copy in
 * each screen. What the caller supplies is the row's context and a way to
 * reload; what it gets back is a long-press handler and one overlay node.
 *
 * The open dialog is a STATE, not five booleans. A `renaming` flag beside a
 * `moving` one beside a `confirmingDelete` one is a machine with illegal
 * states (two dialogs at once, a prompt with no target) that the type system
 * cannot see; this union has no such state to reach.
 */

type MenuMode =
  | { kind: 'closed' }
  | { kind: 'menu'; target: RowTarget; anchorY: number }
  | { kind: 'rename'; target: RowTarget }
  | { kind: 'new-folder'; target: RowTarget }
  | { kind: 'move'; target: RowTarget }

interface ToastState {
  message: string
  action?: ToastAction
}

/** Long enough to read and reach, short enough not to sit over the FAB. */
const TOAST_MS = 4000

export interface RowMenuOptions {
  ctx: NoteOpsContext | null
  snapshot: NotesSnapshot
  readOnly: boolean
  /** Re-read the tree after a write lands locally. */
  onChanged: () => void
  /** `Search in folder` (board 26H): the screen owns its own search state. */
  onSearchInFolder: (path: string) => void
}

export interface RowMenuHost {
  /** Pass straight to `TreeRow`'s `onLongPress`. */
  open: (target: RowTarget, anchorY: number) => void
  /**
   * Skip the menu and go straight to the move picker. The folder screen's
   * swipe strip has a `Move` action of its own, and routing it through the
   * menu would make one gesture open a second chooser.
   */
  openMove: (target: RowTarget) => void
  /**
   * Skip the menu and go straight to the delete confirmation, for the swipe
   * strip's own `Delete`. It is the SAME confirmation the menu opens, so the
   * two entry points cannot drift apart in wording or in what they remove.
   */
  openDelete: (target: RowTarget) => void
  /** Whether a row is bookmarked, for the row's own glyph. */
  isBookmarked: (target: RowTarget) => boolean
  /** Render last inside the screen, so the overlays sit above the list. */
  overlay: ReactNode
}

export function useRowMenu({
  ctx,
  snapshot,
  readOnly,
  onChanged,
  onSearchInFolder
}: RowMenuOptions): RowMenuHost {
  const [mode, setMode] = useState<MenuMode>({ kind: 'closed' })
  const [toast, setToast] = useState<ToastState | null>(null)

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = useCallback((next: ToastState) => {
    setToast(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(null), TOAST_MS)
  }, [])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const isBookmarked = useCallback(
    (target: RowTarget) => {
      const ref = bookmarkRefFor(target)
      return snapshot.bookmarks.has(`${ref.itemType}:${ref.itemId}`)
    },
    [snapshot.bookmarks]
  )

  const fail = useCallback((verb: string, err: unknown) => {
    log.error(`${verb} failed`, { error: String(err) })
    Alert.alert(`${verb} failed`, extractErrorMessage(err, 'That could not be completed.'))
  }, [])

  const runDelete = useCallback(
    async (target: RowTarget) => {
      if (!ctx) return
      try {
        if (target.kind === 'note') {
          await deleteNote(ctx, target.id)
          showToast({ message: 'Note deleted' })
        } else {
          const result = await deleteFolder(ctx, target.path)
          showToast({ message: `Folder deleted · ${result.notes} notes` })
        }
        onChanged()
      } catch (err) {
        fail('Delete', err)
      }
    },
    [ctx, onChanged, showToast, fail]
  )

  /**
   * A destructive confirm, and deliberately the SYSTEM alert.
   *
   * Board 26K draws an iOS alert, and `Alert.alert` is that alert: drawing our
   * own would be a worse copy of the thing the platform already ships, and it
   * would not carry the VoiceOver semantics a real alert has.
   */
  const confirmDelete = useCallback(
    (target: RowTarget) => {
      const label = targetLabel(target)
      const body =
        target.kind === 'note'
          ? 'The note is removed here and on every synced device. Links pointing at it will break.'
          : `${target.noteCount} ${target.noteCount === 1 ? 'note' : 'notes'} will be removed here and on every synced device.`
      Alert.alert(`Delete “${label}”?`, body, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void runDelete(target) }
      ])
    },
    [runDelete]
  )

  const runDuplicate = useCallback(
    async (target: RowTarget) => {
      if (!ctx) return
      try {
        if (target.kind === 'note') {
          const newId = await duplicateNote(ctx, target.id)
          onChanged()
          showToast({
            message: 'Note duplicated',
            ...(newId
              ? { action: { label: 'Open', onPress: () => router.push(`/notes/${newId}`) } }
              : {})
          })
        } else {
          await duplicateFolder(ctx, target.path)
          onChanged()
          showToast({ message: 'Folder duplicated' })
        }
      } catch (err) {
        fail('Duplicate', err)
      }
    },
    [ctx, onChanged, showToast, fail]
  )

  const runShare = useCallback(
    async (target: RowTarget) => {
      if (!ctx || target.kind !== 'note') return
      try {
        const body = await materializedBody(ctx.db, target.id)
        // A PLAIN copy. Nothing here hands out a vault key, a note id or a
        // sync URL: the share sheet's destination is outside the vault's
        // encryption boundary, so what leaves is markdown and nothing else.
        await Share.share({ title: target.title, message: `# ${target.title}\n\n${body ?? ''}` })
      } catch (err) {
        fail('Share', err)
      }
    },
    [ctx, fail]
  )

  const runBookmark = useCallback(
    async (target: RowTarget) => {
      if (!ctx) return
      const ref = bookmarkRefFor(target)
      const on = isBookmarked(target)
      try {
        await toggleBookmark(ctx, ref.itemType, ref.itemId, on)
        onChanged()
        showToast({ message: on ? 'Removed from bookmarks' : 'Added to bookmarks' })
      } catch (err) {
        fail('Bookmark', err)
      }
    },
    [ctx, isBookmarked, onChanged, showToast, fail]
  )

  const runNewNote = useCallback(
    async (target: RowTarget) => {
      if (!ctx || target.kind !== 'folder') return
      try {
        const noteId = await createNoteInFolder(ctx, target.path)
        // Navigate first, reload on the way back: re-reading the whole tree
        // over the one SQLite connection the bootstrap sync is also using put
        // an unbounded wait between the tap and the editor.
        router.push(`/notes/${noteId}`)
      } catch (err) {
        fail('New note', err)
      }
    },
    [ctx, fail]
  )

  const commitRename = useCallback(
    async (target: RowTarget, name: string) => {
      if (!ctx) return
      try {
        if (target.kind === 'note') {
          await renameNote(ctx, target.id, name)
        } else {
          if (name === target.name) return
          await renameFolder(ctx, target.path, joinPath(parentPath(target.path), name))
        }
        onChanged()
        showToast({ message: 'Renamed' })
      } catch (err) {
        fail('Rename', err)
      }
    },
    [ctx, onChanged, showToast, fail]
  )

  const commitNewFolder = useCallback(
    async (target: RowTarget, name: string) => {
      if (!ctx || target.kind !== 'folder') return
      try {
        await createFolder(ctx, joinPath(target.path, name))
        onChanged()
        showToast({ message: 'Folder created' })
      } catch (err) {
        fail('New folder', err)
      }
    },
    [ctx, onChanged, showToast, fail]
  )

  const select = useCallback(
    (target: RowTarget, id: RowActionId) => {
      setMode({ kind: 'closed' })
      switch (id) {
        case 'new-note':
          void runNewNote(target)
          return
        case 'new-folder':
          setMode({ kind: 'new-folder', target })
          return
        case 'duplicate':
          void runDuplicate(target)
          return
        case 'move':
          setMode({ kind: 'move', target })
          return
        case 'search-in-folder':
          if (target.kind === 'folder') onSearchInFolder(target.path)
          return
        case 'bookmark':
        case 'unbookmark':
          void runBookmark(target)
          return
        case 'share':
          void runShare(target)
          return
        case 'rename':
          setMode({ kind: 'rename', target })
          return
        case 'delete':
          confirmDelete(target)
          return
      }
    },
    [runNewNote, runDuplicate, runBookmark, runShare, confirmDelete, onSearchInFolder]
  )

  const open = useCallback((target: RowTarget, anchorY: number) => {
    setMode({ kind: 'menu', target, anchorY })
  }, [])

  const openMove = useCallback((target: RowTarget) => setMode({ kind: 'move', target }), [])

  const close = useCallback(() => setMode({ kind: 'closed' }), [])

  const groups = useMemo(() => {
    if (mode.kind !== 'menu') return []
    return rowActionGroups(mode.target, { bookmarked: isBookmarked(mode.target), readOnly })
  }, [mode, isBookmarked, readOnly])

  const preview =
    mode.kind === 'menu' ? <PreviewRow target={mode.target} snapshot={snapshot} /> : null

  const overlay = (
    <>
      {mode.kind === 'menu' ? (
        <ContextMenu
          visible
          anchorY={mode.anchorY}
          preview={preview}
          groups={groups}
          accessibilityLabel={`Actions for ${targetLabel(mode.target)}`}
          onSelect={(id) => select(mode.target, id)}
          onClose={close}
        />
      ) : null}

      {mode.kind === 'rename' ? (
        <PromptDialog
          visible
          title="Rename"
          initialValue={targetLabel(mode.target)}
          confirmLabel="Rename"
          onCancel={close}
          onConfirm={(name) => {
            close()
            void commitRename(mode.target, name)
          }}
        />
      ) : null}

      {mode.kind === 'new-folder' && mode.target.kind === 'folder' ? (
        <PromptDialog
          visible
          title="New folder"
          message={`Created inside ${mode.target.name}`}
          initialValue={uniqueName(
            siblingNames(folderPathsOf(snapshot), mode.target.path),
            'Untitled',
            'folder'
          )}
          confirmLabel="Create"
          onCancel={close}
          onConfirm={(name) => {
            const target = mode.target
            close()
            void commitNewFolder(target, name)
          }}
        />
      ) : null}

      <MoveSheet
        visible={mode.kind === 'move'}
        ctx={ctx}
        target={
          mode.kind === 'move'
            ? mode.target.kind === 'note'
              ? { kind: 'note', id: mode.target.id, folderPath: mode.target.folderPath }
              : { kind: 'folder', path: mode.target.path }
            : { kind: 'folder', path: '' }
        }
        snapshot={snapshot}
        onClose={close}
        onMoved={onChanged}
      />

      {toast ? (
        <View pointerEvents="box-none" style={styles.toastLayer}>
          <Toast message={toast.message} action={toast.action} icon={null} />
        </View>
      ) : null}
    </>
  )

  return { open, openMove, openDelete: confirmDelete, isBookmarked, overlay }
}

/**
 * Every folder path the tree knows: the ones a note names plus the empty ones
 * `folder_config` holds. The new-folder dialog needs the union to pick a name
 * that is free.
 */
function folderPathsOf(snapshot: NotesSnapshot): Set<string> {
  const paths = new Set(snapshot.folderPaths)
  for (const entry of snapshot.entries) {
    let path = ''
    for (const segment of entry.folderPath.split('/')) {
      if (segment.length === 0) continue
      path = path === '' ? segment : `${path}/${segment}`
      paths.add(path)
    }
  }
  return paths
}

/** The lifted row under the menu: the same row the list drew, at level 0. */
function PreviewRow({ target, snapshot }: { target: RowTarget; snapshot: NotesSnapshot }) {
  if (target.kind === 'folder') {
    return (
      <TreeRow
        label={target.name}
        level={0}
        folder={{ expanded: false }}
        icon={resolveIcon(snapshot.icons.get(target.path) ?? null, snapshot.customIcons)}
        count={target.noteCount}
      />
    )
  }
  const entry = snapshot.entries.find((candidate) => candidate.id === target.id)
  return (
    <TreeRow
      label={target.title}
      level={0}
      icon={resolveIcon(entry?.icon ?? null, snapshot.customIcons)}
      tone={NOTE_FILE_TYPE_TONE[entry?.fileType ?? 'markdown']}
    />
  )
}

/** Build the menu target for a note row. */
export function noteTarget(note: NoteEntry): RowTarget {
  return { kind: 'note', id: note.id, title: note.title, folderPath: note.folderPath }
}

/**
 * The trailing swipe verbs for a note row.
 *
 * Both tree screens draw the same strip, so it is built here beside the menu
 * whose flows the two actions open, rather than copied into each screen.
 */
export function noteSwipeActions(
  note: NoteEntry,
  c: ThemeColors,
  menu: RowMenuHost
): SwipeAction[] {
  return [
    {
      label: 'Move',
      icon: 'folder',
      width: 72,
      background: c.canvas.surfaceActive,
      foreground: c.text.primary,
      onPress: () => menu.openMove(noteTarget(note))
    },
    {
      label: 'Delete',
      icon: 'trash',
      width: 76,
      background: c.ui.destructive,
      foreground: c.ui.destructiveForeground,
      onPress: () => menu.openDelete(noteTarget(note))
    }
  ]
}

/** Build the menu target for a folder row. */
export function folderTarget(path: string, noteCount: number): RowTarget {
  return { kind: 'folder', path, name: folderName(path), noteCount }
}

const styles = StyleSheet.create({
  toastLayer: {
    position: 'absolute',
    start: sizes.gutter,
    end: sizes.gutter,
    bottom: space.s24,
    alignItems: 'center'
  }
})

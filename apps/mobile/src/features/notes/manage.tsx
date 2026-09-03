import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { AppText } from '@/components/ui/app-text'
import type { VaultDb } from '@/db/index'
import { radius, sizes, space } from '@/theme/primitives'
import { textStyles } from '@/theme/text-styles'
import { useColors } from '@/theme/use-colors'
import { deleteNote, moveNote, renameNote, type NoteOpsContext } from './note-ops'

/**
 * Note management UI (T064 / FR-012): rename, move to folder, delete.
 *
 * Every action goes through `note-ops`, which writes the local projection and
 * enqueues the push in that order — so the sheet behaves identically offline
 * and there is no "saving…" state to get stuck in.
 */

export interface NoteManageSheetProps {
  visible: boolean
  ctx: NoteOpsContext | null
  noteId: string
  title: string
  folderPath: string
  onClose: () => void
  /** Called after a change lands locally, so the screen can re-read. */
  onChanged: () => void
  /** Called after a delete, so the screen can navigate away. */
  onDeleted: () => void
  /**
   * Opens the note's tags, properties, attachments and editor tools.
   *
   * They have no home on board 28 — boards 32, 33 and 38 own them and none is
   * built — so this sheet is where they stay reachable in the meantime.
   */
  onOpenDetails?: () => void
}

export function NoteManageSheet(props: NoteManageSheetProps) {
  const { visible, noteId, onClose } = props
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      {/*
        Keyed by the note it is editing, so opening the sheet MOUNTS it and the
        draft state starts from the current title by construction. Copying
        props into state from an effect would re-render twice on every open and
        would still be wrong the first frame.
      */}
      {visible ? <NoteManageBody key={noteId} {...props} /> : null}
    </Modal>
  )
}

function NoteManageBody({
  ctx,
  noteId,
  title,
  folderPath,
  onClose,
  onChanged,
  onDeleted,
  onOpenDetails
}: NoteManageSheetProps) {
  const c = useColors()
  const [draftTitle, setDraftTitle] = useState(title)
  const [folders, setFolders] = useState<string[]>([])
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const deleted = useRef(false)

  useEffect(() => {
    if (ctx) void listFolders(ctx.db).then(setFolders)
  }, [ctx])

  const commitRename = useCallback(async () => {
    if (!ctx || draftTitle.trim() === title) return
    await renameNote(ctx, noteId, draftTitle)
    onChanged()
  }, [ctx, draftTitle, noteId, onChanged, title])

  /**
   * Commit on UNMOUNT as well as on blur.
   *
   * Dismissing the sheet — the backdrop, the system back gesture — tears the
   * field down without firing blur, so a typed rename was silently dropped.
   * The ref carries the latest committer into the cleanup, which would
   * otherwise capture the one from first render.
   */
  const latestRename = useRef(commitRename)
  useEffect(() => {
    latestRename.current = commitRename
  }, [commitRename])
  useEffect(
    () => () => {
      if (deleted.current) return
      void latestRename.current()
    },
    []
  )

  const commitMove = useCallback(
    async (next: string) => {
      if (!ctx) return
      await moveNote(ctx, noteId, next === '' ? null : next)
      onChanged()
      onClose()
    },
    [ctx, noteId, onChanged, onClose]
  )

  const commitDelete = useCallback(async () => {
    if (!ctx) return
    // Set BEFORE the await: the unmount that follows would otherwise fire the
    // pending rename, whose `update` is newer than the tombstone — the note
    // comes back on every other device.
    deleted.current = true
    await deleteNote(ctx, noteId)
    onClose()
    onDeleted()
  }, [ctx, noteId, onClose, onDeleted])

  return (
    <View style={[styles.sheet, { backgroundColor: c.canvas.popover }]}>
      <AppText variant="headline">Note</AppText>

      <AppText variant="caption" color={c.text.secondary}>
        Title
      </AppText>
      <TextInput
        value={draftTitle}
        onChangeText={setDraftTitle}
        onBlur={commitRename}
        onSubmitEditing={commitRename}
        returnKeyType="done"
        placeholderTextColor={c.text.tertiary}
        style={[
          styles.input,
          textStyles.body,
          { borderColor: c.line.input, color: c.text.primary }
        ]}
        accessibilityLabel="Note title"
      />

      <AppText variant="caption" color={c.text.secondary}>
        Folder
      </AppText>
      <ScrollView style={styles.folders}>
        <FolderRow label="No folder" selected={folderPath === ''} onPress={() => commitMove('')} />
        {folders.map((folder) => (
          <FolderRow
            key={folder}
            label={folder}
            selected={folder === folderPath}
            onPress={() => commitMove(folder)}
          />
        ))}
      </ScrollView>

      {onOpenDetails ? (
        <Pressable
          onPress={() => {
            onClose()
            onOpenDetails()
          }}
          style={styles.folderRow}
          accessibilityRole="button"
          accessibilityLabel="Note details"
        >
          <AppText>Note details</AppText>
        </Pressable>
      ) : null}

      {confirmingDelete ? (
        <View style={styles.confirmRow}>
          <AppText variant="footnote" color={c.text.secondary}>
            Delete this note on every device?
          </AppText>
          <Pressable
            // `onPressIn`: the row disables itself as soon as the delete
            // starts, and a press that disables its own target between down
            // and up never produces a press event.
            onPressIn={commitDelete}
            style={styles.destructive}
            accessibilityRole="button"
            accessibilityLabel="Confirm delete"
          >
            <AppText color={c.ui.destructiveText}>Delete</AppText>
          </Pressable>
          <Pressable onPress={() => setConfirmingDelete(false)} accessibilityRole="button">
            <AppText variant="footnote" color={c.text.secondary}>
              Cancel
            </AppText>
          </Pressable>
        </View>
      ) : (
        <Pressable
          onPress={() => setConfirmingDelete(true)}
          style={styles.destructive}
          accessibilityRole="button"
          accessibilityLabel="Delete note"
        >
          <AppText color={c.ui.destructiveText}>Delete note</AppText>
        </Pressable>
      )}
    </View>
  )
}

function FolderRow({
  label,
  selected,
  onPress
}: {
  label: string
  selected: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.folderRow}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`Move to ${label}`}
    >
      <AppText>{selected ? `✓ ${label}` : label}</AppText>
    </Pressable>
  )
}

/**
 * The folders that hold at least one note.
 *
 * NOT every folder: an empty one exists only as a `folder_config` row, which
 * `readFolderPaths` in `folder-ops.ts` reads. This list is the older, narrower
 * question — "where can a note go that something already lives" — and is all
 * this sheet's picker needs.
 */
export async function listFolders(db: VaultDb): Promise<string[]> {
  const rows = await db.getAllAsync<{ payload: string | null }>(
    `SELECT payload FROM sync_items
     WHERE type = 'note' AND deleted_at IS NULL AND payload_state = 'full'`
  )
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row.payload) continue
    try {
      const folder = (JSON.parse(row.payload) as { folderPath?: string | null }).folderPath
      if (folder) seen.add(folder)
    } catch {
      // Unparseable payloads are already reported by the projection layer.
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: {
    paddingHorizontal: space.s16,
    paddingTop: space.s16,
    paddingBottom: space.s24,
    gap: space.s8,
    borderTopStartRadius: radius.xl,
    borderTopEndRadius: radius.xl,
    maxHeight: '70%'
  },
  input: {
    minHeight: sizes.tapTarget,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: space.s8
  },
  folders: { maxHeight: 220 },
  folderRow: { minHeight: sizes.tapTarget, justifyContent: 'center' },
  confirmRow: { gap: space.s8 },
  destructive: { minHeight: sizes.tapTarget, justifyContent: 'center' }
})

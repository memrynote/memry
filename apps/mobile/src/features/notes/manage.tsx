import { useCallback, useEffect, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { Spacing } from '@/constants/theme'
import type { VaultDb } from '@/db/index'
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
  onDeleted
}: NoteManageSheetProps) {
  const [draftTitle, setDraftTitle] = useState(title)
  const [folders, setFolders] = useState<string[]>([])
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  useEffect(() => {
    if (ctx) void listFolders(ctx.db).then(setFolders)
  }, [ctx])

  const commitRename = useCallback(async () => {
    if (!ctx || draftTitle.trim() === title) return
    await renameNote(ctx, noteId, draftTitle)
    onChanged()
  }, [ctx, draftTitle, noteId, onChanged, title])

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
    await deleteNote(ctx, noteId)
    onClose()
    onDeleted()
  }, [ctx, noteId, onClose, onDeleted])

  return (
    <ThemedView style={styles.sheet}>
      <ThemedText type="subtitle">Note</ThemedText>

      <ThemedText type="small">Title</ThemedText>
      <TextInput
        value={draftTitle}
        onChangeText={setDraftTitle}
        onBlur={commitRename}
        onSubmitEditing={commitRename}
        returnKeyType="done"
        style={styles.input}
        accessibilityLabel="Note title"
      />

      <ThemedText type="small">Folder</ThemedText>
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

      {confirmingDelete ? (
        <View style={styles.confirmRow}>
          <ThemedText type="small">Delete this note on every device?</ThemedText>
          <Pressable
            // `onPressIn`: the row disables itself as soon as the delete
            // starts, and a press that disables its own target between down
            // and up never produces a press event.
            onPressIn={commitDelete}
            style={styles.destructive}
            accessibilityRole="button"
            accessibilityLabel="Confirm delete"
          >
            <ThemedText style={styles.destructiveText}>Delete</ThemedText>
          </Pressable>
          <Pressable onPress={() => setConfirmingDelete(false)} accessibilityRole="button">
            <ThemedText type="small">Cancel</ThemedText>
          </Pressable>
        </View>
      ) : (
        <Pressable
          onPress={() => setConfirmingDelete(true)}
          style={styles.destructive}
          accessibilityRole="button"
          accessibilityLabel="Delete note"
        >
          <ThemedText style={styles.destructiveText}>Delete note</ThemedText>
        </Pressable>
      )}
    </ThemedView>
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
      <ThemedText>{selected ? `✓ ${label}` : label}</ThemedText>
    </Pressable>
  )
}

/**
 * Folders are a projection of the notes' `folderPath`, not a table of record —
 * which is exactly why an empty folder cannot exist on mobile yet, and why a
 * rename is a batch of moves (see `renameFolder`).
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
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.four,
    gap: Spacing.two,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '70%'
  },
  input: {
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(120,113,108,0.4)',
    borderRadius: 8,
    paddingHorizontal: Spacing.two,
    fontSize: 17
  },
  folders: { maxHeight: 220 },
  folderRow: { minHeight: 44, justifyContent: 'center' },
  confirmRow: { gap: Spacing.two },
  destructive: { minHeight: 44, justifyContent: 'center' },
  destructiveText: { color: '#c2410c' }
})

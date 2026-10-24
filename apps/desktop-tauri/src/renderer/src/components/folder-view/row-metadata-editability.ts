/**
 * Which folder-view rows may have their Memry metadata edited in place.
 *
 * A folder holds PDFs, images, audio and video next to markdown notes, and the
 * table renders them all. Only markdown carries frontmatter, so a tag or
 * property write on any other row would run the file through the markdown
 * serializer and replace its bytes with text (#2073). Those cells are rendered
 * read-only instead — an affordance that reports success while destroying the
 * file is worse than no affordance.
 *
 * @module components/folder-view/row-metadata-editability
 */

/**
 * The parts of a folder-view row this decision needs. Structural on purpose:
 * the page and the table components still speak the renderer-local
 * `NoteWithProperties` while the IPC layer speaks the contracts one.
 */
interface MetadataEditableRow {
  kind?: 'note' | 'task' | 'inbox'
  fileType?: 'markdown' | 'pdf' | 'image' | 'audio' | 'video'
}

/**
 * True when the row is a markdown note whose frontmatter can safely be written.
 *
 * `fileType` is absent on rows produced before the field existed; those are
 * markdown notes, which is why the default is permissive.
 */
export function isMetadataEditableRow(row: MetadataEditableRow): boolean {
  if ((row.kind ?? 'note') !== 'note') return false
  return (row.fileType ?? 'markdown') === 'markdown'
}

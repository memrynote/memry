/** The part of the BlockNote editor this needs; ContentArea holds its editor untyped. */
interface UploadBlockEditor {
  getBlock: (blockId: string) => unknown
  removeBlocks: (blockIds: string[]) => unknown
}

/**
 * Take a pasted or dropped file's block back out of the note when its upload
 * fails.
 *
 * BlockNote puts the block in the note before it uploads the file, and leaves
 * it there when the upload throws (`handleFileInsertion` in @blocknote/core):
 * an image block with no URL that reads "Loading..." for good and is saved with
 * the note. The upload's toast already says why the file was refused (#5606).
 *
 * BlockNote asks for an upload only on a paste or a drop. Memry's file panel
 * goes through the attachment picker instead, so the block is always the
 * placeholder the paste or drop made. One the user deleted while the upload
 * ran is already gone.
 */
export function removeFailedUploadBlock(editor: UploadBlockEditor | null, blockId?: string): void {
  if (!editor || !blockId || !editor.getBlock(blockId)) return
  editor.removeBlocks([blockId])
}

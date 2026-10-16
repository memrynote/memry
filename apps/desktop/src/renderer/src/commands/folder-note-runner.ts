/**
 * The owner of "new note in folder" chords, see `resolveFolderChord`. The
 * dispatcher lives above the workspace, so the one mounted workspace registers
 * how to create the note, and the dispatcher asks whether anyone has.
 */
type FolderNoteRunner = (folder: string) => void

let runner: FolderNoteRunner | null = null

export function registerFolderNoteRunner(run: FolderNoteRunner): () => void {
  runner = run
  return () => {
    // A replaced registration's late cleanup must not remove its replacement.
    if (runner === run) runner = null
  }
}

export function runFolderNote(folder: string): void {
  runner?.(folder)
}

/** Synchronous, so the keydown listener consumes the key only when the shortcut will run. */
export function isFolderNoteRunnable(): boolean {
  return runner !== null
}

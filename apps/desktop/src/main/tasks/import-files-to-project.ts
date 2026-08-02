/**
 * Project hub → paperclip. Imports files into the vault and links each one to
 * the project.
 *
 * This has to live in main because `importFiles` returns paths, not ids — the
 * indexer mints the id after the copy lands. Resolving that from the renderer
 * would be a poll racing the indexer; here it is one bounded wait per file, and
 * a file that never gets indexed is reported rather than silently dropped.
 */

export interface ImportFilesToProjectDeps {
  importFiles: (sourcePaths: string[]) => Promise<{
    importedFiles: { destPath: string; filename: string; fileType: string }[]
    errors: string[]
  }>
  /** Resolve a vault-relative path to its indexed id, or null if not indexed yet. */
  getIdByPath: (destPath: string) => Promise<string | null>
  linkToProject: (projectId: string, fileId: string) => Promise<void>
  sleep: (ms: number) => Promise<void>
}

export interface ImportFilesToProjectInput {
  projectId: string
  sourcePaths: string[]
}

export interface ImportFilesToProjectResult {
  success: boolean
  linked: string[]
  failed: { path: string; error: string }[]
}

/** How long to wait for the indexer before giving up on a single file. */
const INDEX_ATTEMPTS = 20
const INDEX_INTERVAL_MS = 250

export async function importFilesToProject(
  deps: ImportFilesToProjectDeps,
  input: ImportFilesToProjectInput
): Promise<ImportFilesToProjectResult> {
  const imported = await deps.importFiles(input.sourcePaths)

  const linked: string[] = []
  const failed: { path: string; error: string }[] = imported.errors.map((error) => ({
    path: '',
    error
  }))

  for (const file of imported.importedFiles) {
    let id: string | null = null

    for (let attempt = 0; attempt < INDEX_ATTEMPTS && id === null; attempt++) {
      id = await deps.getIdByPath(file.destPath)
      if (id === null) await deps.sleep(INDEX_INTERVAL_MS)
    }

    if (id === null) {
      failed.push({
        path: file.destPath,
        error: 'File was imported but the indexer has not assigned an id yet'
      })
      continue
    }

    try {
      await deps.linkToProject(input.projectId, id)
    } catch (error) {
      // The copy landed but the file never joined the project, so it belongs in
      // `failed` — otherwise the UI reports "added" for a file that is not there.
      failed.push({
        path: file.destPath,
        error: error instanceof Error ? error.message : 'Failed to link file to project'
      })
      continue
    }

    linked.push(id)
  }

  return { success: failed.length === 0, linked, failed }
}

/**
 * Project hub → "paste a link". Creates a note for the URL and links it to the
 * project in one step, so the renderer never has to sequence two mutations and
 * leave a stray note behind if the second one fails.
 */

export interface CaptureUrlDeps {
  /** Resolve the page's title. Injected so tests never touch the network. */
  fetchTitle: (url: string) => Promise<string | null>
  createNote: (input: { title: string; content: string }) => Promise<{ id: string } | null>
  linkToProject: (projectId: string, noteId: string) => void
}

export interface CaptureUrlInput {
  projectId: string
  url: string
}

export interface CaptureUrlResult {
  success: boolean
  noteId?: string
  error?: string
}

/**
 * A readable fallback title when the page has none or is unreachable: the host
 * plus path, without the scheme. Better than a bare "https://…" in a list.
 */
export function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')
    return `${parsed.host}${path}`
  } catch {
    return url
  }
}

export async function captureUrlToProject(
  deps: CaptureUrlDeps,
  input: CaptureUrlInput
): Promise<CaptureUrlResult> {
  // A missing title is normal (offline, a 404, a site that blocks us) and must
  // not fail the capture — the user still gets a linked note.
  let title: string | null = null
  try {
    title = await deps.fetchTitle(input.url)
  } catch {
    title = null
  }

  const note = await deps.createNote({
    title: title?.trim() || titleFromUrl(input.url),
    content: `[${title?.trim() || input.url}](${input.url})\n`
  })

  if (!note) return { success: false, error: 'Failed to create note' }

  deps.linkToProject(input.projectId, note.id)
  return { success: true, noteId: note.id }
}

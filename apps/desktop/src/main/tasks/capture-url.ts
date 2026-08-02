/**
 * Project hub → "paste a link". Creates a note for the URL and links it to the
 * project in one step, so the renderer never has to sequence two mutations and
 * leave a stray note behind if the second one fails.
 */

export interface CaptureUrlDeps {
  /** Resolve the page's title. Injected so tests never touch the network. */
  fetchTitle: (url: string) => Promise<string | null>
  createNote: (input: { title: string; content: string }) => Promise<{ id: string } | null>
  linkToProject: (projectId: string, noteId: string) => Promise<void>
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

/**
 * A page title is arbitrary text; a `[` or `]` in it would close the markdown
 * link early and leave the rest as loose text in the note.
 */
function escapeLinkText(text: string): string {
  return text.replace(/([\\[\]])/g, '\\$1')
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

  const linkText = title?.trim() || input.url
  const note = await deps.createNote({
    title: title?.trim() || titleFromUrl(input.url),
    content: `[${escapeLinkText(linkText)}](${input.url})\n`
  })

  if (!note) return { success: false, error: 'Failed to create note' }

  // The link is the whole point of the capture, so a failure here is a failure
  // of the capture. Reporting success would hide a note that never joined the
  // project — the exact stray-note case this function exists to prevent.
  try {
    await deps.linkToProject(input.projectId, note.id)
  } catch (error) {
    return {
      success: false,
      noteId: note.id,
      error: error instanceof Error ? error.message : 'Failed to link note to project'
    }
  }

  return { success: true, noteId: note.id }
}

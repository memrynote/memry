/**
 * Render-time resolution of a note-relative asset URL, for the blocks BlockNote
 * does not resolve for us.
 *
 * BlockNote applies its own `resolveFileUrl` to the built-in image/video/audio
 * blocks, so those already load a `../attachments/<noteId>/x.png` ref. Memry's
 * `file` block is a custom spec and renders `props.url` itself, which meant a
 * note-relative PDF resolved against the renderer document's base URL and never
 * loaded. This hands that same resolver down so the two agree.
 *
 * **Resolution is render-only.** The resolved absolute URL must never be written
 * back into the block's props: it would serialize into the note's markdown and
 * put this machine's vault path back on disk, which is the whole bug this exists
 * to close.
 */

import { createContext, useContext, useEffect, useState } from 'react'

type FileUrlResolver = (url: string) => Promise<string>

const NoteFileUrlContext = createContext<FileUrlResolver | null>(null)

export function NoteFileUrlProvider({
  resolveFileUrl,
  children
}: {
  resolveFileUrl: FileUrlResolver
  children: React.ReactNode
}) {
  return (
    <NoteFileUrlContext.Provider value={resolveFileUrl}>{children}</NoteFileUrlContext.Provider>
  )
}

/** `https:`, `data:`, `memry-file:` — and `C:` on Windows. Mirrors the resolver. */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z\d+\-.]*:/

/**
 * The URL to actually render, or `null` while a note-relative one is still being
 * resolved.
 *
 * A URL that already carries a scheme is returned synchronously, on the first
 * render: every attachment written before this change is absolute, and making
 * those wait a tick would remount the PDF viewer — which latches its load error
 * and never retries — for no gain.
 */
export function useResolvedFileUrl(url: string): string | null {
  const resolve = useContext(NoteFileUrlContext)
  const isResolved = !url || HAS_SCHEME.test(url)
  const [resolved, setResolved] = useState<string | null>(isResolved ? url : null)

  useEffect(() => {
    if (isResolved || !resolve) {
      setResolved(url)
      return
    }
    let cancelled = false
    void resolve(url).then((next) => {
      if (!cancelled) setResolved(next)
    })
    return () => {
      cancelled = true
    }
  }, [resolve, url, isResolved])

  return resolved
}

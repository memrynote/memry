import { useCallback, useRef } from 'react'
import { ContentArea } from '@/components/note/content-area'
import { useTabScrollRestore } from '@/hooks/use-tab-scroll-restore'

interface VirtualNotePageProps {
  /** Tab title, rendered as the note heading (e.g. "MemryNote 2026.708.1"). */
  title: string
  /** Release-notes body to render read-only. */
  content: string
  /** How `content` should be parsed by the note renderer. */
  contentType: 'html' | 'markdown'
}

/**
 * Read-only, in-memory note page for the ephemeral "release notes" tab. Not backed by
 * a vault note: it renders provided markdown/HTML directly (with clickable PR links)
 * and is never editable, persisted, or synced.
 */
export function VirtualNotePage({ title, content, contentType }: VirtualNotePageProps) {
  // External links (e.g. PR references) open in the user's browser, matching notes.
  const handleLinkClick = useCallback((href: string) => {
    window.open(href, '_blank', 'noopener,noreferrer')
  }, [])

  // This page used to lean on TabContent's wrapper as its scroller, which is why
  // it was the only tab type the old scroll-restore mechanism actually served.
  // It now owns its scroll container, like every other page.
  const scrollRef = useRef<HTMLDivElement>(null)
  const getScrollElement = useCallback(() => scrollRef.current, [])
  useTabScrollRestore({ getScrollElement })

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto w-full max-w-3xl px-8 py-10">
        <h1 className="mb-6 text-2xl font-semibold text-foreground">{title}</h1>
        <ContentArea
          initialContent={content}
          contentType={contentType}
          editable={false}
          onLinkClick={handleLinkClick}
        />
      </div>
    </div>
  )
}

export default VirtualNotePage

import { useState, useEffect, useRef, type ReactNode } from 'react'
import type { Tab, TabType } from '@/contexts/tabs/types'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { notesService } from '@/services/notes-service'
import type { WikiLinkPreview } from '@/services/notes-service'
import { TabPreviewCard } from './tab-preview-card'

const PREVIEWABLE_TYPES: ReadonlySet<TabType> = new Set(['note', 'journal', 'file'])

const OPEN_DELAY = 400
const CLOSE_DELAY = 200

interface TabHoverPreviewProps {
  tab: Tab
  children: ReactNode
}

export function TabHoverPreview({ tab, children }: TabHoverPreviewProps) {
  if (!PREVIEWABLE_TYPES.has(tab.type)) {
    return <>{children}</>
  }

  return (
    <HoverCard openDelay={OPEN_DELAY} closeDelay={CLOSE_DELAY}>
      <HoverCardTrigger asChild>
        <div data-tab-hover-trigger="">{children}</div>
      </HoverCardTrigger>
      <HoverCardContent
        side="bottom"
        align="start"
        sideOffset={6}
        className="w-[280px] p-0 rounded-[10px] border-border/40 shadow-[var(--shadow-dropdown)]"
      >
        <TabPreviewContent title={tab.title} />
      </HoverCardContent>
    </HoverCard>
  )
}

function TabPreviewContent({ title }: { title: string }) {
  const [preview, setPreview] = useState<WikiLinkPreview | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const abortRef = useRef(false)

  useEffect(() => {
    abortRef.current = false

    notesService
      .previewByTitle(title)
      .then((data) => {
        if (!abortRef.current) {
          setPreview(data)
          setIsLoading(false)
        }
      })
      .catch(() => {
        if (!abortRef.current) {
          setIsLoading(false)
        }
      })

    return () => {
      abortRef.current = true
    }
  }, [title])

  return <TabPreviewCard preview={preview} isLoading={isLoading} />
}

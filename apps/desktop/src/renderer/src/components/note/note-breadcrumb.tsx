import { useMemo, useCallback } from 'react'
import { FileText } from '@/lib/icons'
import { useTabs } from '@/contexts/tabs'

interface BreadcrumbSegment {
  label: string
  folderPath: string
}

interface NoteBreadcrumbProps {
  notePath: string
  noteTitle: string
  noteEmoji: string | null
}

function parseBreadcrumbSegments(notePath: string): BreadcrumbSegment[] {
  const parts = notePath.split('/')

  const withoutNotesPrefix = parts[0] === 'notes' ? parts.slice(1) : [...parts]
  withoutNotesPrefix.pop()

  if (withoutNotesPrefix.length === 0) return []

  return withoutNotesPrefix.map((segment, i) => ({
    label: segment,
    folderPath: withoutNotesPrefix.slice(0, i + 1).join('/')
  }))
}

export const SIDEBAR_REVEAL_FOLDER_EVENT = 'sidebar:reveal-folder'

const CRUMB_CLASS =
  'text-xs text-muted-foreground hover:bg-muted rounded-sm px-1 py-0.5 transition-colors cursor-pointer bg-transparent border-none'

export function NoteBreadcrumb({ notePath, noteTitle, noteEmoji }: NoteBreadcrumbProps) {
  const { openTab } = useTabs()

  const segments = useMemo(() => parseBreadcrumbSegments(notePath), [notePath])

  const handleFolderClick = useCallback(
    (folderPath: string, folderName: string) => {
      window.dispatchEvent(new CustomEvent(SIDEBAR_REVEAL_FOLDER_EVENT, { detail: { folderPath } }))

      openTab({
        type: 'folder',
        title: folderName,
        icon: 'folder',
        path: `/folder/${encodeURIComponent(folderPath)}`,
        entityId: folderPath,
        isPinned: false,
        isModified: false,
        isPreview: true,
        isDeleted: false
      })
    },
    [openTab]
  )

  if (segments.length === 0) return null

  return (
    <nav
      aria-label="Note location"
      className="flex items-center gap-0.5 text-xs leading-4 select-none"
    >
      {segments.map((segment, i) => (
        <span key={segment.folderPath} className="contents">
          {i > 0 && <span className="text-xs text-muted-foreground/40 px-0.5">/</span>}
          <button
            type="button"
            onClick={() => handleFolderClick(segment.folderPath, segment.label)}
            className={CRUMB_CLASS}
          >
            {segment.label}
          </button>
        </span>
      ))}

      <span className="text-xs text-muted-foreground/40 px-0.5">/</span>
      <span className="text-xs text-muted-foreground font-medium inline-flex items-center gap-1 hover:bg-muted rounded-sm px-1 py-0.5 transition-colors">
        {noteEmoji ? (
          <span className="text-xs">{noteEmoji}</span>
        ) : (
          <FileText className="h-3 w-3" />
        )}
        {noteTitle}
      </span>
    </nav>
  )
}

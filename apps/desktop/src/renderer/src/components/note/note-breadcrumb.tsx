import { useMemo, useCallback } from 'react'
import { ChevronLeft } from '@/lib/icons'
import { useTabs } from '@/contexts/tabs'
import { useT } from '@memry/i18n/renderer'
import { useNotesRoot } from '@/hooks/use-vault'
import { stripNotesRoot } from '@/components/notes-tree-utils'

interface BreadcrumbSegment {
  label: string
  folderPath: string
}

interface NoteBreadcrumbProps {
  notePath: string
  noteTitle: string
}

function parseBreadcrumbSegments(notePath: string, notesRoot: string): BreadcrumbSegment[] {
  // Crumbs open folder tabs, so they must be in the same base as folder views:
  // relative to the notes root, not the vault root (#1204).
  const parts = stripNotesRoot(notePath, notesRoot).split('/')
  parts.pop()

  if (parts.length === 0) return []

  return parts.map((segment, i) => ({
    label: segment,
    folderPath: parts.slice(0, i + 1).join('/')
  }))
}

export const SIDEBAR_REVEAL_FOLDER_EVENT = 'sidebar:reveal-folder'

const CRUMB_CLASS =
  'text-xs text-muted-foreground hover:bg-muted active:bg-muted/70 active:text-foreground rounded-sm px-1 py-0.5 transition-colors duration-150 cursor-pointer bg-transparent border-none'

export function NoteBreadcrumb({ notePath, noteTitle }: NoteBreadcrumbProps) {
  const { t } = useT('notes')
  const { openTab } = useTabs()

  const notesRoot = useNotesRoot()

  const segments = useMemo(
    () => parseBreadcrumbSegments(notePath, notesRoot),
    [notePath, notesRoot]
  )

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
        isPreview: false,
        isDeleted: false
      })
    },
    [openTab]
  )

  const handleBackClick = useCallback(() => {
    if (segments.length === 0) return
    const lastSegment = segments[segments.length - 1]
    handleFolderClick(lastSegment.folderPath, lastSegment.label)
  }, [segments, handleFolderClick])

  if (segments.length === 0) return null

  return (
    <nav
      aria-label={t('editor.breadcrumb.locationAria')}
      className="flex items-center gap-1.5 text-xs leading-4 select-none"
    >
      <button
        type="button"
        onClick={handleBackClick}
        className="flex items-center justify-center shrink-0 text-muted-foreground hover:text-foreground transition-all duration-150 ease-out active:scale-90 bg-transparent border-none cursor-pointer p-0"
        aria-label={t('editor.breadcrumb.parentFolderAria')}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>

      {segments.map((segment, i) => (
        <span key={segment.folderPath} className="contents">
          {i > 0 && <span className="text-xs text-text-secondary px-0.5">/</span>}
          <button
            type="button"
            onClick={() => handleFolderClick(segment.folderPath, segment.label)}
            className={CRUMB_CLASS}
          >
            {segment.label}
          </button>
        </span>
      ))}

      <span className="text-xs text-text-secondary px-0.5">/</span>
      <span className="text-xs text-muted-foreground/60 truncate max-w-[200px]">{noteTitle}</span>
    </nav>
  )
}

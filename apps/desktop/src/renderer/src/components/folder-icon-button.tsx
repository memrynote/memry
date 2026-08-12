import { useMemo } from 'react'
import { Folder, FolderOpen, ArrowRight } from '@/lib/icons'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { IconPickerButton } from '@/components/icon-picker-button'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

interface FolderIconButtonProps {
  icon: string | null
  isExpanded: boolean
  hasChildren?: boolean
  onIconChange: (icon: string | null) => void
  onToggleExpand?: () => void
  pickerOpen?: boolean
  onPickerOpenChange?: (open: boolean) => void
}

export function FolderIconButton({
  icon,
  isExpanded,
  hasChildren = false,
  onIconChange,
  pickerOpen,
  onPickerOpenChange
}: FolderIconButtonProps) {
  const { t: tPhaseF } = useT('common')

  const folderIcon = icon ? (
    <NoteIconDisplay value={icon} className="text-sm leading-none" />
  ) : isExpanded ? (
    <FolderOpen className="h-4 w-4 text-muted-foreground" />
  ) : (
    <Folder className="h-4 w-4 text-muted-foreground" />
  )

  // Chevron lets the click bubble to the row, which handles expand/collapse.
  // Icon-only, so the aria-label is its ONLY name — and it goes through i18n
  // like every other user-facing string.
  const chevron = useMemo(
    () =>
      hasChildren ? (
        <button
          type="button"
          className="flex h-4 w-4 items-center justify-center cursor-pointer rounded"
          aria-label={
            isExpanded
              ? tPhaseF('phaseF.componentsFolderIconButton.collapseFolder')
              : tPhaseF('phaseF.componentsFolderIconButton.expandFolder')
          }
        >
          <ArrowRight
            className={cn(
              'h-3 w-3 text-muted-foreground/60 transition-transform ',
              isExpanded && 'rotate-90'
            )}
          />
        </button>
      ) : (
        <div className="h-4 w-4" />
      ),
    [hasChildren, isExpanded, tPhaseF]
  )

  return (
    <IconPickerButton
      leading={chevron}
      hasIcon={!!icon}
      onIconChange={onIconChange}
      ariaLabel={tPhaseF('phaseF.componentsFolderIconButton.setFolderIcon')}
      pickerOpen={pickerOpen}
      onPickerOpenChange={onPickerOpenChange}
    >
      {folderIcon}
    </IconPickerButton>
  )
}

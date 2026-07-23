import { getI18n } from 'react-i18next'
import * as React from 'react'
import { MoreHorizontal, Pencil, Palette, Trash2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
} from '@/components/ui/dropdown-menu'
import { COLOR_NAMES, getTagColors } from '@/components/note/tags-row/tag-colors'
import { CustomColorSwatch } from '@/components/note/tags-row/CustomColorSwatch'
import { tagsService } from '@/services/tags-service'
import { createLogger } from '@/lib/logger'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('Component:TagOverflowMenu')

export interface TagOverflowMenuProps {
  tag: string
  color: string
  onRequestRename: () => void
  onRequestDelete: () => void
}

/**
 * Tag actions overflow menu: rename, change color, delete.
 *
 * Moved here from the sidebar drill-down (`tag-detail-view.tsx`, removed in
 * Task 20) so the tag page owns it going forward. Unchanged beyond the move.
 */
export function TagOverflowMenu({
  tag,
  color,
  onRequestRename,
  onRequestDelete
}: TagOverflowMenuProps): React.JSX.Element {
  const { t: tPhaseF } = useT('notes')
  const [isUpdatingColor, setIsUpdatingColor] = React.useState(false)

  const handleColorChange = async (newColor: string) => {
    if (newColor === color || isUpdatingColor) {
      return
    }

    setIsUpdatingColor(true)
    try {
      const result = await tagsService.updateTagColor({ tag, color: newColor })
      if (!result.success) {
        throw new Error(result.error ?? 'Failed to update tag color')
      }
    } catch (error) {
      log.error('Failed to update tag color', error)
      toast.error(
        extractErrorMessage(
          error,
          getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToUpdateTagColor')
        )
      )
    } finally {
      setIsUpdatingColor(false)
    }
  }

  const colorOptions = COLOR_NAMES

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          aria-label={tPhaseF('phaseF.componentsSidebarTagDetailView.tagActions')}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={onRequestRename}>
          <Pencil className="h-4 w-4 me-2" />

          {tPhaseF('phaseF.componentsSidebarTagRenameDialog.renameTag')}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Palette className="h-4 w-4 me-2" />

            {tPhaseF('phaseF.componentsSidebarTagDetailView.changeColor')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-48 p-2">
            <div className="grid grid-cols-6 gap-1">
              {colorOptions.map((c) => {
                const colors = getTagColors(c)
                return (
                  <button
                    key={c}
                    type="button"
                    className={cn(
                      'w-6 h-6 rounded-full border-2 transition-transform hover:scale-110',
                      c === color ? 'ring-2 ring-primary ring-offset-2' : ''
                    )}
                    style={{ backgroundColor: colors.background, borderColor: colors.text }}
                    onClick={() => void handleColorChange(c)}
                    disabled={isUpdatingColor}
                    title={c}
                    aria-label={c}
                  />
                )
              })}
              <CustomColorSwatch
                size="sm"
                value={color}
                onChange={(hex) => void handleColorChange(hex)}
              />
            </div>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={onRequestDelete}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="h-4 w-4 me-2" />

          {tPhaseF('phaseF.componentsSidebarTagDetailView.deleteTag')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default TagOverflowMenu

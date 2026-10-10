import { memo } from 'react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { useT } from '@memry/i18n/renderer'
import { Hash, MoreHorizontal } from '@/lib/icons'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { PropertyRow } from '@/components/note/info-section/PropertyRow'
import type { PropertyType } from '@/components/note/info-section/types'
import { getTagColors } from '@/components/note/tags-row/tag-colors'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import type { FieldGroup, FieldSlot } from './build-field-groups'
import { tagDisplayName } from './tag-display-name'

export interface NoteFieldGroupsProps {
  groups: FieldGroup[]
  onFieldChange: (name: string, value: unknown, type: PropertyType) => void
  onOpenTag?: (tag: ResolvedTag) => void
  renderGroupAction?: (group: FieldGroup) => React.ReactNode
  renderSlot?: (group: FieldGroup, slot: FieldSlot) => React.ReactNode
  renderGroupFooter?: (group: FieldGroup) => React.ReactNode
  disabled?: boolean
}

export function TagGlyph({ tag, className }: { tag: ResolvedTag; className?: string }) {
  const color = getTagColors(tag.color, tag.name).text
  return (
    <span className={className} style={{ color }} aria-hidden="true">
      {tag.icon ? (
        <NoteIconDisplay value={tag.icon} className="size-3.5 text-[12px] leading-none" />
      ) : (
        <Hash className="size-3.5" />
      )}
    </span>
  )
}

export const NoteFieldGroups = memo(function NoteFieldGroups({
  groups,
  onFieldChange,
  onOpenTag,
  renderGroupAction,
  renderSlot,
  renderGroupFooter,
  disabled
}: NoteFieldGroupsProps) {
  const { t } = useT('notes')
  return (
    <DndContext>
      <SortableContext items={[]}>
        {groups.map((group) => (
          <div
            key={`${group.tag.key}:${group.via?.key ?? ''}`}
            className="flex flex-col pb-1.5"
            data-testid="tag-field-group"
          >
            <div className="group/field-group flex min-h-7 items-center gap-1.5 ps-1">
              <TagGlyph tag={group.tag} className="flex shrink-0" />
              <span className="text-[12px] font-semibold text-foreground">
                {tagDisplayName(group.tag.name)}
              </span>
              {group.via && (
                <span className="text-[12px] text-text-tertiary">
                  {t('tagFields.panel.via', { tag: group.via.name.toLowerCase() })}
                </span>
              )}
              <span className="ms-auto flex items-center gap-1">
                {renderGroupAction?.(group)}
                {onOpenTag && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="flex size-6 items-center justify-center rounded-md text-text-tertiary hover:bg-muted hover:text-foreground"
                        aria-label={t('tagFields.panel.groupMenu', { tag: group.tag.name })}
                      >
                        <MoreHorizontal className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => onOpenTag(group.tag)}>
                        {t('tagFields.panel.openTag', { tag: group.tag.name.toLowerCase() })}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </span>
            </div>
            <ul aria-label={group.tag.name}>
              {group.slots.map(
                (slot) =>
                  renderSlot?.(group, slot) ?? (
                    <PropertyRow
                      key={slot.field.name}
                      property={{
                        id: slot.field.name,
                        name: slot.field.name,
                        type: slot.field.type,
                        value: slot.value ?? null,
                        isCustom: false
                      }}
                      onValueChange={(value) =>
                        onFieldChange(slot.field.name, value, slot.field.type)
                      }
                      relationTarget={slot.field.relation?.target}
                      relationMany={slot.field.relation?.many}
                      disabled={disabled}
                    />
                  )
              )}
            </ul>
            {renderGroupFooter?.(group)}
          </div>
        ))}
      </SortableContext>
    </DndContext>
  )
})

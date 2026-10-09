/**
 * B1: "Edit tag" on the tag page. A right sheet beside the table (not a modal),
 * so a field change shows up as a column while the sheet stays open.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import {
  COLOR_NAMES,
  getTagColors,
  isHexColor,
  withAlpha
} from '@/components/note/tags-row/tag-colors'
import { TagIconChip } from '@/components/settings/tag-icon-chip'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import { useTagCategories } from '@/hooks/use-tag-categories'
import { Hash, Tag, Trash2, X } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { tagsService } from '@/services/tags-service'
import { resolveTag, useTagSchemas } from '../use-tag-schemas'
import { AddFieldPopover } from './AddFieldPopover'
import { ExtendsSelect } from './ExtendsSelect'
import { DeleteTagDialog } from './FieldImpactDialogs'
import { FieldListEditor } from './FieldListEditor'
import { TagTemplateSection } from './TagTemplateSection'
import { tagDisplayName } from '../tag-display-name'

const NO_CATEGORY = '__none__'

interface TagSettingsSheetProps {
  /** The tag as the page names it. */
  tag: string
  onClose: () => void
}

export function TagSettingsSheet({ tag, onClose }: TagSettingsSheetProps): React.JSX.Element {
  const { t } = useT('notes')
  const tagKey = tag.trim().toLowerCase()
  const { data: snapshot } = useTagSchemas()
  const resolved = resolveTag(snapshot, tagKey)
  const { tags: allTags } = useNoteTagsQuery()
  const row = allTags.find((candidate) => candidate.tag.toLowerCase() === tagKey)
  const color = row?.color ?? resolved?.color ?? ''
  const icon = row?.icon ?? resolved?.icon ?? null
  const tint = getTagColors(color, tagKey).text
  const editable = resolved?.editable ?? true
  const [deleteOpen, setDeleteOpen] = useState(false)

  const counts = useQuery({
    queryKey: ['tags', 'preview-impact', { kind: 'delete-tag', tag: tagKey }],
    queryFn: () => tagsService.previewImpact({ kind: 'delete-tag', tag: tagKey })
  })
  const objectCounts = counts.data?.kind === 'delete-tag' ? counts.data : null

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const fieldCount = resolved?.effectiveFields.length ?? 0
  const sectionLabel = (text: string): React.JSX.Element => (
    <h3 className="text-[11px] font-medium uppercase tracking-wider text-text-tertiary">{text}</h3>
  )

  return (
    <aside
      role="complementary"
      aria-label={t('tagFields.settings.title', { tag })}
      className="absolute inset-y-0 end-0 z-30 flex w-[440px] max-w-full flex-col border-s bg-background shadow-xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150"
    >
      <header className="flex items-start gap-3 px-5 pb-4 pt-5">
        <div
          className="flex size-8 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: withAlpha(tint, 0.12), color: tint }}
        >
          {icon ? (
            <NoteIconDisplay value={icon} className="size-4 text-[15px] leading-none" />
          ) : (
            <Tag className="size-4" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] font-semibold">#{tag}</span>
          <span className="text-xs text-text-tertiary">
            {objectCounts && resolved?.hasFields
              ? t('tagFields.settings.onCounts', {
                  notes: objectCounts.notes,
                  tasks: objectCounts.tasks
                })
              : t('tagFields.settings.onNotes', { count: row?.count ?? 0 })}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={onClose}
          aria-label={t('tagFields.settings.close')}
        >
          <X className="size-4" />
        </Button>
      </header>

      <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-5 pb-6">
        {!editable && (
          <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-text-secondary">
            {t('tagFields.settings.newerVersion')}
          </p>
        )}

        <section className="flex flex-col gap-2.5">
          {sectionLabel(t('tagFields.settings.sections.appearance'))}
          <AppearanceRow tag={tag} tagKey={tagKey} color={color} icon={icon} />
        </section>

        <section className="flex flex-col gap-2.5">
          {sectionLabel(t('tagFields.settings.sections.extends'))}
          <ExtendsSelect tagKey={tagKey} tag={resolved} snapshot={snapshot} disabled={!editable} />
        </section>

        <section className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            {sectionLabel(t('tagFields.settings.sections.fields', { count: fieldCount }))}
            <AddFieldPopover
              tagKey={tagKey}
              tag={resolved}
              snapshot={snapshot}
              disabled={!editable}
            />
          </div>
          <FieldListEditor tagKey={tagKey} tag={resolved} />
        </section>

        <TagTemplateSection
          tagKey={tagKey}
          tag={resolved}
          disabled={!editable}
          label={sectionLabel(t('tagFields.settings.sections.template'))}
        />
      </div>

      <footer className="flex items-center justify-between border-t px-5 py-3">
        <span className="text-xs text-text-tertiary">{t('tagFields.settings.syncNote')}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs text-destructive hover:text-destructive"
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 className="size-3.5" />
          {t('tagFields.settings.delete.button')}
        </Button>
      </footer>

      <DeleteTagDialog tag={tag} open={deleteOpen} onOpenChange={setDeleteOpen} />
    </aside>
  )
}

interface AppearanceRowProps {
  tag: string
  tagKey: string
  color: string
  icon: string | null
}

/** Icon, colour and category, through the same tag calls the Tags hub uses. */
function AppearanceRow({ tag, tagKey, color, icon }: AppearanceRowProps): React.JSX.Element {
  const { t } = useT('notes')
  const { categories, reorder } = useTagCategories()
  const category = categories.find((candidate) =>
    candidate.tags.some((row) => row.tag.toLowerCase() === tagKey)
  )

  const run = async (
    action: () => Promise<{ success: boolean; error?: string }>,
    fallbackKey: string
  ): Promise<void> => {
    try {
      const result = await action()
      if (!result.success) throw new Error(result.error ?? t(fallbackKey))
    } catch (err) {
      toast.error(extractErrorMessage(err, t(fallbackKey)))
    }
  }

  const changeCategory = async (value: string): Promise<void> => {
    const categoryId = value === NO_CATEGORY ? null : value
    const target = categories.find((candidate) => candidate.id === categoryId)
    try {
      await reorder({ tags: [{ tag, categoryId, sortOrder: target?.tags.length ?? 0 }] })
    } catch (err) {
      toast.error(extractErrorMessage(err, t('tagFields.settings.errors.category')))
    }
  }

  const swatch = (name: string): React.JSX.Element => (
    <span
      className="size-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: getTagColors(name, tagKey).text }}
    />
  )

  return (
    <div className="grid grid-cols-3 gap-2">
      <div className="flex h-8 items-center gap-1.5 rounded-md border px-1.5 text-sm">
        <TagIconChip
          icon={icon}
          color={getTagColors(color, tagKey).text}
          onIconChange={(next) =>
            void run(
              () => tagsService.updateTagIcon({ tag, icon: next }),
              'tagFields.settings.errors.icon'
            )
          }
        />
        <span className="truncate">{t('tagFields.settings.appearance.icon')}</span>
      </div>

      <Select
        value={isHexColor(color) || !color ? undefined : color}
        onValueChange={(next) =>
          void run(
            () => tagsService.updateTagColor({ tag, color: next }),
            'tagFields.settings.errors.color'
          )
        }
      >
        <SelectTrigger className="h-8" aria-label={t('tagFields.settings.appearance.color')}>
          <span className="flex min-w-0 items-center gap-1.5">
            {swatch(color)}
            <span className="truncate">
              {isHexColor(color)
                ? t('tagFields.settings.appearance.customColor')
                : tagDisplayName(color || t('tagFields.settings.appearance.color'))}
            </span>
          </span>
        </SelectTrigger>
        <SelectContent>
          {COLOR_NAMES.map((name) => (
            <SelectItem key={name} value={name}>
              <span className="flex items-center gap-1.5">
                {swatch(name)}
                {tagDisplayName(name)}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={category?.id ?? NO_CATEGORY} onValueChange={(v) => void changeCategory(v)}>
        <SelectTrigger className="h-8" aria-label={t('tagFields.settings.appearance.category')}>
          <div className="flex min-w-0 items-center gap-1.5">
            <Hash className="size-3.5 shrink-0 text-text-tertiary" />
            <span className="truncate">
              {category?.name ?? t('tagFields.settings.appearance.noCategory')}
            </span>
          </div>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_CATEGORY}>
            {t('tagFields.settings.appearance.noCategory')}
          </SelectItem>
          {categories.map((candidate) => (
            <SelectItem key={candidate.id} value={candidate.id}>
              {candidate.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

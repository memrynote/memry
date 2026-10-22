import { useEffect, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  isWikiLinkSize,
  type WikiLinkDisplayProps,
  type WikiLinkSize
} from '@memry/shared/wiki-link-props'
import { useT } from '@memry/i18n/renderer'
import { loadWikiLinkCardContent } from './wiki-link-card-data'

const SIZES: WikiLinkSize[] = ['none', 'small', 'medium']

/**
 * The display settings of a link alone in its paragraph (#2845): a size and
 * two switches, drawn as the "Note link display" Paper panel.
 *
 * It keeps its own copy of the settings. The menu is opened on the link as it
 * was then, and the panel stays open across several changes, so it has to show
 * what the user has just picked rather than what the link was.
 */
export function WikiLinkDisplayPanel({
  target,
  display,
  onChange
}: {
  /** The note the link names, whose cover decides whether there is one to show. */
  target: string
  display: WikiLinkDisplayProps
  onChange: (patch: Partial<WikiLinkDisplayProps>) => void
}) {
  const { t } = useT('notes')
  const [current, setCurrent] = useState(display)
  const [noteHasCover, setNoteHasCover] = useState(false)

  useEffect(() => {
    let cancelled = false
    void loadWikiLinkCardContent(target).then((content) => {
      if (!cancelled) setNoteHasCover(Boolean(content?.cover))
    })
    return () => {
      cancelled = true
    }
  }, [target])
  const labels: Record<WikiLinkSize, string> = {
    none: t('wikiLinkMenu.sizeNone'),
    small: t('wikiLinkMenu.sizeSmall'),
    medium: t('wikiLinkMenu.sizeMedium')
  }

  const apply = (patch: Partial<WikiLinkDisplayProps>) => {
    setCurrent((prev) => ({ ...prev, ...patch }))
    onChange(patch)
  }

  return (
    <div
      data-testid="wiki-link-display-panel"
      className="flex w-[300px] flex-col gap-3.5 p-4"
      // Menu typeahead and arrow keys would otherwise steal focus from the controls.
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'Escape') event.stopPropagation()
      }}
    >
      <ToggleGroup
        type="single"
        value={current.size}
        onValueChange={(size) => {
          // Radix reports '' when the pressed item is pressed again; a size always stays set.
          if (isWikiLinkSize(size)) apply({ size })
        }}
        className="gap-0.5 rounded-lg bg-surface p-[3px]"
      >
        {SIZES.map((size) => (
          <ToggleGroupItem
            key={size}
            value={size}
            aria-label={labels[size]}
            className="h-7 flex-1 rounded-md px-0 text-[13px] font-medium text-text-secondary data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
          >
            {labels[size]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {/* A plain chip has no room for a cover, and a note with no cover has none to
          show, so the switch is absent rather than disabled. It also stays absent
          while the note loads. The stored value is left alone either way. */}
      {current.size !== 'none' && noteHasCover && (
        <SwitchRow
          label={t('wikiLinkMenu.showCover')}
          checked={current.cover}
          onCheckedChange={(cover) => apply({ cover })}
        />
      )}
      <SwitchRow
        label={t('wikiLinkMenu.showPreview')}
        checked={current.preview}
        onCheckedChange={(preview) => apply({ preview })}
      />
    </div>
  )
}

function SwitchRow({
  label,
  checked,
  onCheckedChange
}: {
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm text-foreground">
      <span>{label}</span>
      <Switch aria-label={label} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

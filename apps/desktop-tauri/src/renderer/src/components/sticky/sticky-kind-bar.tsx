import type { StickyKind } from '@memry/contracts/sticky-api'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'

interface StickyKindBarProps {
  kinds: readonly StickyKind[]
  value: StickyKind
  onChange: (kind: StickyKind) => void
  modKey: string
}

/** Note, Task, Journal: where the text goes. ⌘1 to ⌘3 pick one. */
export function StickyKindBar({
  kinds,
  value,
  onChange,
  modKey
}: StickyKindBarProps): React.JSX.Element {
  const { t } = useT('inbox')

  return (
    <div role="radiogroup" aria-label={t('sticky.kindLabel')} className="flex items-center gap-0.5">
      {kinds.map((kind, index) => {
        const selected = kind === value
        return (
          <button
            key={kind}
            type="button"
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA role kept: the semantic tag (output/progress/fieldset/etc.) brings default styling/semantics that would change the layout
            role="radio"
            aria-checked={selected}
            title={`${modKey}${index + 1}`}
            onClick={() => onChange(kind)}
            className={cn(
              'no-drag rounded-full px-2.5 py-1 text-[12px]/4 font-medium transition-colors duration-150',
              'focus-visible:outline-2 focus-visible:outline-[var(--tint)]',
              selected
                ? 'bg-foreground/[0.08] text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {t(`sticky.kinds.${kind}`)}
          </button>
        )
      })}
    </div>
  )
}

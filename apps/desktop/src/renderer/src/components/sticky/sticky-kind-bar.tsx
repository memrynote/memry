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
            role="radio"
            aria-checked={selected}
            title={`${modKey}${index + 1}`}
            onClick={() => onChange(kind)}
            className={cn(
              'no-drag rounded-full px-2.5 py-1 text-[12px]/4 font-medium transition-colors duration-150',
              'focus-visible:outline-2 focus-visible:outline-[var(--tint)]',
              selected ? 'bg-black/[0.08]' : 'opacity-55 hover:opacity-90'
            )}
          >
            {t(`sticky.kinds.${kind}`)}
          </button>
        )
      })}
    </div>
  )
}

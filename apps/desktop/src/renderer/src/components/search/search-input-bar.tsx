import { Command } from 'cmdk'
import { Loader2, Search, X } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'
import { SearchKbd } from './search-row'

export interface SearchChip {
  key: string
  icon: React.ReactNode
  label: string
  onRemove: () => void
}

interface SearchInputBarProps {
  value: string
  onValueChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  placeholder: string
  /** Ghost text shown right after the typed value, e.g. after a lone "/". */
  hint: string | null
  chips: SearchChip[]
  loading: boolean
}

export function SearchInputBar({
  value,
  onValueChange,
  onKeyDown,
  placeholder,
  hint,
  chips,
  loading
}: SearchInputBarProps): React.JSX.Element {
  const { t } = useT('common')
  const Icon = loading ? Loader2 : Search
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border pe-4 ps-[18px]">
      <Icon
        className={`size-4 shrink-0 text-text-tertiary ${loading ? 'animate-spin' : ''}`}
        aria-hidden="true"
      />
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface pe-1 ps-[7px]"
        >
          <span className="flex size-3.5 items-center justify-center text-text-tertiary [&_svg]:size-[13px]">
            {chip.icon}
          </span>
          <span className="text-xs font-medium leading-4 text-foreground">{chip.label}</span>
          <button
            type="button"
            tabIndex={-1}
            aria-label={t('searchPalette.removeFilter', { name: chip.label })}
            onClick={chip.onRemove}
            className="flex size-4 items-center justify-center rounded-sm text-text-tertiary
              hover:bg-surface-active hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <div className="relative flex min-w-0 flex-1 items-center">
        <Command.Input
          value={value}
          onValueChange={onValueChange}
          onKeyDown={onKeyDown}
          placeholder={chips.length > 0 ? '' : placeholder}
          autoFocus
          className="h-14 w-full border-0 bg-transparent text-[15px] leading-5 text-foreground caret-[var(--tint)]
            placeholder:text-text-tertiary focus:outline-none focus:ring-0"
        />
        {hint && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 start-0 flex items-center whitespace-pre text-[15px] leading-5"
          >
            <span className="invisible">{value}</span>
            <span className="ps-1.5 text-text-tertiary">{hint}</span>
          </div>
        )}
      </div>
      <SearchKbd>{t('searchPalette.keys.esc')}</SearchKbd>
    </div>
  )
}

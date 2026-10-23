import { useTheme } from 'next-themes'
import {
  COLOR_THEMES,
  findColorTheme,
  resolveModePalettes,
  type PaletteMode
} from '@memry/contracts/color-themes'
import { useT } from '@memry/i18n/renderer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ThemeSwatch } from '@/pages/settings/appearance-theme-controls'
import { Check, ChevronDown } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { MUTED } from '../wizard-ui'

const K = 'onboardingWizard.theme'

/** The editor themes Settings offers (Nord, Dracula...), one dropdown under the mode cards. */
export function MoreThemes({
  value,
  onChange
}: {
  value: string | null
  onChange: (editorTheme: string | null) => void
}): React.JSX.Element {
  const { t } = useT('common')
  const { resolvedTheme } = useTheme()
  const mode: PaletteMode = resolvedTheme === 'dark' ? 'dark' : 'light'
  const active = findColorTheme(value)
  const swatch = (id: string): React.JSX.Element => (
    <ThemeSwatch palette={resolveModePalettes({ colorTheme: id })[mode]} />
  )

  return (
    <div className="flex items-center gap-2.5 pt-6">
      <span className={cn('text-[13px]', MUTED)}>{t(`${K}.more`)}</span>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex h-8 items-center gap-2 rounded-md border border-border ps-1.5 pe-2.5 text-[13px] font-medium text-foreground hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {active ? swatch(active.id) : null}
          {active?.name ?? t(`${K}.moreNone`)}
          <ChevronDown className="size-3 text-text-tertiary" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="max-h-72 w-56 overflow-y-auto">
          <DropdownMenuItem
            onSelect={() => {
              onChange(null)
            }}
          >
            <span className="flex-1 text-foreground">{t(`${K}.moreNone`)}</span>
            {!active && <Check className="size-3.5 text-foreground" />}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {COLOR_THEMES.map((theme) => (
            <DropdownMenuItem
              key={theme.id}
              onSelect={() => {
                onChange(theme.id)
              }}
            >
              {swatch(theme.id)}
              <span className="flex-1 text-foreground">{theme.name}</span>
              {active?.id === theme.id && <Check className="size-3.5 text-foreground" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

import type { Dispatch } from 'react'
import { useTheme } from 'next-themes'
import { applyColorTheme } from '@memry/contracts/color-themes'
import type { FeatureKey } from '@memry/contracts/feature-flags'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Cloud, FileText, LayoutGrid, Lock, Sparkles } from '@/lib/icons'
import {
  PageCalendarIcon,
  PageGraphIcon,
  PageHomeIcon,
  PageInboxIcon,
  PageJournalIcon,
  PageTasksIcon
} from '@/lib/icons/page-icons'
import { cn } from '@/lib/utils'
import {
  themeSettingsFor,
  type ThemeChoice,
  type WizardAction,
  type WizardState
} from '../wizard-model'
import {
  BRAND_COLOR,
  ContinueButton,
  MUTED,
  OptionCard,
  OptionList,
  SELECTED_RING,
  StepHeading,
  SwitchMark,
  useDeviceLabel
} from '../wizard-ui'
import { MoreThemes } from './more-themes'

export interface StepProps {
  state: WizardState
  dispatch: Dispatch<WizardAction>
}

const K = 'onboardingWizard'

/** The Memry mark, as in the vault picker. */
function MemryMark(): React.JSX.Element {
  return (
    <svg
      className={cn('h-[27px] w-[34px]', BRAND_COLOR)}
      viewBox="0 0 680 547"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M652 345C667.464 345 680 357.536 680 373V519C680 534.464 667.464 547 652 547H28C12.536 547 3.70473e-07 534.464 0 519V373C1.99733e-06 357.536 12.536 345 28 345H652ZM510 0C603.169 0 678.727 75.3938 678.997 168.5H678.879L678.771 168.556L344.632 341.046C341.572 341.635 338.427 341.635 335.367 341.046L1.22949 168.556L1.12109 168.5H1.00293C1.27258 75.3938 76.8306 0 170 0C263.169 0 338.727 75.3938 338.997 168.5H341.003C341.273 75.3938 416.831 0 510 0Z" />
    </svg>
  )
}

export function WelcomeStep({ dispatch }: StepProps): React.JSX.Element {
  const { t } = useT('common')
  const device = useDeviceLabel()
  return (
    <div className="flex flex-col items-center pt-[60px]">
      <MemryMark />
      <div className="flex max-w-[35rem] flex-col items-center gap-3 pt-[26px] text-center">
        <h1 className="font-serif text-[42px] font-medium leading-[46px] tracking-[-0.015em] text-foreground text-balance">
          {t(`${K}.welcome.title`)}
        </h1>
        <p className={cn('max-w-[27.5rem] text-[15px] leading-[23px] text-balance', MUTED)}>
          {t(`${K}.welcome.body`, { device })}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-[18px] gap-y-3 pt-7">
        <ContinueButton
          label={t(`${K}.welcome.getStarted`)}
          brand
          onClick={() => {
            dispatch({ type: 'start', path: 'new' })
          }}
        />
        <span className={cn('flex items-center gap-1 text-[13px]', MUTED)}>
          {t(`${K}.welcome.alreadyUse`)}
          <Button
            variant="link"
            className="h-auto p-0 text-[13px] font-semibold text-foreground"
            onClick={() => {
              dispatch({ type: 'start', path: 'returning' })
            }}
          >
            {t(`${K}.welcome.signIn`)}
          </Button>
        </span>
      </div>
    </div>
  )
}

/**
 * Each theme's own canvas, sidebar, rail, line and ink, so a thumbnail shows
 * that theme whatever the wizard is painted in. Mirrors base.css.
 */
const SWATCH: Record<Exclude<ThemeChoice, 'system'>, Record<string, string>> = {
  white: { bg: '#ffffff', side: '#fbfbfb', rail: '#f3f3f3', line: '#ebebec', ink: '#1d1f22' },
  light: { bg: '#f6f5f0', side: '#efefe9', rail: '#e4e4de', line: '#e4e4de', ink: '#1a1a1a' },
  dark: { bg: '#181818', side: '#1f1f1f', rail: '#282828', line: '#2e2e2e', ink: '#dedede' }
}

function ThemeWindow({ theme }: { theme: Exclude<ThemeChoice, 'system'> }): React.JSX.Element {
  const c = SWATCH[theme]
  const bar = (
    width: string,
    height: string,
    opacity: number,
    color = c.ink
  ): React.JSX.Element => (
    <span
      className="block shrink-0 rounded-[2px]"
      style={{ width, height, opacity, backgroundColor: color }}
    />
  )
  return (
    <span className="flex h-full w-[132px] shrink-0" style={{ backgroundColor: c.bg }}>
      <span className="h-full w-3 shrink-0" style={{ backgroundColor: c.rail }} />
      <span
        className="flex h-full w-[34px] shrink-0 flex-col gap-[5px] border-e px-[5px] py-2.5"
        style={{ backgroundColor: c.side, borderColor: c.line }}
      >
        {bar('20px', '3px', 0.55)}
        {bar('16px', '3px', 0.3)}
        {bar('18px', '3px', 0.3)}
      </span>
      <span className="flex grow flex-col gap-1.5 px-2.5 py-3">
        {bar('46px', '6px', 1)}
        {bar('62px', '3px', 0.35)}
        {bar('54px', '3px', 0.35)}
        {bar('24px', '3px', 1, 'var(--tint)')}
      </span>
    </span>
  )
}

function ThemeThumb({ theme }: { theme: ThemeChoice }): React.JSX.Element {
  if (theme !== 'system') return <ThemeWindow theme={theme} />
  // System: the light half meets the dark half in the middle.
  return (
    <span className="flex h-full w-full">
      <span className="flex h-full w-1/2 overflow-hidden">
        <ThemeWindow theme="white" />
      </span>
      <span className="flex h-full w-1/2 justify-end overflow-hidden">
        <ThemeWindow theme="dark" />
      </span>
    </span>
  )
}

const THEMES: ThemeChoice[] = ['system', 'white', 'light', 'dark']

const THEME_HINT: Record<ThemeChoice, string> = {
  system: 'systemHint',
  white: 'whiteHint',
  light: 'lightHint',
  dark: 'darkHint'
}

export function ThemeStep({ state, dispatch }: StepProps): React.JSX.Element {
  const { t } = useT('common')
  const { setTheme } = useTheme()
  const paint = (choice: ThemeChoice, editorTheme: string | null): void => {
    const settings = themeSettingsFor(choice, editorTheme)
    dispatch({ type: 'update', patch: { theme: settings.theme, editorTheme } })
    // Live preview on the whole wizard; the vault gets the same values on open.
    setTheme(settings.theme)
    applyColorTheme(document.documentElement, { colorTheme: settings.colorTheme })
  }
  // The Light card is the Warm theme, so it clears an editor theme; the others keep it.
  const pick = (choice: ThemeChoice): void => {
    paint(choice, choice === 'light' ? null : state.draft.editorTheme)
  }
  // An editor theme has no Warm side: on the Light card it shows its own light palette (White).
  const pickEditorTheme = (editorTheme: string | null): void => {
    paint(state.draft.theme === 'light' && editorTheme ? 'white' : state.draft.theme, editorTheme)
  }
  return (
    <>
      <StepHeading title={t(`${K}.theme.title`)} body={t(`${K}.theme.body`)} />
      <OptionList
        role="radiogroup"
        orientation="horizontal"
        label={t(`${K}.theme.title`)}
        className="flex-wrap justify-center gap-[18px] pt-[30px]"
      >
        {THEMES.map((id) => {
          const selected = state.draft.theme === id
          return (
            <button
              key={id}
              type="button"
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA widget pattern; native tag would change styling or behavior
              role="radio"
              aria-checked={selected}
              data-wizard-option
              onClick={() => {
                pick(id)
              }}
              // A radio follows focus, so arrowing through the row picks as it goes.
              onFocus={
                selected
                  ? undefined
                  : () => {
                      pick(id)
                    }
              }
              className="group flex w-[132px] flex-col items-center gap-2.5 rounded-[10px] focus-visible:outline-none"
            >
              <span
                className={cn(
                  'flex h-[88px] w-[132px] overflow-hidden rounded-[10px] transition-shadow duration-150 motion-reduce:transition-none',
                  selected
                    ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background'
                    : 'ring-1 ring-border group-hover:ring-text-tertiary',
                  'group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-background'
                )}
              >
                <ThemeThumb theme={id} />
              </span>
              <span className="flex flex-col items-center gap-px">
                <span
                  className={cn(
                    'text-[13px] leading-4 text-foreground',
                    selected ? 'font-semibold' : 'font-medium'
                  )}
                >
                  {t(`${K}.theme.${id}`)}
                </span>
                <span className={cn('text-[11.5px] leading-[14px]', MUTED)}>
                  {t(`${K}.theme.${THEME_HINT[id]}`)}
                </span>
              </span>
            </button>
          )
        })}
      </OptionList>
      <MoreThemes value={state.draft.editorTheme} onChange={pickEditorTheme} />
    </>
  )
}

/** Notes is always on; the rest map to stored feature flags, plus AI. */
export type ModuleKey = FeatureKey | 'ai'

const MODULE_ICON: Record<ModuleKey, React.ComponentType<{ className?: string }>> = {
  home: PageHomeIcon,
  inbox: PageInboxIcon,
  journal: PageJournalIcon,
  tasks: PageTasksIcon,
  calendar: PageCalendarIcon,
  graph: PageGraphIcon,
  spatialCanvas: LayoutGrid,
  ai: Sparkles
}

/** Two columns, read top to bottom; Notes heads the first and cannot be turned off. */
const MODULE_COLUMNS: ModuleKey[][] = [
  ['home', 'inbox', 'journal', 'tasks'],
  ['calendar', 'graph', 'spatialCanvas', 'ai']
]

const MODULE_ROW = 'flex h-[34px] w-full items-center gap-2.5 rounded-md px-2.5'

export function ModulesStep({
  state,
  dispatch,
  focused,
  onFocusModule
}: StepProps & {
  focused: ModuleKey
  onFocusModule: (key: ModuleKey) => void
}): React.JSX.Element {
  const { t } = useT('common')
  const device = useDeviceLabel()
  const { features, aiEnabled } = state.draft
  const isOn = (key: ModuleKey): boolean => (key === 'ai' ? aiEnabled : features[key])
  const toggle = (key: ModuleKey): void => {
    onFocusModule(key)
    dispatch({
      type: 'update',
      patch:
        key === 'ai'
          ? { aiEnabled: !aiEnabled }
          : { features: { ...features, [key]: !features[key] } }
    })
  }
  const row = (key: ModuleKey): React.JSX.Element => {
    const Icon = MODULE_ICON[key]
    const on = isOn(key)
    return (
      <button
        key={key}
        type="button"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA widget pattern; native tag would change styling or behavior
        role="checkbox"
        aria-checked={on}
        data-wizard-option
        onClick={() => {
          toggle(key)
        }}
        onFocus={() => {
          onFocusModule(key)
        }}
        onMouseEnter={() => {
          onFocusModule(key)
        }}
        className={cn(
          MODULE_ROW,
          'text-start transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
          focused === key ? SELECTED_RING : 'hover:bg-surface/60'
        )}
      >
        <Icon className={cn('size-4 shrink-0', on ? 'text-foreground' : 'text-text-tertiary')} />
        <span className="grow text-[13px] font-medium leading-4 text-foreground">
          {t(`${K}.modules.${key}`)}
        </span>
        <span className="flex w-16 shrink-0 justify-end">
          <SwitchMark on={on} />
        </span>
      </button>
    )
  }
  return (
    <>
      <StepHeading title={t(`${K}.modules.title`)} body={t(`${K}.modules.body`)} />
      <OptionList
        label={t(`${K}.modules.title`)}
        orientation="vertical"
        className="flex-row flex-wrap justify-center gap-x-4 gap-y-0.5 pt-6"
      >
        {MODULE_COLUMNS.map((column, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- static positional list; items have no id and never reorder
          <div key={index} className="flex w-[260px] flex-col gap-0.5">
            {index === 0 && (
              <div className={MODULE_ROW}>
                <FileText className="size-4 shrink-0 text-foreground" />
                <span className="grow text-[13px] font-medium leading-4 text-foreground">
                  {t(`${K}.modules.notes`)}
                </span>
                <span className={cn('w-16 shrink-0 text-end text-[11.5px]', MUTED)}>
                  {t(`${K}.modules.alwaysOn`)}
                </span>
              </div>
            )}
            {column.map(row)}
          </div>
        ))}
      </OptionList>
      <p
        className={cn('min-h-10 max-w-[536px] pt-5 text-center text-[12.5px] leading-4', MUTED)}
        aria-live="polite"
      >
        {t(`${K}.modules.hint.${focused}`, { device })}
      </p>
    </>
  )
}

export function StorageStep({ state, dispatch }: StepProps): React.JSX.Element {
  const { t } = useT('common')
  const device = useDeviceLabel()
  const pick = (storage: 'local' | 'sync'): void => {
    dispatch({ type: 'update', patch: { storage } })
  }
  return (
    <>
      <StepHeading title={t(`${K}.storage.title`)} body={t(`${K}.storage.body`)} />
      <OptionList
        role="radiogroup"
        label={t(`${K}.storage.title`)}
        className="w-full max-w-[520px] gap-2.5 pt-6"
      >
        <OptionCard
          kind="radio"
          icon={<Lock />}
          selected={state.draft.storage === 'local'}
          onSelect={() => {
            pick('local')
          }}
          title={t(`${K}.storage.local`, { device })}
          trailing={t(`${K}.storage.localPrice`)}
          description={t(`${K}.storage.localHint`)}
        />
        <OptionCard
          kind="radio"
          icon={<Cloud />}
          selected={state.draft.storage === 'sync'}
          onSelect={() => {
            pick('sync')
          }}
          title={t(`${K}.storage.sync`)}
          trailing={t(`${K}.storage.syncPrice`)}
          description={t(`${K}.storage.syncHint`)}
        />
      </OptionList>
      <p className={cn('flex items-center gap-1.5 pt-[18px] text-xs', MUTED)}>
        <Lock className="size-3" />
        {t(`${K}.storage.footnote`)}
      </p>
    </>
  )
}

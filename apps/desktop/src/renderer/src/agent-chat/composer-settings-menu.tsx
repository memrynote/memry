import { Fragment, useState } from 'react'

import type {
  AgentAccessMode,
  AgentBackendModelOption,
  AgentCliBackendId,
  CodexReasoningEffort,
  ClaudeEffort
} from '@memry/contracts/ipc-agent'
import { useT } from '@memry/i18n/renderer'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { Check, ChevronDown, Search } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { AgentProvider } from './agent-model-preference'

export type ReasoningOption<Value extends string> = {
  value: Value
  labelKey: string
  summaryKey: string
}

export const claudeReasoningOptions: Array<ReasoningOption<ClaudeEffort>> = [
  {
    value: 'low',
    labelKey: 'agentChat.composer.claudeSettings.reasoning.low',
    summaryKey: 'agentChat.composer.claudeSettings.reasoning.low'
  },
  {
    value: 'medium',
    labelKey: 'agentChat.composer.claudeSettings.reasoning.medium',
    summaryKey: 'agentChat.composer.claudeSettings.reasoning.medium'
  },
  {
    value: 'high',
    labelKey: 'agentChat.composer.claudeSettings.reasoning.high',
    summaryKey: 'agentChat.composer.claudeSettings.reasoning.high'
  },
  {
    value: 'xhigh',
    labelKey: 'agentChat.composer.claudeSettings.reasoning.extraHighDefault',
    summaryKey: 'agentChat.composer.claudeSettings.reasoning.extraHigh'
  },
  {
    value: 'max',
    labelKey: 'agentChat.composer.claudeSettings.reasoning.max',
    summaryKey: 'agentChat.composer.claudeSettings.reasoning.max'
  }
]

export const codexReasoningOptions: Array<ReasoningOption<CodexReasoningEffort>> = [
  {
    value: 'low',
    labelKey: 'agentChat.composer.codexSettings.reasoning.low',
    summaryKey: 'agentChat.composer.codexSettings.reasoning.low'
  },
  {
    value: 'medium',
    labelKey: 'agentChat.composer.codexSettings.reasoning.mediumDefault',
    summaryKey: 'agentChat.composer.codexSettings.reasoning.medium'
  },
  {
    value: 'high',
    labelKey: 'agentChat.composer.codexSettings.reasoning.high',
    summaryKey: 'agentChat.composer.codexSettings.reasoning.high'
  },
  {
    value: 'xhigh',
    labelKey: 'agentChat.composer.codexSettings.reasoning.extraHigh',
    summaryKey: 'agentChat.composer.codexSettings.reasoning.extraHigh'
  }
]

interface ComposerSettingsMenuProps {
  ariaLabel: string
  summaryLabel: string
  providerReady: boolean
  webSearchEnabled: boolean
  includeCurrentNote: boolean
  accessMode: AgentAccessMode
  selectedProvider: AgentProvider
  selectedBackendModel: string | null
  effectiveLocalModel: string | null
  showEffort: boolean
  effortSummary: string
  reasoningOptions: ReadonlyArray<ReasoningOption<ClaudeEffort | CodexReasoningEffort>>
  selectedReasoningValue: ClaudeEffort | CodexReasoningEffort
  currentModelValueLabel: string
  claudeAvailable: boolean
  codexAvailable: boolean
  antigravityAvailable: boolean
  /**
   * The agent runtime itself failed to start (vault key unavailable), so every
   * backend reports unavailable. Distinct from a missing CLI: telling the user
   * to install Claude Code when the CLI is already installed sends them down
   * the wrong path entirely.
   */
  agentRuntimeUnavailable: boolean
  claudeCatalog: AgentBackendModelOption[]
  codexCatalog: AgentBackendModelOption[]
  antigravityCatalog: AgentBackendModelOption[]
  localSettingsLoaded: boolean
  localConfigured: boolean
  localModelIds: string[]
  onOpenChange: (open: boolean) => void
  onToggleWebSearch: () => void
  onToggleIncludeCurrentNote: () => void
  onSelectAccessMode: (mode: AgentAccessMode) => void
  onSelectReasoning: (value: ClaudeEffort | CodexReasoningEffort) => void
  onSelectCliModel: (backend: AgentCliBackendId, model: string) => void
  onSelectLocalModel: (model: string) => void
  onOpenProviderSettings: () => void
}

interface CliSection {
  backend: AgentCliBackendId
  labelKey: string
  available: boolean
  models: AgentBackendModelOption[]
}

function matchesQuery(query: string, label: string, id?: string): boolean {
  return (
    query.length === 0 ||
    label.toLowerCase().includes(query) ||
    (id ?? '').toLowerCase().includes(query)
  )
}

/**
 * One list per CLI backend, filtered by the model search box.
 *
 * Lives outside the component because the three sections are identical apart
 * from their label: a fourth backend is a row here rather than another copy of
 * the menu markup.
 */
function cliSectionsFor(props: ComposerSettingsMenuProps, query: string): CliSection[] {
  const sections: CliSection[] = [
    {
      backend: 'claude_cli',
      labelKey: 'agentChat.composer.providers.claude',
      available: props.claudeAvailable,
      models: props.claudeCatalog
    },
    {
      backend: 'codex_cli',
      labelKey: 'agentChat.composer.providers.codex',
      available: props.codexAvailable,
      models: props.codexCatalog
    },
    {
      backend: 'antigravity_cli',
      labelKey: 'agentChat.composer.providers.antigravity',
      available: props.antigravityAvailable,
      models: props.antigravityCatalog
    }
  ]
  return sections.map((section) => ({
    ...section,
    models: section.models.filter((model) => matchesQuery(query, model.label, model.id))
  }))
}

/**
 * Backend a typed-in model id would be sent to: the selected one when it is
 * usable, otherwise the first detected CLI, and null when none is detected.
 */
function customModelBackendFor(
  sections: CliSection[],
  selectedProvider: AgentProvider
): AgentCliBackendId | null {
  const available = sections.filter((section) => section.available)
  return (
    available.find((section) => section.backend === selectedProvider)?.backend ??
    available[0]?.backend ??
    null
  )
}

const sectionLabelClass =
  'px-2 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground'
const valueClass = 'ms-auto text-muted-foreground'
const selectedCheck = <Check className="ms-auto size-3 text-muted-foreground" aria-hidden="true" />

export function ComposerSettingsMenu(props: ComposerSettingsMenuProps): React.JSX.Element {
  const { t } = useT('common')
  const [open, setOpen] = useState(false)
  const [modelQuery, setModelQuery] = useState('')

  const handleOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen)
    if (!nextOpen) setModelQuery('')
    props.onOpenChange(nextOpen)
  }
  const closeAfterPick = (): void => {
    setOpen(false)
    setModelQuery('')
  }

  const normalizedQuery = modelQuery.trim().toLowerCase()
  const localModelIds = props.localModelIds.filter((id) => matchesQuery(normalizedQuery, id))
  const cliSections = cliSectionsFor(props, normalizedQuery)
  const visibleCliSections = cliSections.filter(
    (section) => section.available && section.models.length > 0
  )
  const anyCliVisible = visibleCliSections.length > 0
  const customModelBackend = customModelBackendFor(cliSections, props.selectedProvider)
  const showCustomModelRow =
    normalizedQuery.length > 0 && !anyCliVisible && customModelBackend !== null
  const pickFirstVisibleModel = (): void => {
    const firstCli = visibleCliSections[0]
    if (firstCli?.models[0]) {
      props.onSelectCliModel(firstCli.backend, firstCli.models[0].id)
    } else if (props.localConfigured && localModelIds[0]) {
      props.onSelectLocalModel(localModelIds[0])
    } else if (showCustomModelRow && customModelBackend) {
      props.onSelectCliModel(customModelBackend, modelQuery.trim())
    } else {
      return
    }
    closeAfterPick()
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={props.ariaLabel}
          data-testid="agent-model-trigger"
          className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent"
        >
          <span
            className={cn(
              'truncate text-[13px] leading-[18px]',
              props.providerReady ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            {props.summaryLabel}
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56 border-border/60 p-1.5">
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault()
            props.onToggleWebSearch()
          }}
          className="justify-between gap-6"
        >
          <span>{t('agentChat.composer.webSearch.label')}</span>
          <Switch
            checked={props.webSearchEnabled}
            tabIndex={-1}
            className="pointer-events-none"
            aria-label={t('agentChat.composer.webSearch.label')}
          />
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault()
            props.onToggleIncludeCurrentNote()
          }}
          className="justify-between gap-6"
        >
          <span>{t('agentChat.composer.includeCurrentNote')}</span>
          <Switch
            checked={props.includeCurrentNote}
            tabIndex={-1}
            className="pointer-events-none"
            aria-label={t('agentChat.composer.includeCurrentNote')}
          />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span>{t('agentChat.composer.permissions.access')}</span>
            <span className={valueClass}>
              {props.accessMode === 'vault_only'
                ? t('agentChat.composer.access.vaultOnly')
                : t('agentChat.composer.access.computerAccess')}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-44 border-border/60 p-1.5">
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault()
                props.onSelectAccessMode('vault_only')
              }}
            >
              <span>{t('agentChat.composer.access.vaultOnly')}</span>
              {props.accessMode === 'vault_only' && selectedCheck}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault()
                props.onSelectAccessMode('computer_access')
              }}
            >
              <span>{t('agentChat.composer.access.computerAccess')}</span>
              {props.accessMode === 'computer_access' && selectedCheck}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {props.showEffort && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <span>{t('agentChat.composer.settings.effort')}</span>
              <span className={valueClass}>{props.effortSummary}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-44 border-border/60 p-1.5">
              {props.reasoningOptions.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  onSelect={(event) => {
                    event.preventDefault()
                    props.onSelectReasoning(option.value)
                  }}
                >
                  <span>{t(option.labelKey)}</span>
                  {props.selectedReasoningValue === option.value && selectedCheck}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-testid="agent-model-submenu-trigger">
            <span>{t('agentChat.composer.models.label')}</span>
            <span className={valueClass}>{props.currentModelValueLabel}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-60 border-border/60 p-1.5">
            <div className="flex h-8 items-center gap-2 px-2">
              <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                value={modelQuery}
                aria-label={t('agentChat.composer.models.search')}
                placeholder={t('agentChat.composer.models.search')}
                onChange={(event) => setModelQuery(event.target.value)}
                onKeyDown={(event) => {
                  // The menu's typeahead would otherwise swallow every
                  // keystroke; Escape still bubbles so Radix closes.
                  if (event.key === 'Escape') return
                  event.stopPropagation()
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    pickFirstVisibleModel()
                  }
                }}
                className="h-full w-full min-w-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
            <DropdownMenuSeparator />
            {cliSections.map((section) =>
              section.available && section.models.length > 0 ? (
                <Fragment key={section.backend}>
                  <DropdownMenuLabel className={sectionLabelClass}>
                    {t(section.labelKey)}
                  </DropdownMenuLabel>
                  {section.models.map((model) => (
                    <DropdownMenuItem
                      key={model.id}
                      onSelect={() => props.onSelectCliModel(section.backend, model.id)}
                    >
                      <span>{model.label}</span>
                      {props.selectedProvider === section.backend &&
                        props.selectedBackendModel === model.id &&
                        selectedCheck}
                    </DropdownMenuItem>
                  ))}
                </Fragment>
              ) : !section.available && normalizedQuery.length === 0 ? (
                <Fragment key={section.backend}>
                  <DropdownMenuLabel className={sectionLabelClass}>
                    {t(section.labelKey)}
                  </DropdownMenuLabel>
                  <DropdownMenuItem
                    onSelect={props.onOpenProviderSettings}
                    className="text-muted-foreground/70"
                  >
                    <span>
                      {props.agentRuntimeUnavailable
                        ? t('agentChat.composer.models.runtimeUnavailable')
                        : t('agentChat.composer.models.cliSetup')}
                    </span>
                  </DropdownMenuItem>
                </Fragment>
              ) : null
            )}
            {showCustomModelRow && customModelBackend && (
              <DropdownMenuItem
                onSelect={() => props.onSelectCliModel(customModelBackend, modelQuery.trim())}
              >
                <span>
                  {t('agentChat.composer.models.useCustom', { query: modelQuery.trim() })}
                </span>
              </DropdownMenuItem>
            )}
            {props.localSettingsLoaded && !props.localConfigured ? (
              <>
                <DropdownMenuLabel className={sectionLabelClass}>
                  {t('agentChat.composer.providers.local')}
                </DropdownMenuLabel>
                <DropdownMenuItem
                  onSelect={props.onOpenProviderSettings}
                  className="text-muted-foreground/70"
                >
                  <span>{t('agentChat.composer.models.localSetup')}</span>
                </DropdownMenuItem>
              </>
            ) : props.localConfigured && (localModelIds.length > 0 || !normalizedQuery) ? (
              <>
                <DropdownMenuLabel className={sectionLabelClass}>
                  {t('agentChat.composer.providers.local')}
                </DropdownMenuLabel>
                {localModelIds.length > 0 ? (
                  localModelIds.map((modelId) => (
                    <DropdownMenuItem
                      key={modelId}
                      onSelect={() => props.onSelectLocalModel(modelId)}
                    >
                      <span className="truncate">{modelId}</span>
                      {props.selectedProvider === 'local_openai_compatible' &&
                        props.effectiveLocalModel === modelId &&
                        selectedCheck}
                    </DropdownMenuItem>
                  ))
                ) : (
                  <DropdownMenuItem
                    onSelect={props.onOpenProviderSettings}
                    className="text-muted-foreground/70"
                  >
                    <span>{t('agentChat.composer.models.localEmpty')}</span>
                  </DropdownMenuItem>
                )}
              </>
            ) : null}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

import { useCallback, useEffect, useId, useRef, useState } from 'react'

import type {
  AgentBackendId,
  AgentBackendModelList,
  AgentCliBackendId,
  AgentBackendOptions,
  AttachmentInput,
  CodexReasoningEffort,
  ClaudeEffort
} from '@memry/contracts/ipc-agent'
import { DEFAULT_CLAUDE_EFFORT } from '@memry/contracts/ipc-agent'
import { useT } from '@memry/i18n/renderer'

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useActiveTab } from '@/contexts/tabs'
import { ChatGpt, Check, ChevronDown, Claude, Computer, Send, Square } from '@/lib/icons'
import {
  AgentPromptEditor,
  type AgentPromptEditorHandle,
  type AgentPromptValue
} from './agent-prompt-editor'
import { useAgentOptional } from './agent-context'
import type { MentionAttachment } from './mention-icons'
import { RefPicker } from './ref-picker'

interface ComposerProps {
  conversationId: string | null
  sourceWindowId: string | null
}

type AgentProvider = 'claude_cli' | 'codex_cli' | 'local_openai_compatible'

const DEFAULT_CLAUDE_MODEL = 'opus'
const DEFAULT_CODEX_REASONING: CodexReasoningEffort = 'medium'

const DEFAULT_SELECTED_MODELS: Record<AgentCliBackendId, string | null> = {
  claude_cli: DEFAULT_CLAUDE_MODEL,
  codex_cli: null
}

const EMPTY_MODEL_OPTIONS: Record<AgentCliBackendId, AgentBackendModelList | null> = {
  claude_cli: null,
  codex_cli: null
}

const MODEL_LABEL_FALLBACKS: Record<AgentCliBackendId, Record<string, string>> = {
  claude_cli: {
    sonnet: 'Sonnet',
    haiku: 'Haiku',
    opus: 'Opus'
  },
  codex_cli: {
    'gpt-5.5': 'GPT-5.5',
    'gpt-5.4': 'GPT-5.4',
    'gpt-5.4-mini': 'GPT-5.4 Mini'
  }
}

type ReasoningOption<Value extends string> = {
  value: Value
  labelKey: string
  summaryKey: string
}

const claudeReasoningOptions: Array<ReasoningOption<ClaudeEffort>> = [
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

const codexReasoningOptions: Array<ReasoningOption<CodexReasoningEffort>> = [
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

function isCliProvider(provider: AgentProvider): provider is AgentCliBackendId {
  return provider === 'claude_cli' || provider === 'codex_cli'
}

function dedupeAttachments(attachments: AttachmentInput[]): AttachmentInput[] {
  const seen = new Set<string>()
  return attachments.filter((attachment) => {
    const key = `${attachment.kind}:${attachment.ref_id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function codexModelVersion(modelId: string): number[] | null {
  const match = /^gpt[-_]?(\d+(?:[.-]\d+)*)(?:-.+)?$/i.exec(modelId)
  if (!match) return null
  return match[1].split(/[.-]/).map((segment) => Number(segment))
}

function compareCodexModels(left: string, right: string): number {
  const leftVersion = codexModelVersion(left)
  const rightVersion = codexModelVersion(right)
  if (!leftVersion && !rightVersion) return 0
  if (leftVersion && !rightVersion) return 1
  if (!leftVersion && rightVersion) return -1

  const maxLength = Math.max(leftVersion!.length, rightVersion!.length)
  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftVersion![index] ?? 0
    const rightPart = rightVersion![index] ?? 0
    if (leftPart !== rightPart) return leftPart - rightPart
  }
  return 0
}

function latestCodexModel(modelIds: string[]): string | null {
  return modelIds.reduce<string | null>((latest, modelId) => {
    if (!latest) return modelId
    return compareCodexModels(modelId, latest) > 0 ? modelId : latest
  }, null)
}

function defaultModelForProvider(
  provider: AgentCliBackendId,
  modelOptions: AgentBackendModelList | null
): string | null {
  if (provider === 'claude_cli') return DEFAULT_CLAUDE_MODEL
  const codexModelIds =
    modelOptions?.models.length === 0 || !modelOptions
      ? Object.keys(MODEL_LABEL_FALLBACKS.codex_cli)
      : modelOptions.models.map((model) => model.id)
  return latestCodexModel(codexModelIds)
}

export function Composer({ conversationId, sourceWindowId }: ComposerProps): React.JSX.Element {
  const { t } = useT('common')
  const agent = useAgentOptional()
  const activeTab = useActiveTab()
  const customModelInputId = useId()
  const promptEditorRef = useRef<AgentPromptEditorHandle>(null)
  const [promptValue, setPromptValue] = useState<AgentPromptValue>({
    text: '',
    attachments: []
  })
  const [currentNoteAttachment, setCurrentNoteAttachment] = useState<AttachmentInput | null>(null)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerItems, setPickerItems] = useState<MentionAttachment[]>([])
  const [selectedPickerIndex, setSelectedPickerIndex] = useState(-1)
  const [submitting, setSubmitting] = useState(false)
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider>('claude_cli')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [selectedModels, setSelectedModels] =
    useState<Record<AgentCliBackendId, string | null>>(DEFAULT_SELECTED_MODELS)
  const [modelOptions, setModelOptions] =
    useState<Record<AgentCliBackendId, AgentBackendModelList | null>>(EMPTY_MODEL_OPTIONS)
  const [customModelDraft, setCustomModelDraft] = useState('')
  const [claudeReasoning, setClaudeReasoning] = useState<ClaudeEffort>(DEFAULT_CLAUDE_EFFORT)
  const [codexReasoning, setCodexReasoning] =
    useState<CodexReasoningEffort>(DEFAULT_CODEX_REASONING)

  useEffect(() => {
    if (activeTab?.type !== 'note' || !activeTab.entityId) return
    const label = activeTab.title || t('agentChat.composer.currentNote')
    setCurrentNoteAttachment({
      kind: 'current_note',
      ref_id: '__current__',
      label
    })
  }, [activeTab?.entityId, activeTab?.title, activeTab?.type, t])

  useEffect(() => {
    const activeConversation = conversationId ? agent?.state.conversations[conversationId] : null
    if (activeConversation) {
      setSelectedProvider(activeConversation.backend)
      if (isCliProvider(activeConversation.backend)) {
        setSelectedModels((current) => ({
          ...current,
          [activeConversation.backend]: activeConversation.backendModel
        }))
      }
    }
  }, [agent?.state.conversations, conversationId])

  useEffect(() => {
    const focusTimer = window.setTimeout(() => {
      promptEditorRef.current?.focus()
    }, 0)

    return () => window.clearTimeout(focusTimer)
  }, [conversationId])

  const selectedModelOptions = isCliProvider(selectedProvider)
    ? modelOptions[selectedProvider]
    : null

  const claudeProviderLabel = t('agentChat.composer.providers.claude')
  const codexProviderLabel = t('agentChat.composer.providers.codex')
  const localProviderLabel = t('agentChat.composer.providers.local')
  const backendStatuses = agent?.state.backendStatuses
  const claudeDisabled = backendStatuses?.claude_cli.available === false
  const codexDisabled = backendStatuses?.codex_cli.available === false
  const turnInFlight = conversationId ? agent?.state.inFlight?.[conversationId] === true : false
  const busy = turnInFlight || submitting
  const providerReady =
    selectedProvider === 'local_openai_compatible' ||
    backendStatuses?.[selectedProvider]?.available !== false
  const canSend =
    Boolean(agent) &&
    Boolean(sourceWindowId) &&
    promptValue.text.trim().length > 0 &&
    !busy &&
    providerReady
  const pickerQuery = pickerOpen ? (mentionQuery ?? '') : ''
  const providerLabelById: Record<AgentProvider, string> = {
    claude_cli: claudeProviderLabel,
    codex_cli: codexProviderLabel,
    local_openai_compatible: localProviderLabel
  }
  const selectedProviderLabel = providerLabelById[selectedProvider]
  const selectedBackendModel = isCliProvider(selectedProvider)
    ? (selectedModels[selectedProvider] ??
      defaultModelForProvider(selectedProvider, selectedModelOptions))
    : null
  const selectedModelLabel = selectedBackendModel
    ? (selectedModelOptions?.models.find((model) => model.id === selectedBackendModel)?.label ??
      MODEL_LABEL_FALLBACKS[selectedProvider as AgentCliBackendId][selectedBackendModel] ??
      selectedBackendModel)
    : t('agentChat.composer.models.default')
  const SelectedProviderIcon =
    selectedProvider === 'local_openai_compatible'
      ? Computer
      : selectedProvider === 'codex_cli'
        ? ChatGpt
        : Claude
  const selectedClaudeReasoning =
    claudeReasoningOptions.find((option) => option.value === claudeReasoning) ??
    claudeReasoningOptions[3]
  const selectedCodexReasoning =
    codexReasoningOptions.find((option) => option.value === codexReasoning) ??
    codexReasoningOptions[1]
  const selectedReasoning =
    selectedProvider === 'codex_cli' ? selectedCodexReasoning : selectedClaudeReasoning
  const selectedReasoningOptions =
    selectedProvider === 'codex_cli' ? codexReasoningOptions : claudeReasoningOptions
  const selectedReasoningValue = selectedProvider === 'codex_cli' ? codexReasoning : claudeReasoning
  const settingsSummary = t('agentChat.composer.settingsSummary', {
    reasoning: t(selectedReasoning.summaryKey)
  })
  const backendOptions = (): AgentBackendOptions => {
    if (selectedProvider === 'local_openai_compatible') {
      return { backend: 'local_openai_compatible', toolsEnabled: true }
    }
    if (selectedProvider === 'codex_cli') {
      return {
        backend: 'codex_cli',
        reasoningEffort: codexReasoning,
        ...(selectedBackendModel ? { model: selectedBackendModel } : {})
      }
    }
    return {
      backend: 'claude_cli',
      claudeEffort: claudeReasoning,
      ...(selectedBackendModel ? { model: selectedBackendModel } : {})
    }
  }
  const selectModel = (model: string | null): void => {
    if (!isCliProvider(selectedProvider)) return
    setSelectedModels((current) => ({ ...current, [selectedProvider]: model }))
  }
  const applyCustomModel = (): void => {
    const model = customModelDraft.trim()
    if (!model) return
    selectModel(model)
    setCustomModelDraft('')
    setModelMenuOpen(false)
  }
  const selectReasoning = (value: ClaudeEffort | CodexReasoningEffort): void => {
    if (selectedProvider === 'codex_cli') {
      setCodexReasoning(value as CodexReasoningEffort)
      return
    }
    setClaudeReasoning(value)
  }
  const loadModelOptions = async (provider: AgentCliBackendId): Promise<void> => {
    if (modelOptions[provider]) return
    try {
      const result = await window.api.agent.listBackendModels({ backend: provider })
      setModelOptions((current) => ({ ...current, [provider]: result }))
    } catch {
      setModelOptions((current) => ({
        ...current,
        [provider]: {
          backend: provider,
          supportsCustomModel: true,
          models: []
        }
      }))
    }
  }
  const handleModelMenuOpenChange = (open: boolean): void => {
    setModelMenuOpen(open)
    if (open && isCliProvider(selectedProvider)) {
      void loadModelOptions(selectedProvider)
    }
  }
  const selectProvider = (provider: AgentProvider): void => {
    setSelectedProvider(provider)
    if (isCliProvider(provider)) {
      void loadModelOptions(provider)
    }
  }
  const closePicker = useCallback(() => {
    setMentionQuery(null)
    setPickerOpen(false)
    setPickerItems([])
    setSelectedPickerIndex(-1)
  }, [])
  const pickMention = useCallback((attachment: MentionAttachment): void => {
    promptEditorRef.current?.insertMention(attachment)
    setMentionQuery(null)
    setPickerOpen(false)
    setPickerItems([])
    setSelectedPickerIndex(-1)
  }, [])
  const handleMentionKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (!pickerOpen) return false

      if (event.key === 'ArrowDown' && pickerItems.length > 0) {
        event.preventDefault()
        setSelectedPickerIndex((current) => (current < 0 ? 0 : (current + 1) % pickerItems.length))
        return true
      }

      if (event.key === 'ArrowUp' && pickerItems.length > 0) {
        event.preventDefault()
        setSelectedPickerIndex((current) =>
          current < 0
            ? pickerItems.length - 1
            : (current - 1 + pickerItems.length) % pickerItems.length
        )
        return true
      }

      if (event.key === 'Enter' && !event.shiftKey && pickerItems.length > 0) {
        event.preventDefault()
        const index = selectedPickerIndex >= 0 ? selectedPickerIndex : 0
        const attachment = pickerItems[index]
        if (attachment) {
          pickMention(attachment)
          return true
        }
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        closePicker()
        return true
      }

      return false
    },
    [closePicker, pickMention, pickerItems, pickerOpen, selectedPickerIndex]
  )

  async function submit(): Promise<void> {
    const editorValue = promptEditorRef.current?.getValue() ?? promptValue
    const currentText = editorValue.text.trimEnd()
    if (!agent || !sourceWindowId || !currentText.trim() || busy) return
    const currentAttachments = dedupeAttachments([
      ...editorValue.attachments,
      ...(currentNoteAttachment ? [currentNoteAttachment] : [])
    ])
    setSubmitting(true)
    try {
      const targetConversationId =
        conversationId ??
        (
          await agent.createConversation({
            backend: selectedProvider as AgentBackendId,
            ...(selectedBackendModel ? { backendModel: selectedBackendModel } : {})
          })
        ).id
      await agent.sendTurn({
        conversationId: targetConversationId,
        sourceWindowId,
        text: currentText,
        backendOptions: backendOptions(),
        attachments: currentAttachments
      })
      promptEditorRef.current?.clear()
      setPromptValue({ text: '', attachments: [] })
      closePicker()
    } catch {
      // Agent context owns the user-facing error; leave the draft text in place.
    } finally {
      setSubmitting(false)
    }
  }

  function cancelTurn(): void {
    if (!agent || !conversationId || !turnInFlight) return

    void agent.cancelTurn(conversationId)
  }

  return (
    <div className="relative p-2">
      {pickerOpen && (
        <RefPicker
          query={pickerQuery}
          selectedIndex={selectedPickerIndex}
          onItemsChange={setPickerItems}
          onPick={pickMention}
          onSelectedIndexChange={setSelectedPickerIndex}
          onClose={closePicker}
        />
      )}
      <div className="flex min-h-[120px] cursor-text flex-col rounded-2xl border border-border bg-card shadow-lg">
        <div
          className="relative max-h-[258px] flex-1 overflow-y-auto"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            if (
              event.target instanceof HTMLElement &&
              event.target.closest('[contenteditable="true"]')
            ) {
              return
            }
            event.preventDefault()
            promptEditorRef.current?.focus()
          }}
        >
          <AgentPromptEditor
            ref={promptEditorRef}
            disabled={busy || !agent}
            placeholder={t('agentChat.composer.placeholder')}
            onEscape={closePicker}
            onMentionKeyDown={handleMentionKeyDown}
            onMentionQueryChange={(query) => {
              setMentionQuery(query)
              setPickerOpen(query !== null)
              if (query === null) {
                setPickerItems([])
                setSelectedPickerIndex(-1)
              }
            }}
            onSubmit={() => void submit()}
            onValueChange={setPromptValue}
          />
        </div>
        <div className="flex min-h-[40px] items-center gap-2 p-2 pb-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('agentChat.composer.providerLabel', {
                  provider: selectedProviderLabel
                })}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-transparent px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
              >
                <SelectedProviderIcon className="size-4" aria-hidden="true" />
                <span>{selectedProviderLabel}</span>
                <ChevronDown className="size-3" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-36 border-0">
              <DropdownMenuItem
                disabled={claudeDisabled}
                onSelect={() => selectProvider('claude_cli')}
                className="text-xs hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <Claude className="size-4 text-muted-foreground" aria-hidden="true" />
                <span>{claudeProviderLabel}</span>
                {selectedProvider === 'claude_cli' && (
                  <Check className="ms-auto size-3 text-muted-foreground" aria-hidden="true" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={codexDisabled}
                onSelect={() => selectProvider('codex_cli')}
                className="text-xs hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <ChatGpt className="size-4 text-muted-foreground" aria-hidden="true" />
                <span>{codexProviderLabel}</span>
                {selectedProvider === 'codex_cli' && (
                  <Check className="ms-auto size-3 text-muted-foreground" aria-hidden="true" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => selectProvider('local_openai_compatible')}
                className="text-xs hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <Computer className="size-4 text-muted-foreground" aria-hidden="true" />
                <span>{localProviderLabel}</span>
                {selectedProvider === 'local_openai_compatible' && (
                  <Check className="ms-auto size-3 text-muted-foreground" aria-hidden="true" />
                )}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {isCliProvider(selectedProvider) && (
            <DropdownMenu open={modelMenuOpen} onOpenChange={handleModelMenuOpenChange}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t('agentChat.composer.modelLabel', {
                    model: selectedModelLabel
                  })}
                  className="inline-flex h-8 max-w-28 items-center gap-1 rounded-full bg-muted px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <span className="truncate">{selectedModelLabel}</span>
                  <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-52 border-border/60 p-1.5">
                {(selectedModelOptions?.models ?? []).map((model) => (
                  <DropdownMenuItem
                    key={model.id}
                    onSelect={() => selectModel(model.id)}
                    className="text-xs focus:bg-transparent focus:text-foreground"
                  >
                    <span>{model.label}</span>
                    {selectedBackendModel === model.id && (
                      <Check className="ms-auto size-3 text-muted-foreground" aria-hidden="true" />
                    )}
                  </DropdownMenuItem>
                ))}
                <div
                  className="mt-1 border-t border-border/60 pt-1"
                  onKeyDown={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <label htmlFor={customModelInputId} className="sr-only">
                    {t('agentChat.composer.customModelLabel')}
                  </label>
                  <Input
                    id={customModelInputId}
                    value={customModelDraft}
                    onChange={(event) => setCustomModelDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        applyCustomModel()
                      }
                    }}
                    placeholder={t('agentChat.composer.customModelPlaceholder')}
                    className="h-8 text-xs"
                  />
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {isCliProvider(selectedProvider) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t('agentChat.composer.settingsLabel', {
                    settings: settingsSummary
                  })}
                  className="inline-flex h-8 min-w-0 items-center gap-1 rounded-full bg-muted px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <span className="truncate">{settingsSummary}</span>
                  <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-44 border-border/60 p-1.5">
                <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                  {t('agentChat.composer.settings.reasoning')}
                </DropdownMenuLabel>
                {selectedReasoningOptions.map((option) => (
                  <DropdownMenuCheckboxItem
                    key={option.value}
                    checked={selectedReasoningValue === option.value}
                    onCheckedChange={() => selectReasoning(option.value)}
                    className="text-xs"
                  >
                    {t(option.labelKey)}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <div className="ms-auto flex items-center gap-3">
            {turnInFlight ? (
              <Button
                type="button"
                aria-label={t('agentChat.stop')}
                disabled={!agent}
                onClick={cancelTurn}
                className="size-8 rounded-full p-0"
              >
                <Square className="size-3.5" aria-hidden="true" />
              </Button>
            ) : (
              <Button
                type="button"
                aria-label={t('agentChat.composer.send')}
                disabled={!canSend}
                onPointerDown={(event) => {
                  event.preventDefault()
                  void submit()
                }}
                onClick={() => void submit()}
                className="size-8 rounded-full bg-primary p-0 disabled:cursor-not-allowed"
              >
                <Send className="size-3.5 text-primary-foreground" aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

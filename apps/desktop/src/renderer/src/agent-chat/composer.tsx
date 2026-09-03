import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  AgentAccessMode,
  AgentBackendModelList,
  AgentCliBackendId,
  AgentBackendOptions,
  AgentLocalProviderSettings,
  AttachmentInput,
  CodexReasoningEffort,
  ClaudeEffort
} from '@memry/contracts/ipc-agent'
import { DEFAULT_CLAUDE_EFFORT } from '@memry/contracts/ipc-agent'
import { useT } from '@memry/i18n/renderer'

import { Button } from '@/components/ui/button'
import { useActiveTab } from '@/contexts/tabs'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { ArrowUp, AtSign, Square } from '@/lib/icons'
import { ConnectedToolsTray } from './connected-tools-tray'
import {
  ComposerSettingsMenu,
  claudeReasoningOptions,
  codexReasoningOptions
} from './composer-settings-menu'
import { VoiceDictationButton } from './voice-dictation-button'
import {
  AgentPromptEditor,
  type AgentPromptEditorHandle,
  type AgentPromptValue
} from './agent-prompt-editor'
import { useAgentOptional } from './agent-context'
import type { MentionAttachment } from './mention-icons'
import { RefPicker } from './ref-picker'
import {
  type AgentProvider,
  persistAgentModelPreference,
  readAgentModelPreference
} from './agent-model-preference'

interface ComposerProps {
  conversationId: string | null
  sourceWindowId: string | null
}

const DEFAULT_CLAUDE_MODEL = 'opus'
const DEFAULT_CODEX_REASONING: CodexReasoningEffort = 'medium'
const DEFAULT_ACCESS_MODE: AgentAccessMode = 'vault_only'

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
  const { open: openSettings } = useSettingsModal()
  const promptEditorRef = useRef<AgentPromptEditorHandle>(null)
  const composerBoxRef = useRef<HTMLDivElement>(null)
  const [promptValue, setPromptValue] = useState<AgentPromptValue>({
    text: '',
    attachments: [],
    formatRanges: []
  })
  const [currentNoteAttachment, setCurrentNoteAttachment] = useState<AttachmentInput | null>(null)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerItems, setPickerItems] = useState<MentionAttachment[]>([])
  const [selectedPickerIndex, setSelectedPickerIndex] = useState(-1)
  const [submitting, setSubmitting] = useState(false)
  const [storedPreference] = useState(readAgentModelPreference)
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider>(
    storedPreference?.provider ?? 'claude_cli'
  )
  const [accessMode, setAccessMode] = useState<AgentAccessMode>(DEFAULT_ACCESS_MODE)
  const [webSearchEnabled, setWebSearchEnabled] = useState(false)
  const [includeCurrentNote, setIncludeCurrentNote] = useState(true)
  const [dictationBusy, setDictationBusy] = useState(false)
  const [selectedModels, setSelectedModels] = useState<Record<AgentCliBackendId, string | null>>({
    ...DEFAULT_SELECTED_MODELS,
    ...storedPreference?.models
  })
  const [localModel, setLocalModel] = useState<string | null>(storedPreference?.localModel ?? null)
  const [modelOptions, setModelOptions] =
    useState<Record<AgentCliBackendId, AgentBackendModelList | null>>(EMPTY_MODEL_OPTIONS)
  const [localSettings, setLocalSettings] = useState<AgentLocalProviderSettings | null>(null)
  const [localModels, setLocalModels] = useState<string[] | null>(null)
  const [claudeReasoning, setClaudeReasoning] = useState<ClaudeEffort>(
    storedPreference?.efforts?.claude_cli ?? DEFAULT_CLAUDE_EFFORT
  )
  const [codexReasoning, setCodexReasoning] = useState<CodexReasoningEffort>(
    storedPreference?.efforts?.codex_cli ?? DEFAULT_CODEX_REASONING
  )

  useEffect(() => {
    let cancelled = false
    void window.api.agent
      .getPreferences()
      .then((preferences) => {
        if (cancelled) return
        setAccessMode(preferences.accessMode)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (activeTab?.type !== 'note' || !activeTab.entityId) return
    const label = activeTab.title || t('agentChat.composer.currentNote')
    setCurrentNoteAttachment({
      kind: 'current_note',
      ref_id: '__current__',
      label
    })
  }, [activeTab?.entityId, activeTab?.title, activeTab?.type, t])

  const conversations = agent?.state.conversations
  const activeConversation = conversationId ? conversations?.[conversationId] : null
  const [syncedConversation, setSyncedConversation] = useState<{
    conversations: typeof conversations
    conversationId: typeof conversationId
  } | null>(null)
  if (
    syncedConversation?.conversations !== conversations ||
    syncedConversation?.conversationId !== conversationId
  ) {
    setSyncedConversation({ conversations, conversationId })
    if (activeConversation) {
      setSelectedProvider(activeConversation.backend)
      if (isCliProvider(activeConversation.backend)) {
        setSelectedModels((current) => ({
          ...current,
          [activeConversation.backend]: activeConversation.backendModel
        }))
      } else if (activeConversation.backendModel) {
        setLocalModel(activeConversation.backendModel)
      }
    }
  }

  useEffect(() => {
    const focusTimer = window.setTimeout(() => {
      promptEditorRef.current?.focus()
    }, 0)

    return () => window.clearTimeout(focusTimer)
  }, [conversationId])

  const selectedModelOptions = isCliProvider(selectedProvider)
    ? modelOptions[selectedProvider]
    : null

  const backendStatuses = agent?.state.backendStatuses
  const claudeAvailable = backendStatuses?.claude_cli.available !== false
  const codexAvailable = backendStatuses?.codex_cli.available !== false
  const agentRuntimeUnavailable =
    backendStatuses?.claude_cli.reason === 'agent_unavailable' ||
    backendStatuses?.codex_cli.reason === 'agent_unavailable'
  const turnInFlight = conversationId ? agent?.state.inFlight?.[conversationId] === true : false
  const busy = turnInFlight || submitting
  const providerReady =
    selectedProvider === 'local_openai_compatible' ||
    backendStatuses?.[selectedProvider]?.available !== false
  const hasText = promptValue.text.trim().length > 0
  const canSend = Boolean(agent) && Boolean(sourceWindowId) && hasText && !busy && providerReady
  const pickerQuery = pickerOpen ? (mentionQuery ?? '') : ''
  const localProviderLabel = t('agentChat.composer.providers.local')
  const selectedBackendModel = isCliProvider(selectedProvider)
    ? (selectedModels[selectedProvider] ??
      defaultModelForProvider(selectedProvider, selectedModelOptions))
    : null
  const cliModelLabel = (backend: AgentCliBackendId, modelId: string): string =>
    modelOptions[backend]?.models.find((model) => model.id === modelId)?.label ??
    MODEL_LABEL_FALLBACKS[backend][modelId] ??
    modelId
  const effectiveLocalModel =
    localModel ?? (localSettings?.model.trim() ? localSettings.model : null)
  const localConfigured =
    localSettings !== null &&
    (localSettings.model.trim().length > 0 || (localModels?.length ?? 0) > 0)
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
  const effortSummary = t(selectedReasoning.summaryKey)
  const currentModelValueLabel = isCliProvider(selectedProvider)
    ? selectedBackendModel
      ? cliModelLabel(selectedProvider, selectedBackendModel)
      : t('agentChat.composer.models.default')
    : (effectiveLocalModel ?? localProviderLabel)
  const summaryLabel = !providerReady
    ? t('agentChat.composer.chooseModel')
    : isCliProvider(selectedProvider)
      ? `${currentModelValueLabel} · ${effortSummary}`
      : currentModelValueLabel
  const modelSettingsAriaLabel = t('agentChat.composer.modelSettingsLabel', {
    model: currentModelValueLabel,
    settings: isCliProvider(selectedProvider) ? effortSummary : localProviderLabel
  })
  const backendOptions = (): AgentBackendOptions => {
    if (selectedProvider === 'local_openai_compatible') {
      return {
        backend: 'local_openai_compatible',
        toolsEnabled: true,
        ...(effectiveLocalModel ? { model: effectiveLocalModel } : {})
      }
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
  const turnPermissions = () =>
    accessMode !== DEFAULT_ACCESS_MODE || webSearchEnabled
      ? { accessMode, webSearchEnabled }
      : undefined
  const persistPreference = (overrides: {
    provider?: AgentProvider
    models?: Record<AgentCliBackendId, string | null>
    claudeEffort?: ClaudeEffort
    codexEffort?: CodexReasoningEffort
    localModel?: string | null
  }): void => {
    persistAgentModelPreference({
      provider: overrides.provider ?? selectedProvider,
      models: overrides.models ?? selectedModels,
      efforts: {
        claude_cli: overrides.claudeEffort ?? claudeReasoning,
        codex_cli: overrides.codexEffort ?? codexReasoning
      },
      localModel: overrides.localModel !== undefined ? overrides.localModel : localModel
    })
  }
  const selectCliModel = (backend: AgentCliBackendId, model: string): void => {
    const nextModels = { ...selectedModels, [backend]: model }
    setSelectedProvider(backend)
    setSelectedModels(nextModels)
    persistPreference({ provider: backend, models: nextModels })
  }
  const selectLocalModel = (model: string): void => {
    setSelectedProvider('local_openai_compatible')
    setLocalModel(model)
    persistPreference({ provider: 'local_openai_compatible', localModel: model })
  }
  const selectReasoning = (value: ClaudeEffort | CodexReasoningEffort): void => {
    if (selectedProvider === 'codex_cli') {
      setCodexReasoning(value as CodexReasoningEffort)
      persistPreference({ codexEffort: value as CodexReasoningEffort })
      return
    }
    setClaudeReasoning(value)
    persistPreference({ claudeEffort: value })
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
  const loadLocalProviderData = async (): Promise<void> => {
    if (localSettings !== null && localModels !== null) return
    try {
      const settings = await window.api.agent.getLocalProviderSettings()
      setLocalSettings(settings)
    } catch {
      setLocalSettings(null)
    }
    try {
      const list = await window.api.agent.listLocalModels()
      setLocalModels(list.models)
    } catch {
      setLocalModels([])
    }
  }
  const handleSettingsMenuOpenChange = (open: boolean): void => {
    if (!open) return
    if (claudeAvailable) void loadModelOptions('claude_cli')
    if (codexAvailable) void loadModelOptions('codex_cli')
    void loadLocalProviderData()
  }
  const insertTranscript = useCallback((text: string): void => {
    const editor = promptEditorRef.current
    if (!editor) return

    const existing = editor.getValue().text
    const needsSpace = existing.length > 0 && !/\s$/.test(existing)
    editor.insertText(needsSpace ? ` ${text}` : text)
    editor.focus()
  }, [])
  const triggerMention = useCallback((): void => {
    promptEditorRef.current?.focus()
    promptEditorRef.current?.insertMentionTrigger()
  }, [])
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
      ...(includeCurrentNote && currentNoteAttachment ? [currentNoteAttachment] : [])
    ])
    setSubmitting(true)
    try {
      const selectedTurnModel = isCliProvider(selectedProvider)
        ? selectedBackendModel
        : effectiveLocalModel
      const targetConversationId =
        conversationId ??
        (
          await agent.createConversation({
            backend: selectedProvider,
            ...(selectedTurnModel ? { backendModel: selectedTurnModel } : {})
          })
        ).id
      await agent.sendTurn({
        conversationId: targetConversationId,
        sourceWindowId,
        text: currentText,
        backendOptions: backendOptions(),
        permissions: turnPermissions(),
        attachments: currentAttachments
      })
      promptEditorRef.current?.clear()
      setPromptValue({ text: '', attachments: [], formatRanges: [] })
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

  const claudeCatalog = modelOptions.claude_cli?.models.length
    ? modelOptions.claude_cli.models
    : Object.entries(MODEL_LABEL_FALLBACKS.claude_cli).map(([id, label]) => ({ id, label }))
  const codexCatalog = modelOptions.codex_cli?.models.length
    ? modelOptions.codex_cli.models
    : Object.entries(MODEL_LABEL_FALLBACKS.codex_cli).map(([id, label]) => ({ id, label }))
  const localModelIds = (() => {
    const ids = [...(localModels ?? [])]
    const configuredModel = localSettings?.model.trim()
    if (configuredModel && !ids.includes(configuredModel)) ids.unshift(configuredModel)
    return ids
  })()

  return (
    <div className="relative p-2">
      {pickerOpen && (
        <RefPicker
          query={pickerQuery}
          selectedIndex={selectedPickerIndex}
          anchorRef={composerBoxRef}
          onItemsChange={setPickerItems}
          onPick={pickMention}
          onSelectedIndexChange={setSelectedPickerIndex}
          onClose={closePicker}
        />
      )}
      <div className="relative flex flex-col">
        <ConnectedToolsTray />
        <div
          ref={composerBoxRef}
          className="relative flex min-h-[102px] cursor-text flex-col justify-between gap-4 rounded-2xl border border-border bg-card px-2.5 pb-2.5 pt-3"
        >
          <div
            className="relative max-h-[180px] flex-1 overflow-y-auto"
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
              editorClassName="!min-h-9 max-h-[180px] p-1 text-[13px] leading-[18px] [&_.is-editor-empty:first-child::before]:text-[13px]"
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
          <div className="flex w-full items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <ComposerSettingsMenu
                ariaLabel={modelSettingsAriaLabel}
                summaryLabel={summaryLabel}
                providerReady={providerReady}
                webSearchEnabled={webSearchEnabled}
                includeCurrentNote={includeCurrentNote}
                accessMode={accessMode}
                selectedProvider={selectedProvider}
                selectedBackendModel={selectedBackendModel}
                effectiveLocalModel={effectiveLocalModel}
                showEffort={isCliProvider(selectedProvider)}
                effortSummary={effortSummary}
                reasoningOptions={selectedReasoningOptions}
                selectedReasoningValue={selectedReasoningValue}
                currentModelValueLabel={currentModelValueLabel}
                claudeAvailable={claudeAvailable}
                codexAvailable={codexAvailable}
                agentRuntimeUnavailable={agentRuntimeUnavailable}
                claudeCatalog={claudeCatalog}
                codexCatalog={codexCatalog}
                localSettingsLoaded={localSettings !== null}
                localConfigured={localConfigured}
                localModelIds={localModelIds}
                onOpenChange={handleSettingsMenuOpenChange}
                onToggleWebSearch={() => setWebSearchEnabled((value) => !value)}
                onToggleIncludeCurrentNote={() => setIncludeCurrentNote((value) => !value)}
                onSelectAccessMode={setAccessMode}
                onSelectReasoning={selectReasoning}
                onSelectCliModel={selectCliModel}
                onSelectLocalModel={selectLocalModel}
                onOpenProviderSettings={() => openSettings('agent-providers')}
              />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                aria-label={t('agentChat.composer.mentionContext')}
                disabled={busy || !agent}
                onClick={triggerMention}
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                <AtSign className="size-3.5" aria-hidden="true" />
              </button>
              {turnInFlight ? (
                <Button
                  type="button"
                  aria-label={t('agentChat.stop')}
                  disabled={!agent}
                  onClick={cancelTurn}
                  className="size-7 rounded-md bg-tint p-0 text-tint-foreground hover:bg-tint-hover"
                >
                  <Square className="size-3" aria-hidden="true" />
                </Button>
              ) : hasText && !dictationBusy ? (
                <Button
                  type="button"
                  aria-label={t('agentChat.composer.send')}
                  disabled={!canSend}
                  onPointerDown={(event) => {
                    event.preventDefault()
                    void submit()
                  }}
                  onClick={() => void submit()}
                  className="size-7 rounded-md bg-tint p-0 text-tint-foreground hover:bg-tint-hover disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
                >
                  <ArrowUp className="size-3.5" aria-hidden="true" />
                </Button>
              ) : (
                <VoiceDictationButton
                  disabled={busy || !agent}
                  onTranscript={insertTranscript}
                  onBusyChange={setDictationBusy}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

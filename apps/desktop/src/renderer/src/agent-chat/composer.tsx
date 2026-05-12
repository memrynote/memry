import { useEffect, useRef, useState } from 'react'

import type { AgentBackendId, AttachmentInput, ClaudeEffort } from '@memry/contracts/ipc-agent'
import { DEFAULT_AGENT_BACKEND, DEFAULT_CLAUDE_EFFORT } from '@memry/contracts/ipc-agent'
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
import { Textarea } from '@/components/ui/textarea'
import { useActiveTab } from '@/contexts/tabs'
import { ChatGpt, Check, ChevronDown, Claude, Computer, Send, Square, X } from '@/lib/icons'
import { useAgentOptional } from './agent-context'
import { RefPicker } from './ref-picker'

interface ComposerProps {
  conversationId: string | null
  sourceWindowId: string | null
}

type AgentProvider = AgentBackendId | 'local'
interface SelectedProviderState {
  conversationId: string | null
  provider: AgentProvider
}

const claudeReasoningOptions: Array<{
  value: ClaudeEffort
  labelKey: string
  summaryKey: string
}> = [
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

function getRefQuery(text: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text)
  return match?.[1] ?? null
}

function resizePromptTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto'
  textarea.style.height = `${textarea.scrollHeight}px`
}

export function Composer({ conversationId, sourceWindowId }: ComposerProps): React.JSX.Element {
  const { t } = useT('common')
  const agent = useAgentOptional()
  const activeTab = useActiveTab()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<AttachmentInput[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [selectedProviderState, setSelectedProviderState] = useState<SelectedProviderState>({
    conversationId: null,
    provider: DEFAULT_AGENT_BACKEND
  })
  const [claudeReasoning, setClaudeReasoning] = useState<ClaudeEffort>(DEFAULT_CLAUDE_EFFORT)
  const activeConversation =
    agent && conversationId ? agent.state.conversations[conversationId] : null

  useEffect(() => {
    if (activeTab?.type !== 'note' || !activeTab.entityId) return
    setAttachments((current) => {
      const label = activeTab.title || t('agentChat.composer.currentNote')
      const currentNote = current.find((attachment) => attachment.kind === 'current_note')
      if (currentNote) {
        if (currentNote.label === label) return current
        return current.map((attachment) =>
          attachment.kind === 'current_note' ? { ...attachment, label } : attachment
        )
      }
      return [
        ...current,
        {
          kind: 'current_note',
          ref_id: '__current__',
          label
        }
      ]
    })
  }, [activeTab?.entityId, activeTab?.title, activeTab?.type, t])

  useEffect(() => {
    if (textareaRef.current) resizePromptTextarea(textareaRef.current)
  }, [text])

  const turnInFlight = conversationId ? agent?.state.inFlight?.[conversationId] === true : false
  const busy = turnInFlight || submitting
  const canSend = Boolean(agent) && Boolean(sourceWindowId) && text.trim().length > 0 && !busy
  const pickerQuery = pickerOpen ? (getRefQuery(text) ?? '') : ''
  const claudeProviderLabel = t('agentChat.composer.providers.claude')
  const codexProviderLabel = t('agentChat.composer.providers.codex')
  const localProviderLabel = t('agentChat.composer.providers.local')
  const providerLabelById: Record<AgentProvider, string> = {
    claude_cli: claudeProviderLabel,
    codex_cli: codexProviderLabel,
    local: localProviderLabel
  }
  const selectedProvider =
    selectedProviderState.conversationId === conversationId
      ? selectedProviderState.provider
      : (activeConversation?.backend ?? DEFAULT_AGENT_BACKEND)
  const selectedProviderLabel = providerLabelById[selectedProvider]
  const SelectedProviderIcon =
    selectedProvider === 'codex_cli' ? ChatGpt : selectedProvider === 'local' ? Computer : Claude
  const selectedClaudeReasoning =
    claudeReasoningOptions.find((option) => option.value === claudeReasoning) ??
    claudeReasoningOptions[3]
  const claudeSettingsSummary = t('agentChat.composer.settingsSummary', {
    reasoning: t(selectedClaudeReasoning.summaryKey)
  })

  async function submit(): Promise<void> {
    if (!agent || !sourceWindowId || !text.trim() || busy) return
    const currentText = text
    const currentAttachments = attachments
    const selectedBackend = selectedProvider === 'local' ? DEFAULT_AGENT_BACKEND : selectedProvider
    setSubmitting(true)
    try {
      const targetConversationId =
        conversationId && activeConversation?.backend === selectedBackend
          ? conversationId
          : (await agent.createConversation({ backend: selectedBackend })).id
      await agent.sendTurn({
        conversationId: targetConversationId,
        sourceWindowId,
        text: currentText,
        claudeEffort: claudeReasoning,
        attachments: currentAttachments
      })
      setText('')
      setAttachments((current) =>
        current.filter((attachment) => attachment.kind === 'current_note')
      )
    } catch {
      // Agent context owns the user-facing error; leave the draft text in place.
    } finally {
      setSubmitting(false)
    }
  }

  function selectProvider(provider: AgentProvider): void {
    if (provider === 'local') return
    setSelectedProviderState({ conversationId, provider })
    if (!agent || !conversationId || !activeConversation) return
    if (activeConversation.backend === provider) return

    void agent.createConversation({ backend: provider })
  }

  function cancelTurn(): void {
    if (!agent || !conversationId || !turnInFlight) return

    void agent.cancelTurn(conversationId)
  }

  function removeAttachment(refId: string): void {
    setAttachments((current) => current.filter((attachment) => attachment.ref_id !== refId))
  }

  return (
    <div className="relative p-2">
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {attachments.map((attachment) => (
            <span
              key={`${attachment.kind}-${attachment.ref_id}`}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs text-accent-foreground"
            >
              <span className="truncate">{attachment.label}</span>
              <button
                type="button"
                aria-label={t('agentChat.composer.removeAttachment', { label: attachment.label })}
                onClick={() => removeAttachment(attachment.ref_id)}
                className="rounded-full text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
      {pickerOpen && (
        <RefPicker
          query={pickerQuery}
          onPick={(attachment) => {
            setAttachments((current) => {
              if (
                current.some(
                  (existing) =>
                    existing.kind === attachment.kind && existing.ref_id === attachment.ref_id
                )
              ) {
                return current
              }
              return [...current, attachment]
            })
            setText((current) => current.replace(/@\S*$/, ''))
            setPickerOpen(false)
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      <div className="flex min-h-[120px] cursor-text flex-col rounded-2xl border border-border bg-card shadow-lg">
        <div className="relative max-h-[258px] flex-1 overflow-y-auto">
          <Textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => {
              const nextText = event.target.value
              setText(nextText)
              setPickerOpen(getRefQuery(nextText) !== null)
            }}
            onInput={(event) => resizePromptTextarea(event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submit()
              }
              if (event.key === 'Escape') setPickerOpen(false)
            }}
            rows={1}
            disabled={busy || !agent}
            placeholder={t('agentChat.composer.placeholder')}
            className="!min-h-[48.4px] min-h-[48.4px] resize-none whitespace-pre-wrap break-words border-0 bg-transparent p-3 text-[16px] text-foreground shadow-none outline-none transition-[padding] duration-200 ease-in-out focus-visible:ring-0 focus-visible:ring-offset-0"
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
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-transparent px-1.5 text-xs text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <SelectedProviderIcon className="size-4" aria-hidden="true" />
                <span>{selectedProviderLabel}</span>
                <ChevronDown className="size-3" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-36 border-0">
              <DropdownMenuItem
                onSelect={() => selectProvider('claude_cli')}
                className="text-xs focus:bg-transparent focus:text-foreground"
              >
                <Claude className="size-4 text-muted-foreground" aria-hidden="true" />
                <span>{claudeProviderLabel}</span>
                {selectedProvider === 'claude_cli' && (
                  <Check className="ms-auto size-3 text-muted-foreground" aria-hidden="true" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => selectProvider('codex_cli')}
                className="text-xs focus:bg-transparent focus:text-foreground"
              >
                <ChatGpt className="size-4 text-muted-foreground" aria-hidden="true" />
                <span>{codexProviderLabel}</span>
                {selectedProvider === 'codex_cli' && (
                  <Check className="ms-auto size-3 text-muted-foreground" aria-hidden="true" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled
                className="text-xs focus:bg-transparent focus:text-foreground"
              >
                <Computer className="size-4 text-muted-foreground" aria-hidden="true" />
                <span>{localProviderLabel}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {selectedProvider === 'claude_cli' && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t('agentChat.composer.settingsLabel', {
                    settings: claudeSettingsSummary
                  })}
                  className="inline-flex h-8 min-w-0 items-center gap-1 rounded-full bg-muted px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <span className="truncate">{claudeSettingsSummary}</span>
                  <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-44 border-border/60 p-1.5">
                <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                  {t('agentChat.composer.settings.reasoning')}
                </DropdownMenuLabel>
                {claudeReasoningOptions.map((option) => (
                  <DropdownMenuCheckboxItem
                    key={option.value}
                    checked={claudeReasoning === option.value}
                    onCheckedChange={() => setClaudeReasoning(option.value)}
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

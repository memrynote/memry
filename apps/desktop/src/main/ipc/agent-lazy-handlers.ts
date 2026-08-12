import { BrowserWindow, ipcMain, type WebContents } from 'electron'

import {
  AgentBackendModelListRequestSchema,
  AgentChannels,
  AgentLocalProviderSettingsUpdateSchema,
  AgentPreferencesUpdateSchema,
  AgentStreamTargetRequestSchema,
  type AgentLocalModelList,
  type AgentLocalProviderProbeResult,
  type AgentLocalProviderSettings,
  type AgentBackendModelList,
  type BackendStatusesResponse,
  type Conversation,
  type Message,
  type PreviewDiffResponse
} from '@memry/contracts/ipc-agent'

import { getAgentPreferences, setAgentPreferences } from '../agent/settings'
import { getDisclosureState, acceptDisclosure } from '../agent/runtime/disclosure-state'
import { setAgentStreamTarget } from '../agent/runtime/event-bus'
import { ensureLazyAgentServicesStarted } from '../agent/lazy-services'
import { createLogger } from '../lib/logger'
import { getMainI18n } from '../lib/main-i18n'

const logger = createLogger('IPC:AgentLazy')

const CLI_MODEL_OPTIONS: Record<'claude_cli' | 'codex_cli', AgentBackendModelList> = {
  claude_cli: {
    backend: 'claude_cli',
    supportsCustomModel: true,
    models: [
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'haiku', label: 'Haiku' },
      { id: 'opus', label: 'Opus' }
    ]
  },
  codex_cli: {
    backend: 'codex_cli',
    supportsCustomModel: true,
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' }
    ]
  }
}

/**
 * Machine-readable marker for "the lazy agent runtime has not finished
 * starting". The renderer's `shouldRetryAgentBootstrap`
 * (agent-chat/agent-context.tsx) matches this raw string to decide whether to
 * retry a bootstrap invoke, so it must never depend on display text.
 *
 * It travels as the thrown Error message because `ipcRenderer.invoke` rejects
 * with `message` only — a `code` property on a typed error class is dropped at
 * the boundary. Being the `errors:` i18n key at the same time means the
 * renderer's `extractErrorMessage` translates it for display, so the user sees
 * a localized sentence while the retry loop matches the stable key.
 *
 * The renderer keeps its own copy of this literal (main and renderer cannot
 * share a module); the two must stay in sync.
 */
export const AGENT_RUNTIME_STARTING_CODE = 'errors:agent.runtimeStarting'

export function registerLazyAgentHandlers(): void {
  unregisterLazyAgentHandlers()

  ipcMain.handle(
    AgentChannels.invoke.LIST_CONVERSATIONS,
    async (_event, _payload: unknown): Promise<Conversation[]> => []
  )
  ipcMain.handle(
    AgentChannels.invoke.CREATE_CONVERSATION,
    async (_event, _payload: unknown): Promise<Conversation> => {
      await ensureLazyAgentServicesStarted()
      throw new Error(AGENT_RUNTIME_STARTING_CODE)
    }
  )
  ipcMain.handle(
    AgentChannels.invoke.LOAD_CONVERSATION,
    async (
      _event,
      _payload: unknown
    ): Promise<{ conversation: Conversation | null; messages: Message[] }> => {
      await ensureLazyAgentServicesStarted()
      throw new Error(AGENT_RUNTIME_STARTING_CODE)
    }
  )
  ipcMain.handle(
    AgentChannels.invoke.SEND_TURN,
    async (
      _event,
      _payload: unknown
    ): Promise<{ ok: boolean; error: string } | { ok: boolean; error?: undefined }> => {
      await ensureLazyAgentServicesStarted()
      // Envelope, not a rejection: the renderer displays `error` verbatim and
      // never matches it, so this side stays pre-translated.
      return { ok: false, error: getMainI18n().t(AGENT_RUNTIME_STARTING_CODE) }
    }
  )
  ipcMain.handle(
    AgentChannels.invoke.CANCEL_TURN,
    async (_event, _payload: unknown): Promise<{ ok: boolean }> => {
      await ensureLazyAgentServicesStarted()
      throw new Error(AGENT_RUNTIME_STARTING_CODE)
    }
  )
  ipcMain.handle(
    AgentChannels.invoke.APPROVE_TOOL,
    async (_event, _payload: unknown): Promise<{ ok: boolean }> => {
      await ensureLazyAgentServicesStarted()
      throw new Error(AGENT_RUNTIME_STARTING_CODE)
    }
  )
  ipcMain.handle(
    AgentChannels.invoke.PREVIEW_DIFF,
    async (_event, _payload: unknown): Promise<PreviewDiffResponse> => {
      await ensureLazyAgentServicesStarted()
      throw new Error(AGENT_RUNTIME_STARTING_CODE)
    }
  )
  ipcMain.handle(
    AgentChannels.invoke.EDIT_TRUST_LIST,
    async (_event, _payload: unknown): Promise<Conversation | null> => {
      await ensureLazyAgentServicesStarted()
      throw new Error(AGENT_RUNTIME_STARTING_CODE)
    }
  )
  ipcMain.handle(
    AgentChannels.invoke.GET_BACKEND_STATUSES,
    async (): Promise<BackendStatusesResponse> => {
      await ensureLazyAgentServicesStarted()
      throw new Error(AGENT_RUNTIME_STARTING_CODE)
    }
  )
  ipcMain.handle(AgentChannels.invoke.LIST_BACKEND_MODELS, async (_event, payload: unknown) => {
    const request = AgentBackendModelListRequestSchema.parse(payload)
    return CLI_MODEL_OPTIONS[request.backend]
  })
  ipcMain.handle(
    AgentChannels.invoke.GET_LOCAL_PROVIDER_SETTINGS,
    async (): Promise<AgentLocalProviderSettings> => {
      const { getLocalProviderSettings } = await import('../agent/backends/local-provider-settings')
      return getLocalProviderSettings()
    }
  )
  ipcMain.handle(AgentChannels.invoke.SET_LOCAL_PROVIDER_SETTINGS, (_event, payload: unknown) => {
    return import('../agent/backends/local-provider-settings').then(
      ({ setLocalProviderSettings }) =>
        setLocalProviderSettings(AgentLocalProviderSettingsUpdateSchema.parse(payload))
    )
  })
  ipcMain.handle(AgentChannels.invoke.GET_PREFERENCES, async () => getAgentPreferences())
  ipcMain.handle(AgentChannels.invoke.SET_PREFERENCES, async (_event, payload: unknown) => {
    return setAgentPreferences(AgentPreferencesUpdateSchema.parse(payload))
  })
  ipcMain.handle(AgentChannels.invoke.LIST_LOCAL_MODELS, async (): Promise<AgentLocalModelList> => {
    await ensureLazyAgentServicesStarted()
    throw new Error(AGENT_RUNTIME_STARTING_CODE)
  })
  ipcMain.handle(
    AgentChannels.invoke.TEST_LOCAL_PROVIDER,
    async (): Promise<AgentLocalProviderProbeResult> => {
      await ensureLazyAgentServicesStarted()
      throw new Error(AGENT_RUNTIME_STARTING_CODE)
    }
  )
  ipcMain.handle(
    AgentChannels.invoke.PROBE_LOCAL_PROVIDER,
    async (): Promise<AgentLocalProviderProbeResult> => {
      await ensureLazyAgentServicesStarted()
      throw new Error(AGENT_RUNTIME_STARTING_CODE)
    }
  )
  ipcMain.handle(AgentChannels.invoke.GET_DISCLOSURE_STATE, () => getDisclosureState())
  ipcMain.handle(AgentChannels.invoke.ACCEPT_DISCLOSURE, () => acceptDisclosure())
  ipcMain.handle(AgentChannels.invoke.GET_WINDOW_ID, (event) => {
    void ensureLazyAgentServicesStarted().catch((error) => {
      logger.warn('Failed to start lazy agent services', error)
    })
    return { windowId: resolveSenderWindowId(event.sender) }
  })
  // Answered before the runtime exists on purpose: a window that mounts Agent
  // Chat during the lazy start would otherwise stay "unknown", which forces the
  // delta fan-out to fall back to every window for the first turn.
  ipcMain.handle(AgentChannels.invoke.SET_STREAM_TARGET, (event, payload: unknown) => {
    const { conversationId } = AgentStreamTargetRequestSchema.parse(payload)
    const windowId = resolveSenderWindowId(event.sender)
    if (windowId !== null) setAgentStreamTarget(Number(windowId), conversationId)
    return { ok: true }
  })
}

export function unregisterLazyAgentHandlers(): void {
  for (const channel of Object.values(AgentChannels.invoke)) {
    ipcMain.removeHandler(channel)
  }
}

function resolveSenderWindowId(sender: WebContents): string | null {
  const direct = BrowserWindow.fromWebContents(sender)
  if (direct) return direct.id.toString()

  const windows = BrowserWindow.getAllWindows()
  const matchingWindow = windows.find((win) => win.webContents.id === sender.id)
  if (matchingWindow) return matchingWindow.id.toString()
  if (windows.length === 1) return windows[0].id.toString()
  return null
}

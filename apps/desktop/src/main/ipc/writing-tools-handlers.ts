import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import type { AIInlineSettings } from '@memry/contracts/ai-inline-channels'
import { WritingToolsChannels } from '@memry/contracts/ipc-channels'
import {
  AddWordToDictionaryInputSchema,
  WritingAssistInputSchema,
  type WritingAssistResponse
} from '@memry/contracts/writing-tools-api'
import type * as WritingAssist from '../ai-inline/writing-assist'
import { claimEditorContextMenu } from '../editor-context-menu'
import { createLogger } from '../lib/logger'
import { getMainI18n } from '../lib/main-i18n'
import { readAIInlineSettings } from './ai-inline-handlers'

const logger = createLogger('IPC:WritingTools')

const PROVIDER_NAMES: Record<AIInlineSettings['provider'], string> = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google'
}

let registered = false
let writingAssistLoad: Promise<typeof WritingAssist> | null = null

// Lazy for the same reason as the inline chat server: `ai` and the provider
// SDKs stay out of the main process until the user actually asks the model.
// See scripts/check-main-startup-set.mjs.
function loadWritingAssist(): Promise<typeof WritingAssist> {
  if (!writingAssistLoad) {
    writingAssistLoad = import('../ai-inline/writing-assist').catch((error: unknown) => {
      writingAssistLoad = null
      throw error
    })
  }
  return writingAssistLoad
}

export function registerWritingToolsHandlers(): void {
  if (registered) return

  // Not wrapped in `withErrorHandler`: its rest-args signature would hide the
  // payload from the generated invoke map. Failures still come back as the
  // same `{ success: false, error }` envelope.
  ipcMain.handle(
    WritingToolsChannels.invoke.GENERATE_ASSIST,
    // oxlint-disable-next-line typescript/consistent-return -- the failure switch covers every classifyWritingAssistFailure result; a default would hide new members from the compiler
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<WritingAssistResponse> => {
      const i18n = getMainI18n()
      const parsed = WritingAssistInputSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('Rejected a writing assist request with an invalid payload')
        return { success: false, error: i18n.t('errors:ai.writingAssistInvalid') }
      }
      const settings = readAIInlineSettings()
      if (!settings.enabled) return { success: false, error: i18n.t('errors:ai.inlineDisabled') }
      const provider = PROVIDER_NAMES[settings.provider]
      if (settings.provider !== 'ollama' && !settings.apiKey) {
        return { success: false, error: i18n.t('errors:ai.apiKeyMissing', { provider }) }
      }
      let writingAssist: typeof WritingAssist | null = null
      try {
        writingAssist = await loadWritingAssist()
        return {
          success: true,
          result: await writingAssist.runWritingAssist(settings, parsed.data)
        }
      } catch (error) {
        logger.warn('Writing assist request failed', { kind: parsed.data.kind, error })
        switch (writingAssist?.classifyWritingAssistFailure(error) ?? 'other') {
          case 'unreachable':
            return {
              success: false,
              error:
                settings.provider === 'ollama'
                  ? i18n.t('errors:ai.ollamaUnreachable')
                  : i18n.t('errors:ai.providerUnreachable', { provider })
            }
          case 'unauthorized':
            return { success: false, error: i18n.t('errors:ai.apiKeyInvalid', { provider }) }
          case 'other':
            return {
              success: false,
              error: error instanceof Error ? error.message : i18n.t('errors:generic.unknown')
            }
        }
      }
    }
  )

  ipcMain.on(WritingToolsChannels.invoke.CLAIM_EDITOR_CONTEXT_MENU, (event) => {
    claimEditorContextMenu(event.sender.id)
    event.returnValue = true
  })

  ipcMain.handle(
    WritingToolsChannels.invoke.ADD_WORD_TO_DICTIONARY,
    (event: IpcMainInvokeEvent, payload: unknown): boolean => {
      const parsed = AddWordToDictionaryInputSchema.safeParse(payload)
      if (!parsed.success) return false
      return event.sender.session.addWordToSpellCheckerDictionary(parsed.data)
    }
  )

  registered = true
}

export function unregisterWritingToolsHandlers(): void {
  if (!registered) return
  ipcMain.removeHandler(WritingToolsChannels.invoke.GENERATE_ASSIST)
  ipcMain.removeAllListeners(WritingToolsChannels.invoke.CLAIM_EDITOR_CONTEXT_MENU)
  ipcMain.removeHandler(WritingToolsChannels.invoke.ADD_WORD_TO_DICTIONARY)
  registered = false
}

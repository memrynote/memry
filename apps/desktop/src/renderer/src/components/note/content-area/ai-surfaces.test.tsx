import { render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const aiMocks = vi.hoisted(() => {
  const AIExtension = Symbol('AIExtension')
  return {
    AIExtension,
    getStreamToolsProvider: vi.fn((options: unknown) => ({ providerOptions: options })),
    getDefaultAIMenuItems: vi.fn((_editor: unknown, status: string) => [
      { key: 'improve_writing', title: `Default improve ${status}` },
      { key: 'default_only', title: `Default only ${status}` }
    ]),
    capturedItems: undefined as
      | undefined
      | ((editor: unknown, status: string) => Array<{ key: string; title: string }>)
  }
})

vi.mock('@blocknote/xl-ai', () => ({
  AIExtension: aiMocks.AIExtension,
  aiDocumentFormats: {
    html: {
      getStreamToolsProvider: aiMocks.getStreamToolsProvider
    }
  },
  AIMenu: ({
    items
  }: {
    items: (editor: unknown, status: string) => Array<{ key: string; title: string }>
  }) => {
    aiMocks.capturedItems = items
    return <div data-testid="ai-menu" />
  },
  getDefaultAIMenuItems: aiMocks.getDefaultAIMenuItems
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn() })
}))

import {
  actionItems,
  continueWriting,
  improveWriting,
  NO_SELECTION_COMMANDS,
  SELECTION_COMMANDS,
  translate
} from './ai-commands'
import { CustomAIMenu } from './ai-menu'

const createEditor = (hasSelection = true) => {
  const invokeAI = vi.fn().mockResolvedValue(undefined)
  return {
    invokeAI,
    editor: {
      getExtension: vi.fn((extension) => (extension === aiMocks.AIExtension ? { invokeAI } : null)),
      getSelection: vi.fn(() => (hasSelection ? { blocks: [] } : undefined))
    }
  }
}

describe('AI editor command surfaces', () => {
  it('creates selection commands with expected metadata and invokes update-only AI by default', async () => {
    const { editor, invokeAI } = createEditor()
    const command = improveWriting(editor as never)

    expect(command).toMatchObject({
      key: 'improve_writing',
      title: 'Improve Writing',
      aliases: ['improve', 'better', 'enhance', 'rewrite'],
      size: 'small'
    })

    command.onItemClick()
    await waitFor(() => expect(invokeAI).toHaveBeenCalledOnce())
    expect(invokeAI).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: expect.stringContaining('Improve the selected text'),
        useSelection: true,
        streamToolsProvider: expect.objectContaining({
          providerOptions: {
            defaultStreamTools: { add: false, delete: false, update: true }
          }
        })
      })
    )
  })

  it('uses add-only tools for continue-writing and action-item commands', async () => {
    const continueEditor = createEditor(false)
    continueWriting(continueEditor.editor as never).onItemClick()
    await waitFor(() => expect(continueEditor.invokeAI).toHaveBeenCalledOnce())
    expect(continueEditor.invokeAI).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: expect.stringContaining('Continue writing'),
        useSelection: false,
        streamToolsProvider: expect.objectContaining({
          providerOptions: {
            defaultStreamTools: { add: true, delete: false, update: false }
          }
        })
      })
    )

    const actionEditor = createEditor()
    actionItems(actionEditor.editor as never).onItemClick()
    await waitFor(() => expect(actionEditor.invokeAI).toHaveBeenCalledOnce())
    expect(actionEditor.invokeAI).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: expect.stringContaining('Extract action items'),
        useSelection: true,
        streamToolsProvider: expect.objectContaining({
          providerOptions: {
            defaultStreamTools: { add: true, delete: false, update: false }
          }
        })
      })
    )
  })

  it('creates language-specific translate commands', async () => {
    const { editor, invokeAI } = createEditor()
    const command = translate('German')(editor as never)

    expect(command).toMatchObject({
      key: 'translate_german',
      title: 'Translate to German',
      aliases: ['translate', 'german']
    })

    command.onItemClick()
    await waitFor(() => expect(invokeAI).toHaveBeenCalledOnce())
    expect(invokeAI).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt:
          'Translate the selected text to German. Only output the translation, no explanations.',
        useSelection: true
      })
    )
  })

  it('combines defaults with selection or no-selection commands without duplicate keys', () => {
    render(<CustomAIMenu />)
    expect(aiMocks.capturedItems).toBeDefined()

    const withSelection = aiMocks.capturedItems?.(createEditor(true).editor, 'user-input') ?? []
    expect(withSelection.map((item) => item.key)).toEqual([
      'default_only',
      ...SELECTION_COMMANDS.map((factory) => factory(createEditor().editor as never).key)
    ])

    const withoutSelection = aiMocks.capturedItems?.(createEditor(false).editor, 'user-input') ?? []
    expect(withoutSelection.map((item) => item.key)).toEqual([
      'improve_writing',
      'default_only',
      ...NO_SELECTION_COMMANDS.map((factory) => factory(createEditor(false).editor as never).key)
    ])

    const fallback = aiMocks.capturedItems?.(createEditor(true).editor, 'thinking') ?? []
    expect(fallback).toEqual([
      { key: 'improve_writing', title: 'Default improve thinking' },
      { key: 'default_only', title: 'Default only thinking' }
    ])
  })
})

import { describe, expect, it, vi } from 'vitest'

import {
  TOOL_IMAGE_NOT_SENT,
  toolImageMiddleware,
  type ModelCallOptions,
  type ModelPrompt
} from '../tool-images'

const RESULT_TEXT = JSON.stringify({ ok: true, data: { id: 'file-1', width: 4 } })

function promptWithImage(): ModelPrompt {
  return [
    { role: 'user', content: [{ type: 'text', text: 'What does the screenshot say?' }] },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'vault_view_file',
          input: { id: 'file-1' }
        }
      ]
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'vault_view_file',
          output: {
            type: 'content',
            value: [
              { type: 'text', text: RESULT_TEXT },
              { type: 'image-data', data: 'iVBORw0KGgo=', mediaType: 'image/png' }
            ]
          }
        }
      ]
    }
  ]
}

async function transform(
  prompt: ModelPrompt,
  acceptsImages: () => Promise<boolean>
): Promise<ModelCallOptions> {
  const middleware = toolImageMiddleware(acceptsImages)
  const params = { prompt } as ModelCallOptions
  return middleware.transformParams!({ type: 'stream', params, model: {} as never })
}

describe('toolImageMiddleware', () => {
  it('moves a tool image into a user message after the tool results for a model that takes images', async () => {
    const result = await transform(promptWithImage(), async () => true)

    expect(result.prompt.slice(2)).toEqual([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'vault_view_file',
            output: { type: 'text', value: RESULT_TEXT }
          }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Image returned by vault_view_file (call call-1):' },
          { type: 'file', data: 'iVBORw0KGgo=', mediaType: 'image/png' }
        ]
      }
    ])
  })

  it('replaces the image with a text notice for a model that does not take images', async () => {
    const result = await transform(promptWithImage(), async () => false)

    expect(result.prompt).toHaveLength(3)
    expect(result.prompt[2]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'vault_view_file',
          output: { type: 'text', value: `${RESULT_TEXT}\n${TOOL_IMAGE_NOT_SENT}` }
        }
      ]
    })
    expect(JSON.stringify(result.prompt)).not.toContain('iVBORw0KGgo=')
  })

  it('leaves a prompt without tool images alone and never asks whether the model takes images', async () => {
    const acceptsImages = vi.fn(async () => true)
    const prompt: ModelPrompt = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'vault_get_tags',
            output: { type: 'json', value: { ok: true } }
          }
        ]
      }
    ]

    const result = await transform(prompt, acceptsImages)

    expect(result.prompt).toBe(prompt)
    expect(acceptsImages).not.toHaveBeenCalled()
  })
})

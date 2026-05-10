import { describe, expect, it } from 'vitest'

import type { Message, MessageAttachment } from '../../storage/types'
import { assemblePrompt, SYSTEM_PROMPT_HEADER } from '../prompt-assembler'

const baseMessage = (overrides: Partial<Message>): Message => ({
  id: 'm',
  conversationId: 'c',
  role: 'user',
  content: { role: 'user', data: { text: 'hi' } },
  toolCallId: null,
  attachments: [],
  status: 'completed',
  vectorClock: { d: 1 },
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  ...overrides
})

describe('Prompt assembler', () => {
  it('starts with the system header', () => {
    const out = assemblePrompt({
      history: [],
      userMessage: 'hello',
      attachments: []
    })

    expect(out.startsWith(SYSTEM_PROMPT_HEADER)).toBe(true)
  })

  it('appends user message at the end', () => {
    const out = assemblePrompt({
      history: [],
      userMessage: 'final message',
      attachments: []
    })

    expect(out).toContain('User: final message')
  })

  it('serializes prior turns oldest to newest', () => {
    const out = assemblePrompt({
      history: [
        baseMessage({
          role: 'user',
          content: { role: 'user', data: { text: 'first' } },
          createdAt: 1
        }),
        baseMessage({
          role: 'assistant',
          content: { role: 'assistant', data: { text: 'second' } },
          createdAt: 2
        })
      ],
      userMessage: 'third',
      attachments: []
    })

    const firstIndex = out.indexOf('first')
    const secondIndex = out.indexOf('second')
    const thirdIndex = out.indexOf('third')
    expect(firstIndex).toBeLessThan(secondIndex)
    expect(secondIndex).toBeLessThan(thirdIndex)
  })

  it('inlines attached note content under a label and notes truncation', () => {
    const attachment: MessageAttachment = {
      kind: 'note',
      refId: 'n1',
      label: 'My Note',
      snapshotAt: 0,
      snapshot: {
        mode: 'inline_note',
        title: 'My Note',
        contentMarkdown: 'BODY',
        truncated: true
      }
    }

    const out = assemblePrompt({ history: [], userMessage: 'q', attachments: [attachment] })

    expect(out).toContain('Attached note: My Note (n1)')
    expect(out).toContain('BODY')
    expect(out).toContain('[truncated; use vault.read_note for full content]')
  })

  it('renders folder refs as reference-only', () => {
    const attachment: MessageAttachment = {
      kind: 'folder',
      refId: 'f1',
      label: 'Projects',
      snapshotAt: 0,
      snapshot: { mode: 'reference_only', path: '/Projects' }
    }

    const out = assemblePrompt({ history: [], userMessage: 'q', attachments: [attachment] })

    expect(out).toContain('Attached folder reference: /Projects')
    expect(out).toContain('vault.list_folder')
  })

  it('summarizes tool_call/tool_result pairs in history', () => {
    const out = assemblePrompt({
      history: [
        baseMessage({
          role: 'tool_call',
          content: {
            role: 'tool_call',
            data: {
              tool: 'vault_create_task',
              args: { title: 'X' },
              status: 'completed'
            }
          },
          createdAt: 1
        }),
        baseMessage({
          role: 'tool_result',
          content: { role: 'tool_result', data: { ok: true, data: { id: 't1' } } },
          createdAt: 2
        })
      ],
      userMessage: 'q',
      attachments: []
    })

    expect(out).toContain('vault_create_task')
    expect(out).toContain('"id":"t1"')
  })
})

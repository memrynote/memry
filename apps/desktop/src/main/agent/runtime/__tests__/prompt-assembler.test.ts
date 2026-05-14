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

  it('instructs the agent to use provided Memry refs as exact markdown links', () => {
    expect(SYSTEM_PROMPT_HEADER).toContain('use the exact markdown link')
    expect(SYSTEM_PROMPT_HEADER).toContain('Do not invent memry:// links')
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

  it('includes Identity, Tool Use, Memry Objects, Workflows, Links, Style, and Ambiguity sections in the system header', () => {
    expect(SYSTEM_PROMPT_HEADER).toContain('# Identity')
    expect(SYSTEM_PROMPT_HEADER).toContain('# Tool Use')
    expect(SYSTEM_PROMPT_HEADER).toContain('# Memry Objects')
    expect(SYSTEM_PROMPT_HEADER).toContain('# Workflows')
    expect(SYSTEM_PROMPT_HEADER).toContain('# Links')
    expect(SYSTEM_PROMPT_HEADER).toContain('# Style')
    expect(SYSTEM_PROMPT_HEADER).toContain('# Ambiguity')
  })

  it('preserves write-gate and refusal guidance in the Tool Use section', () => {
    expect(SYSTEM_PROMPT_HEADER).toContain('write gate')
    expect(SYSTEM_PROMPT_HEADER).toContain('Refuse')
  })

  it('routes deictic note references through vault_get_current_note', () => {
    expect(SYSTEM_PROMPT_HEADER).toContain('vault_get_current_note')
  })

  it('routes title-ish references through vault_search_notes', () => {
    expect(SYSTEM_PROMPT_HEADER).toContain('vault_search_notes')
  })

  it('guards user-curated vocabularies against invented values', () => {
    expect(SYSTEM_PROMPT_HEADER).toContain('vault_list_statuses')
    expect(SYSTEM_PROMPT_HEADER).toContain('vault_get_tags')
    expect(SYSTEM_PROMPT_HEADER).toContain('Do not invent new statuses or tags')
  })

  it('prefers archive over delete for ambiguous cleanup', () => {
    expect(SYSTEM_PROMPT_HEADER).toContain('Prefer archive over delete')
  })

  it('lists capture, journal, and status workflows in the Workflows section', () => {
    expect(SYSTEM_PROMPT_HEADER).toContain('vault_add_to_inbox')
    expect(SYSTEM_PROMPT_HEADER).toContain('vault_get_journal_entry')
    expect(SYSTEM_PROMPT_HEADER).toContain('vault_update_task')
  })

  it('omits the Context section when no context is provided', () => {
    const out = assemblePrompt({
      history: [],
      userMessage: 'hello',
      attachments: []
    })

    expect(out).not.toContain('# Context')
  })

  it('injects date and timezone into a Context section when context is provided', () => {
    const out = assemblePrompt({
      history: [],
      userMessage: 'hello',
      attachments: [],
      context: {
        now: new Date('2026-05-14T08:30:00Z'),
        timezone: 'Asia/Istanbul'
      }
    })

    expect(out).toContain('# Context')
    expect(out).toContain('Date: 2026-05-14')
    expect(out).toContain('Asia/Istanbul')
  })

  it('places the Context section between the header and the user message', () => {
    const out = assemblePrompt({
      history: [],
      userMessage: 'hello',
      attachments: [],
      context: {
        now: new Date('2026-05-14T08:30:00Z'),
        timezone: 'Asia/Istanbul'
      }
    })

    const contextIndex = out.indexOf('# Context')
    const userIndex = out.indexOf('User: hello')
    expect(contextIndex).toBeGreaterThan(0)
    expect(contextIndex).toBeLessThan(userIndex)
  })

  it('renders the latest compaction summary in place of the summarized prefix', () => {
    const out = assemblePrompt({
      history: [
        baseMessage({
          id: 'old-1',
          role: 'user',
          content: { role: 'user', data: { text: 'summarized user text' } },
          createdAt: 1
        }),
        baseMessage({
          id: 'old-2',
          role: 'assistant',
          content: { role: 'assistant', data: { text: 'summarized assistant text' } },
          createdAt: 2
        }),
        baseMessage({
          id: 'keep-1',
          role: 'user',
          content: { role: 'user', data: { text: 'kept user text' } },
          createdAt: 3
        }),
        baseMessage({
          id: 'compact-1',
          role: 'system',
          content: {
            role: 'system',
            data: {
              kind: 'compacted',
              payload: {
                summary: 'Earlier in this conversation: old decisions',
                summarizedThroughId: 'old-2',
                summarizedAt: 1
              }
            }
          },
          createdAt: 4
        })
      ],
      userMessage: 'now',
      attachments: []
    })

    expect(out).toContain('Earlier in this conversation: old decisions')
    expect(out).toContain('kept user text')
    expect(out).not.toContain('summarized user text')
    expect(out).not.toContain('summarized assistant text')
    expect(out.indexOf('Earlier in this conversation')).toBeLessThan(out.indexOf('kept user text'))
  })
})

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

  it('instructs the agent to use provided memrynote refs as exact markdown links', () => {
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
    expect(out).toContain('[truncated; use vault_read_note for full content]')
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
    expect(out).toContain('vault_list_folder')
  })

  it('renders journal, task, project, and generic attachment references', () => {
    const attachments: MessageAttachment[] = [
      {
        kind: 'journal',
        refId: 'journal:2026-05-14',
        label: 'Today',
        snapshotAt: 0,
        snapshot: {
          mode: 'inline_journal',
          date: '2026-05-14',
          contentMarkdown: 'Journal body',
          truncated: true
        }
      },
      {
        kind: 'task',
        refId: 'task-1',
        label: 'Follow up',
        snapshotAt: 0,
        snapshot: {
          mode: 'inline_task',
          title: 'Follow up',
          status: 'doing',
          due: '2026-05-15',
          project: 'Launch'
        }
      },
      {
        kind: 'project',
        refId: 'project-1',
        label: 'Launch',
        snapshotAt: 0,
        snapshot: {
          mode: 'inline_project',
          name: 'Launch',
          taskCount: 4
        }
      },
      {
        kind: 'current_note',
        refId: 'current',
        label: 'Current note',
        snapshotAt: 0,
        snapshot: {
          mode: 'reference_only',
          id: 'note-1'
        }
      }
    ]

    const out = assemblePrompt({ history: [], userMessage: 'q', attachments })

    expect(out).toContain('Attached journal entry: 2026-05-14 (journal:2026-05-14)')
    expect(out).toContain('Journal body')
    expect(out).toContain('[truncated; use vault_get_journal_entry for full content]')
    expect(out).toContain(
      'Attached task: Follow up (task-1) status=doing due=2026-05-15 project=Launch'
    )
    expect(out).toContain('Attached project: Launch (project-1) tasks=4')
    expect(out).toContain('Attached reference: Current note (current)')
  })

  it('renders optional attachment fields only when present', () => {
    const attachments: MessageAttachment[] = [
      {
        kind: 'journal',
        refId: 'journal:2026-05-15',
        label: 'Tomorrow',
        snapshotAt: 0,
        snapshot: {
          mode: 'inline_journal',
          date: '2026-05-15',
          contentMarkdown: 'Short entry',
          truncated: false
        }
      },
      {
        kind: 'task',
        refId: 'task-2',
        label: 'No date',
        snapshotAt: 0,
        snapshot: {
          mode: 'inline_task',
          title: 'No date',
          status: 'todo'
        }
      },
      {
        kind: 'project',
        refId: 'project-2',
        label: 'Empty Project',
        snapshotAt: 0,
        snapshot: {
          mode: 'inline_project',
          name: 'Empty Project'
        }
      }
    ]

    const out = assemblePrompt({ history: [], userMessage: 'q', attachments })

    expect(out).toContain('Attached journal entry: 2026-05-15 (journal:2026-05-15)')
    expect(out).not.toContain('vault_get_journal_entry for full content')
    expect(out).toContain('Attached task: No date (task-2) status=todo')
    expect(out).not.toContain('due=')
    expect(out).not.toContain('project=')
    expect(out).toContain('Attached project: Empty Project (project-2)')
    expect(out).not.toContain('tasks=0')
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

  it('summarizes failed tool results and system context messages in history', () => {
    const out = assemblePrompt({
      history: [
        baseMessage({
          role: 'tool_result',
          content: {
            role: 'tool_result',
            data: { ok: false, error: { code: 'FAILED', message: 'bad input' } }
          },
          createdAt: 1
        }),
        baseMessage({
          role: 'system',
          content: {
            role: 'system',
            data: { kind: 'context_attached', payload: { refId: 'note-1' } }
          },
          createdAt: 2
        })
      ],
      userMessage: 'q',
      attachments: []
    })

    expect(out).toContain('Tool error: {"code":"FAILED","message":"bad input"}')
    expect(out).toContain('System (context_attached): {"refId":"note-1"}')
  })

  it('includes Identity, Tool Use, memrynote Objects, Workflows, Links, Style, and Ambiguity sections in the system header', () => {
    expect(SYSTEM_PROMPT_HEADER).toContain('# Identity')
    expect(SYSTEM_PROMPT_HEADER).toContain('# Tool Use')
    expect(SYSTEM_PROMPT_HEADER).toContain('# memrynote Objects')
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
    expect(SYSTEM_PROMPT_HEADER).toContain('Do not invent statuses, projects, or folders')
    expect(SYSTEM_PROMPT_HEADER).toContain('create a new tag only when the user clearly names it')
  })

  it('prefers archive over delete for ambiguous cleanup', () => {
    expect(SYSTEM_PROMPT_HEADER).toContain('Prefer archive over delete')
  })

  it('lists capture, journal, and status workflows in the Workflows section', () => {
    expect(SYSTEM_PROMPT_HEADER).toContain('vault_add_to_inbox')
    expect(SYSTEM_PROMPT_HEADER).toContain('vault_get_journal_entry')
    expect(SYSTEM_PROMPT_HEADER).toContain('vault_update_task')
  })

  it('keeps read-tool guidance accurate about approval and provider prompts', () => {
    expect(SYSTEM_PROMPT_HEADER).toContain('Read tools do not require write approval')
    expect(SYSTEM_PROMPT_HEADER).toContain(
      'returned vault content may be included in the provider prompt'
    )
  })

  it('separates daily journal and journal range workflows', () => {
    expect(SYSTEM_PROMPT_HEADER).toContain('For a single day, use vault_get_journal_entry')
    expect(SYSTEM_PROMPT_HEADER).toContain('For a range like "this week"')
  })

  it('routes tags by target type and includes inbox processing guidance', () => {
    expect(SYSTEM_PROMPT_HEADER).toContain('vault_add_inbox_tag')
    expect(SYSTEM_PROMPT_HEADER).toContain('vault_snooze_inbox_item')
    expect(SYSTEM_PROMPT_HEADER).toContain('Inbox processing')
    expect(SYSTEM_PROMPT_HEADER).toContain('convert to task')
  })

  it('limits broad vault scans and links derived tasks to source items when supported', () => {
    expect(SYSTEM_PROMPT_HEADER).toContain('Do not scan the whole vault')
    expect(SYSTEM_PROMPT_HEADER).toContain('link back to the source item')
  })

  it('only proceeds on harmless defaults for read-only answers', () => {
    expect(SYSTEM_PROMPT_HEADER).toContain('If a harmless default exists for a read-only answer')
    expect(SYSTEM_PROMPT_HEADER).toContain('For writes, ask when the default would change')
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

  it('falls back to the ISO date when the timezone is invalid', () => {
    const out = assemblePrompt({
      history: [],
      userMessage: 'hello',
      attachments: [],
      context: {
        now: new Date('2026-05-14T23:30:00Z'),
        timezone: 'Bad/Timezone'
      }
    })

    expect(out).toContain('Date: 2026-05-14 (Bad/Timezone)')
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

  it('keeps history unchanged when compaction metadata is incomplete', () => {
    const out = assemblePrompt({
      history: [
        baseMessage({
          id: 'old-1',
          role: 'user',
          content: { role: 'user', data: { text: 'original text' } },
          createdAt: 1
        }),
        baseMessage({
          id: 'compact-1',
          role: 'system',
          content: {
            role: 'system',
            data: {
              kind: 'compacted',
              payload: {
                summary: 'Missing summarized id'
              }
            }
          },
          createdAt: 2
        })
      ],
      userMessage: 'now',
      attachments: []
    })

    expect(out).toContain('original text')
    expect(out).toContain('Missing summarized id')
  })

  it('keeps history unchanged when compaction points at a missing message', () => {
    const out = assemblePrompt({
      history: [
        baseMessage({
          id: 'old-1',
          role: 'user',
          content: { role: 'user', data: { text: 'visible old text' } },
          createdAt: 1
        }),
        baseMessage({
          id: 'compact-1',
          role: 'system',
          content: {
            role: 'system',
            data: {
              kind: 'compacted',
              payload: {
                summary: 123,
                summarizedThroughId: 'missing'
              }
            }
          },
          createdAt: 2
        })
      ],
      userMessage: 'now',
      attachments: []
    })

    expect(out).toContain('visible old text')
    expect(out).toContain('Earlier in this conversation: compacted.')
  })
})

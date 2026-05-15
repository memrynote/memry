import type { AgentTurnPermissions } from '@memry/contracts/ipc-agent'

import type { Message, MessageAttachment } from '../storage/types'

export const SYSTEM_PROMPT_HEADER = [
  '# Identity',
  'You are the Memry agent. You help the user understand and act on their Memry vault. Use Memry MCP tools to read, create, and update notes, tasks, projects, journals, inbox items, folders, tags, statuses, and other allowlisted desktop data. For broader desktop CRUD, use vault_desktop_read and vault_desktop_write.',
  '',
  '# Tool Use',
  '- Prefer tools over generic advice when the user asks about vault content or wants changes made.',
  '- Read tools do not require write approval. Use them when needed, but remember returned vault content may be included in the provider prompt.',
  '- For independent reads, call tools in parallel when supported.',
  '- For deictic references ("this note", "the current one", "what I am reading"), call vault_get_current_note before asking the user which note they mean.',
  '- For title-ish phrases the user mentions, call vault_search_notes before asking "which note?" — only ask when search returns no results or many irrelevant matches.',
  '- Statuses, tags, projects, and folders are user-curated. Before setting one by name, call vault_list_statuses, vault_get_tags, vault_list_projects, or vault_list_folder to use the exact existing value. Do not invent statuses, projects, or folders. For tags, reuse existing tags when possible; create a new tag only when the user clearly names it or approves it.',
  "- Write tools go through Memry's write gate. Before any write, state in one short sentence what you are about to change, then call the tool.",
  "- Keep writes minimal and directly tied to the user's request. Do not rename, delete, archive, reorder, or broaden scope unless asked.",
  '- Prefer archive over delete. Only call vault_delete_* when the user uses explicit deletion words ("delete", "remove permanently"). For "I am done with this", use archive — it is reversible.',
  '- Do not scan the whole vault unless the user asks for broad analysis. Start with current refs, search results, active tasks, or the named folder/project.',
  '- If a tool errors, surface the error plainly. Retry only when the error gives an obvious correction; otherwise stop or continue with partial results if useful.',
  '- When the user references a folder, use vault_list_folder and vault_read_note to drill in.',
  "- Stay inside this user's vault by default. Refuse requests to access other users, system files, secrets, or non-allowlisted desktop operations. Use network resources only when Active Permissions enables web search and the runtime exposes a web tool.",
  '',
  '# Memry Objects',
  '- Use notes for durable knowledge.',
  '- Use tasks for actionable work.',
  '- Use projects for grouped work.',
  '- Use inbox items for unprocessed capture.',
  '- Use journals for date-bound reflection or planning.',
  "Choose the object type that matches the user's intent.",
  '',
  '# Workflows',
  '- Quick capture ("save this", "remember this", "for later") → vault_add_to_inbox.',
  '- Journal request → resolve exact dates from Context. For a single day, use vault_get_journal_entry. For a range like "this week", list or read the relevant journal entries.',
  '- Status change → vault_list_statuses first, then vault_update_task.',
  '- Tag change → vault_get_tags first, then use the tag tool for the target type: vault_add_tag/vault_remove_tag for notes, vault_add_inbox_tag/vault_remove_inbox_tag for inbox items.',
  '- Inbox triage → inspect pending inbox items, then choose vault_archive_inbox_item, vault_snooze_inbox_item, convert to task, convert to note, tag, or leave untouched.',
  '- When creating tasks from a note, journal, inbox item, or meeting summary, link back to the source item when the tool schema supports it.',
  '- "What am I working on?" → vault_list_tasks (active statuses) and vault_list_inbox_items.',
  '- Summarize a note without a ref → vault_get_current_note first.',
  '',
  '# Links',
  'Tool results may include href or source_ref values for Memry items. Whenever you mention a Memry item with one of those refs, use the exact markdown link, for example [Title](memry://note/id). If you list returned items, link every listed item with its provided href. If you create an item, link the created item from the tool result. Do not invent memry:// links for plain titles without refs.',
  '',
  '# Style',
  '- Be concise.',
  '- No sycophantic openers.',
  '- Lead with the answer or result.',
  '- Do not quote full note bodies back; summarize or link.',
  '- After successful writes, report only what changed and link affected items.',
  '',
  '# Ambiguity',
  '- Ask one targeted question only when ambiguity would change the write, scope, or user intent.',
  '- If a harmless default exists for a read-only answer, proceed. For writes, ask when the default would change organization, metadata, dates, or deletion/archive behavior.',
  '- If you cannot find a ref the user mentioned, say so. Never fabricate an ID.'
].join('\n')

export interface PromptContext {
  now: Date
  timezone: string
}

export interface AssembleInput {
  history: Message[]
  userMessage: string
  attachments: MessageAttachment[]
  permissions?: AgentTurnPermissions
  context?: PromptContext
}

export function assemblePrompt(input: AssembleInput): string {
  const lines: string[] = [SYSTEM_PROMPT_HEADER, '']

  if (input.context) {
    lines.push(...renderContext(input.context), '')
  }

  if (input.permissions) {
    lines.push(...renderPermissions(input.permissions), '')
  }

  if (input.attachments.length > 0) {
    lines.push('--- Attached references ---')
    for (const attachment of input.attachments) {
      lines.push(...renderAttachment(attachment))
      lines.push('')
    }
  }

  if (input.history.length > 0) {
    lines.push('--- Prior turns ---')
    for (const message of compactedHistory(input.history)) {
      lines.push(...renderMessage(message))
    }
    lines.push('')
  }

  lines.push(`User: ${input.userMessage}`)
  return lines.join('\n')
}

function renderPermissions(permissions: AgentTurnPermissions): string[] {
  const access =
    permissions.accessMode === 'computer_access'
      ? 'Computer access requested for this turn.'
      : 'Vault-only access for this turn.'
  const web = permissions.webSearchEnabled
    ? 'Web search requested for this turn.'
    : 'Web search is off for this turn.'

  return [
    '# Active Permissions',
    access,
    web,
    'Use only tools exposed by this runtime. If a requested capability is not available, say so instead of pretending it ran.'
  ]
}

function renderContext(context: PromptContext): string[] {
  return ['# Context', `Date: ${formatDate(context.now, context.timezone)} (${context.timezone})`]
}

function formatDate(now: Date, timezone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
    return formatter.format(now)
  } catch {
    return now.toISOString().slice(0, 10)
  }
}

function compactedHistory(history: Message[]): Message[] {
  const sorted = [...history].sort((a, b) => a.createdAt - b.createdAt)
  const latestCompactionIndex = findLatestCompactionIndex(sorted)
  if (latestCompactionIndex === -1) return sorted

  const compaction = sorted[latestCompactionIndex]
  if (compaction.content.role !== 'system') return sorted

  const summarizedThroughId = compaction.content.data.payload.summarizedThroughId
  if (typeof summarizedThroughId !== 'string') return sorted

  const summarizedThroughIndex = sorted.findIndex((message) => message.id === summarizedThroughId)
  if (summarizedThroughIndex === -1) return sorted

  return [
    compaction,
    ...sorted.filter(
      (_, index) => index > summarizedThroughIndex && index !== latestCompactionIndex
    )
  ]
}

function findLatestCompactionIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (
      message.role === 'system' &&
      message.content.role === 'system' &&
      message.content.data.kind === 'compacted'
    ) {
      return index
    }
  }
  return -1
}

function renderAttachment(attachment: MessageAttachment): string[] {
  const snapshot = attachment.snapshot
  if (snapshot.mode === 'inline_note') {
    const lines = [
      `Attached note: ${snapshot.title} (${attachment.refId})`,
      snapshot.contentMarkdown
    ]
    if (snapshot.truncated) {
      lines.push('[truncated; use vault_read_note for full content]')
    }
    return lines
  }

  if (snapshot.mode === 'inline_journal') {
    const lines = [
      `Attached journal entry: ${snapshot.date} (${attachment.refId})`,
      snapshot.contentMarkdown
    ]
    if (snapshot.truncated) {
      lines.push('[truncated; use vault_get_journal_entry for full content]')
    }
    return lines
  }

  if (snapshot.mode === 'inline_task') {
    return [
      `Attached task: ${snapshot.title} (${attachment.refId}) status=${snapshot.status}${
        snapshot.due ? ` due=${snapshot.due}` : ''
      }${snapshot.project ? ` project=${snapshot.project}` : ''}`
    ]
  }

  if (snapshot.mode === 'inline_project') {
    return [
      `Attached project: ${snapshot.name} (${attachment.refId})${
        snapshot.taskCount ? ` tasks=${snapshot.taskCount}` : ''
      }`
    ]
  }

  if (attachment.kind === 'folder') {
    return [
      `Attached folder reference: ${snapshot.path ?? attachment.refId} - use vault_list_folder to drill in`
    ]
  }

  return [`Attached reference: ${attachment.label} (${attachment.refId})`]
}

function renderMessage(message: Message): string[] {
  if (message.role === 'user' && message.content.role === 'user') {
    return [`User: ${message.content.data.text}`]
  }

  if (message.role === 'assistant' && message.content.role === 'assistant') {
    return [`Assistant: ${message.content.data.text}`]
  }

  if (message.role === 'tool_call' && message.content.role === 'tool_call') {
    return [
      `Tool call: ${message.content.data.tool}`,
      `Args: ${JSON.stringify(message.content.data.args)}`,
      `Status: ${message.content.data.status}`
    ]
  }

  if (message.role === 'tool_result' && message.content.role === 'tool_result') {
    if (message.content.data.ok) {
      return [`Tool result: ${JSON.stringify(message.content.data.data)}`]
    }
    return [`Tool error: ${JSON.stringify(message.content.data.error)}`]
  }

  if (message.role === 'system' && message.content.role === 'system') {
    if (message.content.data.kind === 'compacted') {
      const summary = message.content.data.payload.summary
      return [typeof summary === 'string' ? summary : 'Earlier in this conversation: compacted.']
    }

    return [
      `System (${message.content.data.kind}): ${JSON.stringify(message.content.data.payload)}`
    ]
  }

  return []
}

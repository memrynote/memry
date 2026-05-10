# Agent Chat — P3: Agent Chat UI (Claude CLI Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the right-sidebar Agent chat panel that lets a user converse with a Claude CLI–backed agent over the Vault MCP server, persists each turn through the conversation/message stores, and enforces the spec's create-tool trust list / update-tool always-confirm permission model.

**Architecture:** Three runtime layers. `AgentRuntime` (main process) orchestrates a turn — assembles prompt from stored history + attachments, spawns a stateless `claude` subprocess with strict MCP config + disabled built-in tools, parses streaming JSON events, routes tool calls through the permission gate, persists messages. The Vault MCP server (built in P1) gets a write-tool gate wired in that defers to AgentRuntime's pending-approval map. The renderer hosts a tabbed right sidebar (Day | Agent), the message stream, the @ ref picker, the attached-refs chip strip, the approval modal, and the diff-preview modal.

**Tech Stack:** Electron 39, React 19, Vite, Zustand-like context (project convention), Radix Dialog, BlockNote (read-only mode for message rendering), libsodium (existing), better-sqlite3 (existing). Adds `react-diff-view` for the update-note diff (or hand-rolled — see Task 28). No new external HTTP libraries.

**Spec reference:** [`docs/superpowers/specs/2026-05-10-agent-chat-design.md`](../specs/2026-05-10-agent-chat-design.md) — Phase 3 + cross-cutting sections.

**Dependencies on prior phases:**

- P1 must be merged (Vault MCP server, write tools registered with deny-by-default gate).
- P2 must be merged (conversation/message stores + sync types).

---

## File Structure

**New main-process files:**

| Path                                                                     | Responsibility                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `apps/desktop/src/main/agent/runtime/runtime.ts`                         | `AgentRuntime` orchestrator: turn lifecycle, event broadcast, write-gate adapter     |
| `apps/desktop/src/main/agent/runtime/turn.ts`                            | Per-turn state machine: prompt assembly → spawn → parse → gate → persist             |
| `apps/desktop/src/main/agent/runtime/permission-gate.ts`                 | Pure decision function backed by per-conversation in-memory pending map + trust list |
| `apps/desktop/src/main/agent/runtime/prompt-assembler.ts`                | Builds the Claude prompt from stored history + attachments                           |
| `apps/desktop/src/main/agent/runtime/token-estimator.ts`                 | Cheap heuristic token counter (chars/4) for compaction trigger                       |
| `apps/desktop/src/main/agent/runtime/compactor.ts`                       | Triggers + persists context-compaction system message                                |
| `apps/desktop/src/main/agent/cli/claude-binary.ts`                       | Locate `claude` on PATH, parse `--version`, version-pin check                        |
| `apps/desktop/src/main/agent/cli/spawn.ts`                               | `spawn` wrapper that builds argv and writes the per-turn `mcp-config.json`           |
| `apps/desktop/src/main/agent/cli/stream-parser.ts`                       | Line-buffered parser for `--output-format stream-json` events                        |
| `apps/desktop/src/main/agent/cli/types.ts`                               | Backend-event union shared by parser/runtime                                         |
| `apps/desktop/src/main/ipc/agent-handlers.ts`                            | All `agent:*` IPC handlers                                                           |
| `apps/desktop/src/main/agent/runtime/event-bus.ts`                       | Typed event emitter that fans out to renderer windows                                |
| `apps/desktop/src/main/agent/runtime/__tests__/permission-gate.test.ts`  | Decision-table coverage                                                              |
| `apps/desktop/src/main/agent/runtime/__tests__/prompt-assembler.test.ts` | History/attachment serialization                                                     |
| `apps/desktop/src/main/agent/runtime/__tests__/turn.test.ts`             | End-to-end turn against a stub backend                                               |
| `apps/desktop/src/main/agent/cli/__tests__/stream-parser.test.ts`        | Fixture-driven parsing                                                               |
| `apps/desktop/src/main/agent/cli/__tests__/claude-binary.test.ts`        | Detection + version-floor                                                            |

**New contracts:**

| Path                                  | Responsibility                          |
| ------------------------------------- | --------------------------------------- |
| `packages/contracts/src/ipc-agent.ts` | All `agent:*` channels and Zod payloads |

**New renderer files (under `apps/desktop/src/renderer/src/agent-chat/`):**

| Path                                          | Responsibility                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------- |
| `agent-chat/agent-context.tsx`                | React context: conversation state, turn streaming events, pending approvals     |
| `agent-chat/sidebar-tabs.tsx`                 | Day                                                                             | Agent segmented control |
| `agent-chat/agent-pane.tsx`                   | Pane root; routes between enablement, empty, and conversation views             |
| `agent-chat/enablement.tsx`                   | First-use disclosure + Enable button                                            |
| `agent-chat/empty-state.tsx`                  | Post-enablement empty view + Claude binary status                               |
| `agent-chat/conversation-header.tsx`          | Title + dropdown with conversation list                                         |
| `agent-chat/conversation-list.tsx`            | Recent-conversations dropdown menu + New Conversation button                    |
| `agent-chat/message-stream.tsx`               | Bottom-anchored scroller                                                        |
| `agent-chat/messages/user-message.tsx`        | User bubble + ref chips                                                         |
| `agent-chat/messages/assistant-message.tsx`   | Assistant markdown (read-only BlockNote / fallback md)                          |
| `agent-chat/messages/tool-call-card.tsx`      | Tool-call card                                                                  |
| `agent-chat/messages/tool-result-card.tsx`    | Tool-result card                                                                |
| `agent-chat/messages/system-note.tsx`         | Dim system row                                                                  |
| `agent-chat/composer.tsx`                     | Multiline input with ref-chip strip                                             |
| `agent-chat/ref-picker.tsx`                   | `@`-triggered popover backed by search-service                                  |
| `agent-chat/approval-modal.tsx`               | Create-tool approval dialog (Allow once / Allow & always / Edit & allow / Deny) |
| `agent-chat/diff-modal.tsx`                   | Update-note diff preview                                                        |
| `agent-chat/before-after-modal.tsx`           | Update-task / add-tag / move-folder before/after preview                        |
| `agent-chat/badge-controller.ts`              | Activity badge state for the Day tab                                            |
| `agent-chat/__tests__/agent-context.test.tsx` | Context reducer tests                                                           |
| `agent-chat/__tests__/composer.test.tsx`      | Submit on Cmd/Ctrl+Enter, ref strip behavior                                    |

**Files to modify:**

| Path                                                                      | Why                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `apps/desktop/src/main/agent/mcp/lifecycle.ts` (P1)                       | Wire `AgentRuntime`'s gate into `setWriteGate(...)`          |
| `apps/desktop/src/main/index.ts`                                          | Boot `AgentRuntime`; subprocess cleanup on `app.before-quit` |
| `apps/desktop/src/main/ipc/index.ts`                                      | Register `agent-handlers`                                    |
| `apps/desktop/src/main/preload/index.ts`                                  | Expose `agent.*` IPC bridge                                  |
| `apps/desktop/src/renderer/src/App.tsx`                                   | Mount `AgentProvider` + sidebar tabs                         |
| `apps/desktop/src/renderer/src/components/day-panel/global-day-panel.tsx` | Render header tabs above the existing Day content            |
| `packages/contracts/src/index.ts`                                         | Re-export `ipc-agent`                                        |

---

## Conventions

- **Logging:** `createLogger('AgentRuntime')`, `createLogger('AgentRuntime:Turn')`, `createLogger('AgentCli')`.
- **Error UI strings:** wrap with `extractErrorMessage(err, 'fallback')`.
- **Tailwind:** logical classes only (`ms-*`, `me-*`, `ps-*`, `pe-*`, `start-*`, `end-*`, etc.).
- **Streaming events** travel renderer-ward via the existing IPC broadcast pattern (`win.webContents.send('agent:event', payload)`).
- **No CRDT for chat.** Messages are append-only.
- **Concurrent turns blocked at the conversation level.** Send button disabled while a turn is in flight.
- **Tests:** every task is TDD.

---

## Task 1: Add `agent:*` IPC contract file

**Files:**

- Create: `packages/contracts/src/ipc-agent.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Add contract**

```ts
// packages/contracts/src/ipc-agent.ts
import { z } from 'zod'

export const AgentChannels = {
  invoke: {
    LIST_CONVERSATIONS: 'agent:listConversations',
    CREATE_CONVERSATION: 'agent:createConversation',
    LOAD_CONVERSATION: 'agent:loadConversation',
    SEND_TURN: 'agent:sendTurn',
    CANCEL_TURN: 'agent:cancelTurn',
    APPROVE_TOOL: 'agent:approveTool',
    EDIT_TRUST_LIST: 'agent:editTrustList',
    GET_BINARY_STATUS: 'agent:getBinaryStatus',
    ACCEPT_DISCLOSURE: 'agent:acceptDisclosure',
    GET_DISCLOSURE_STATE: 'agent:getDisclosureState'
  },
  events: {
    AGENT_EVENT: 'agent:event'
  }
} as const

export const AttachmentInputSchema = z.object({
  kind: z.enum(['note', 'folder', 'task', 'project', 'journal', 'current_note']),
  ref_id: z.string(),
  label: z.string()
})
export type AttachmentInput = z.infer<typeof AttachmentInputSchema>

export const SendTurnRequestSchema = z.object({
  conversationId: z.string(),
  sourceWindowId: z.string(),
  text: z.string(),
  attachments: z.array(AttachmentInputSchema)
})
export type SendTurnRequest = z.infer<typeof SendTurnRequestSchema>

export const ApproveToolDecisionSchema = z.union([
  z.object({ kind: z.literal('allow') }),
  z.object({ kind: z.literal('allow_always') }),
  z.object({ kind: z.literal('edit_allow'), editedArgs: z.unknown() }),
  z.object({ kind: z.literal('deny') })
])
export type ApproveToolDecision = z.infer<typeof ApproveToolDecisionSchema>

export const ApproveToolRequestSchema = z.object({
  conversationId: z.string(),
  toolCallId: z.string(),
  decision: ApproveToolDecisionSchema
})
export type ApproveToolRequest = z.infer<typeof ApproveToolRequestSchema>

export const BinaryStatusSchema = z.object({
  detected: z.boolean(),
  version: z.string().nullable(),
  meetsMinimum: z.boolean(),
  minimumRequired: z.string(),
  installHint: z.string().nullable()
})
export type BinaryStatus = z.infer<typeof BinaryStatusSchema>

export const AgentEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('assistant_text_delta'),
    conversationId: z.string(),
    messageId: z.string(),
    text: z.string()
  }),
  z.object({
    kind: z.literal('tool_call_started'),
    conversationId: z.string(),
    toolCallId: z.string(),
    name: z.string(),
    args: z.unknown()
  }),
  z.object({
    kind: z.literal('tool_call_pending_approval'),
    conversationId: z.string(),
    toolCallId: z.string(),
    name: z.string(),
    args: z.unknown(),
    requiresDiff: z.boolean()
  }),
  z.object({
    kind: z.literal('tool_call_completed'),
    conversationId: z.string(),
    toolCallId: z.string(),
    result: z.unknown()
  }),
  z.object({
    kind: z.literal('tool_call_failed'),
    conversationId: z.string(),
    toolCallId: z.string(),
    error: z.object({ code: z.string(), message: z.string() })
  }),
  z.object({ kind: z.literal('turn_completed'), conversationId: z.string(), turnId: z.string() }),
  z.object({ kind: z.literal('turn_cancelled'), conversationId: z.string(), turnId: z.string() }),
  z.object({
    kind: z.literal('turn_error'),
    conversationId: z.string(),
    turnId: z.string(),
    message: z.string()
  })
])
export type AgentEvent = z.infer<typeof AgentEventSchema>
```

Add to `packages/contracts/src/index.ts`: `export * from './ipc-agent'`.

- [ ] **Step 2: Generate IPC invoke map**

```bash
pnpm ipc:generate
pnpm ipc:check
```

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/ipc-agent.ts packages/contracts/src/index.ts apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts
git commit -m "feat(contracts): add agent:* IPC channels"
```

---

## Task 2: Claude CLI binary detection + version pin

**Files:**

- Create: `apps/desktop/src/main/agent/cli/claude-binary.ts`
- Create: `apps/desktop/src/main/agent/cli/__tests__/claude-binary.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/desktop/src/main/agent/cli/__tests__/claude-binary.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, existsSync: vi.fn() }
})

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

import { detectClaudeBinary, MIN_CLAUDE_VERSION } from '../claude-binary'

describe('detectClaudeBinary', () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset()
    vi.mocked(existsSync).mockReset()
  })

  it('reports detected: false when which/where finds nothing', async () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 1, stdout: '', stderr: '' } as ReturnType<
      typeof spawnSync
    >)
    const status = await detectClaudeBinary()
    expect(status.detected).toBe(false)
    expect(status.version).toBeNull()
    expect(status.meetsMinimum).toBe(false)
  })

  it('parses --version output and confirms minimum', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '/usr/local/bin/claude\n', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '2.1.138 (Claude Code)\n', stderr: '' } as any)
    vi.mocked(existsSync).mockReturnValue(true)
    const status = await detectClaudeBinary()
    expect(status.detected).toBe(true)
    expect(status.version).toBe('2.1.138')
    expect(status.meetsMinimum).toBe(true)
    expect(status.minimumRequired).toBe(MIN_CLAUDE_VERSION)
  })

  it('flags too-old versions', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '/usr/local/bin/claude\n', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '1.5.0\n', stderr: '' } as any)
    vi.mocked(existsSync).mockReturnValue(true)
    const status = await detectClaudeBinary()
    expect(status.detected).toBe(true)
    expect(status.version).toBe('1.5.0')
    expect(status.meetsMinimum).toBe(false)
  })

  it('emits an install hint when undetected', async () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 1, stdout: '', stderr: '' } as any)
    const status = await detectClaudeBinary()
    expect(status.installHint).toContain('claude.ai/code')
  })
})
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/cli/__tests__/claude-binary.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/agent/cli/claude-binary.ts
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'

import type { BinaryStatus } from '@memry/contracts/ipc-agent'

export const MIN_CLAUDE_VERSION = '2.1.0'

const INSTALL_HINT =
  'Install Claude Code CLI from https://claude.ai/code, then run `claude login` to sign in to your subscription.'

function locate(): string | null {
  const which = platform() === 'win32' ? 'where' : 'which'
  const r = spawnSync(which, ['claude'])
  if (r.status !== 0) return null
  const path = r.stdout.toString().split(/\r?\n/).filter(Boolean)[0]
  if (!path || !existsSync(path)) return null
  return path
}

function readVersion(path: string): string | null {
  const r = spawnSync(path, ['--version'], { encoding: 'utf8' })
  if (r.status !== 0) return null
  const m = r.stdout.match(/(\d+\.\d+\.\d+)/)
  return m ? m[1] : null
}

function compareSemver(a: string, b: string): number {
  const parts = (s: string) => s.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const [aa, ab, ac] = parts(a)
  const [ba, bb, bc] = parts(b)
  if (aa !== ba) return aa - ba
  if (ab !== bb) return ab - bb
  return ac - bc
}

export async function detectClaudeBinary(): Promise<BinaryStatus> {
  const path = locate()
  if (!path) {
    return {
      detected: false,
      version: null,
      meetsMinimum: false,
      minimumRequired: MIN_CLAUDE_VERSION,
      installHint: INSTALL_HINT
    }
  }
  const version = readVersion(path)
  if (!version) {
    return {
      detected: true,
      version: null,
      meetsMinimum: false,
      minimumRequired: MIN_CLAUDE_VERSION,
      installHint: INSTALL_HINT
    }
  }
  const meets = compareSemver(version, MIN_CLAUDE_VERSION) >= 0
  return {
    detected: true,
    version,
    meetsMinimum: meets,
    minimumRequired: MIN_CLAUDE_VERSION,
    installHint: meets ? null : INSTALL_HINT
  }
}
```

- [ ] **Step 4: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/cli/__tests__/claude-binary.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/cli/claude-binary.ts apps/desktop/src/main/agent/cli/__tests__/claude-binary.test.ts
git commit -m "feat(agent-cli): claude binary detection with version-floor check"
```

---

## Task 3: Stream-JSON line-buffered parser

**Files:**

- Create: `apps/desktop/src/main/agent/cli/types.ts`
- Create: `apps/desktop/src/main/agent/cli/stream-parser.ts`
- Create: `apps/desktop/src/main/agent/cli/__tests__/stream-parser.test.ts`

- [ ] **Step 1: Add backend-event union**

```ts
// apps/desktop/src/main/agent/cli/types.ts
export type BackendEvent =
  | { kind: 'assistant_delta'; text: string }
  | { kind: 'tool_use'; toolUseId: string; name: string; args: unknown }
  | {
      kind: 'tool_result'
      toolUseId: string
      ok: boolean
      data?: unknown
      error?: { code: string; message: string }
    }
  | { kind: 'message_stop' }
  | { kind: 'unknown'; raw: unknown }
```

- [ ] **Step 2: Write failing test**

```ts
// apps/desktop/src/main/agent/cli/__tests__/stream-parser.test.ts
import { describe, it, expect } from 'vitest'
import { createStreamParser } from '../stream-parser'

describe('Claude stream-json parser', () => {
  it('emits assistant_delta for content_block_delta with text_delta', () => {
    const events: unknown[] = []
    const parser = createStreamParser((e) => events.push(e))
    parser.feed(
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hello ' }
      }) + '\n'
    )
    parser.feed(
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'world' }
      }) + '\n'
    )
    expect(events).toEqual([
      { kind: 'assistant_delta', text: 'hello ' },
      { kind: 'assistant_delta', text: 'world' }
    ])
  })

  it('handles split-line buffering across feed() calls', () => {
    const events: unknown[] = []
    const parser = createStreamParser((e) => events.push(e))
    const line = JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'split' }
    })
    parser.feed(line.slice(0, 10))
    expect(events).toHaveLength(0)
    parser.feed(line.slice(10) + '\n')
    expect(events).toEqual([{ kind: 'assistant_delta', text: 'split' }])
  })

  it('emits tool_use', () => {
    const events: unknown[] = []
    const parser = createStreamParser((e) => events.push(e))
    parser.feed(
      JSON.stringify({
        type: 'content_block_start',
        content_block: {
          type: 'tool_use',
          id: 'tu_1',
          name: 'mcp__memry__vault_read_note',
          input: { id: 'n1' }
        }
      }) + '\n'
    )
    expect(events[0]).toMatchObject({
      kind: 'tool_use',
      toolUseId: 'tu_1',
      name: 'mcp__memry__vault_read_note',
      args: { id: 'n1' }
    })
  })

  it('emits tool_result on success', () => {
    const events: unknown[] = []
    const parser = createStreamParser((e) => events.push(e))
    parser.feed(
      JSON.stringify({
        type: 'tool_result',
        tool_use_id: 'tu_1',
        is_error: false,
        content: [{ type: 'text', text: '{"id":"n1"}' }]
      }) + '\n'
    )
    expect(events[0]).toMatchObject({
      kind: 'tool_result',
      toolUseId: 'tu_1',
      ok: true,
      data: { id: 'n1' }
    })
  })

  it('emits tool_result on structured error', () => {
    const events: unknown[] = []
    const parser = createStreamParser((e) => events.push(e))
    parser.feed(
      JSON.stringify({
        type: 'tool_result',
        tool_use_id: 'tu_2',
        is_error: true,
        content: [{ type: 'text', text: '{"code":"NOT_FOUND","message":"missing"}' }]
      }) + '\n'
    )
    expect(events[0]).toMatchObject({
      kind: 'tool_result',
      toolUseId: 'tu_2',
      ok: false,
      error: { code: 'NOT_FOUND', message: 'missing' }
    })
  })

  it('emits message_stop on stop event', () => {
    const events: unknown[] = []
    const parser = createStreamParser((e) => events.push(e))
    parser.feed(JSON.stringify({ type: 'message_stop' }) + '\n')
    expect(events[0]).toEqual({ kind: 'message_stop' })
  })

  it('falls through to unknown for malformed JSON instead of crashing', () => {
    const events: unknown[] = []
    const parser = createStreamParser((e) => events.push(e))
    parser.feed('not json\n')
    expect(events[0]).toMatchObject({ kind: 'unknown' })
  })
})
```

- [ ] **Step 3: Run, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/cli/__tests__/stream-parser.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement**

```ts
// apps/desktop/src/main/agent/cli/stream-parser.ts
import type { BackendEvent } from './types'

export interface StreamParser {
  feed(chunk: string): void
  flush(): void
}

export function createStreamParser(onEvent: (e: BackendEvent) => void): StreamParser {
  let buffer = ''
  return {
    feed(chunk) {
      buffer += chunk
      let idx: number
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        try {
          const obj = JSON.parse(line) as Record<string, unknown>
          onEvent(translate(obj))
        } catch {
          onEvent({ kind: 'unknown', raw: line })
        }
      }
    },
    flush() {
      if (buffer.trim()) {
        try {
          const obj = JSON.parse(buffer) as Record<string, unknown>
          onEvent(translate(obj))
        } catch {
          onEvent({ kind: 'unknown', raw: buffer })
        }
      }
      buffer = ''
    }
  }
}

function translate(obj: Record<string, unknown>): BackendEvent {
  const type = obj.type
  if (type === 'content_block_delta') {
    const delta = obj.delta as { type?: string; text?: string } | undefined
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return { kind: 'assistant_delta', text: delta.text }
    }
  }
  if (type === 'content_block_start') {
    const block = obj.content_block as
      | { type?: string; id?: string; name?: string; input?: unknown }
      | undefined
    if (block?.type === 'tool_use' && block.id && block.name) {
      return {
        kind: 'tool_use',
        toolUseId: block.id,
        name: block.name,
        args: block.input ?? {}
      }
    }
  }
  if (type === 'tool_result') {
    const toolUseId = String(obj.tool_use_id ?? '')
    const isError = Boolean(obj.is_error)
    const content = obj.content as Array<{ type?: string; text?: string }> | undefined
    const text = content?.find((c) => c.type === 'text')?.text ?? ''
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      // leave as text
    }
    if (isError) {
      const errPayload =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { code?: string; message?: string })
          : null
      return {
        kind: 'tool_result',
        toolUseId,
        ok: false,
        error: {
          code: errPayload?.code ?? 'INTERNAL',
          message: errPayload?.message ?? text
        }
      }
    }
    return { kind: 'tool_result', toolUseId, ok: true, data: parsed }
  }
  if (type === 'message_stop') return { kind: 'message_stop' }
  return { kind: 'unknown', raw: obj }
}
```

- [ ] **Step 5: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/cli/__tests__/stream-parser.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/agent/cli/types.ts apps/desktop/src/main/agent/cli/stream-parser.ts apps/desktop/src/main/agent/cli/__tests__/stream-parser.test.ts
git commit -m "feat(agent-cli): line-buffered stream-json parser"
```

---

## Task 4: Subprocess spawn helper (with mcp-config side-effect)

**Files:**

- Create: `apps/desktop/src/main/agent/cli/spawn.ts`
- Create: `apps/desktop/src/main/agent/cli/__tests__/spawn.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/desktop/src/main/agent/cli/__tests__/spawn.test.ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn(async () => '/tmp/fake-dir'),
  writeFile: vi.fn(async () => {}),
  rm: vi.fn(async () => {})
}))
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'

import { spawnClaudeTurn } from '../spawn'

describe('spawnClaudeTurn', () => {
  it('writes mcp-config.json with bearer + conversation/window headers', async () => {
    const fakeProc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(fakeProc)
    await spawnClaudeTurn({
      binaryPath: '/usr/local/bin/claude',
      mcpServerUrl: 'http://127.0.0.1:54321',
      bearerToken: 'tok',
      conversationId: 'conv-1',
      windowId: 'win-1',
      allowedTools: 'mcp__memry__vault_read_note',
      prompt: 'hello'
    })
    expect(writeFile).toHaveBeenCalled()
    const written = JSON.parse(vi.mocked(writeFile).mock.calls[0][1] as string)
    expect(written.mcpServers.memry.url).toBe('http://127.0.0.1:54321/mcp')
    expect(written.mcpServers.memry.headers.Authorization).toBe('Bearer tok')
    expect(written.mcpServers.memry.headers['X-Memry-Conversation']).toBe('conv-1')
    expect(written.mcpServers.memry.headers['X-Memry-Window']).toBe('win-1')
  })

  it('passes the spec-mandated CLI flags', async () => {
    const fakeProc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(fakeProc)
    await spawnClaudeTurn({
      binaryPath: '/usr/local/bin/claude',
      mcpServerUrl: 'http://127.0.0.1:54321',
      bearerToken: 'tok',
      conversationId: 'c',
      windowId: 'w',
      allowedTools: 'mcp__memry__vault_read_note',
      prompt: 'p'
    })
    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args).toContain('-p')
    expect(args).toContain('--input-format')
    expect(args).toContain('text')
    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
    expect(args).toContain('--include-partial-messages')
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--no-session-persistence')
    expect(args).toContain('--tools')
    expect(args).toContain('')
    expect(args).toContain('--allowed-tools')
    expect(args).toContain('mcp__memry__vault_read_note')
    expect(args).toContain('--mcp-config')
  })

  it('writes the prompt to stdin and closes it', async () => {
    const fakeProc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(fakeProc)
    await spawnClaudeTurn({
      binaryPath: '/usr/local/bin/claude',
      mcpServerUrl: 'http://127.0.0.1:54321',
      bearerToken: 'tok',
      conversationId: 'c',
      windowId: 'w',
      allowedTools: 'a',
      prompt: 'PROMPT BODY'
    })
    expect(fakeProc.stdin.write).toHaveBeenCalledWith('PROMPT BODY')
    expect(fakeProc.stdin.end).toHaveBeenCalled()
  })
})

function makeFakeProc() {
  return {
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    pid: 1234
  } as any
}
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/cli/__tests__/spawn.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/agent/cli/spawn.ts
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createLogger } from '../../lib/logger'

const logger = createLogger('AgentCli:Spawn')

export interface SpawnOptions {
  binaryPath: string
  mcpServerUrl: string
  bearerToken: string
  conversationId: string
  windowId: string
  allowedTools: string
  prompt: string
}

export interface ClaudeSubprocess {
  pid: number
  proc: ChildProcess
  cleanup: () => Promise<void>
}

export async function spawnClaudeTurn(opts: SpawnOptions): Promise<ClaudeSubprocess> {
  const dir = await mkdtemp(path.join(tmpdir(), 'memry-claude-'))
  const configPath = path.join(dir, 'mcp-config.json')
  const config = {
    mcpServers: {
      memry: {
        type: 'http',
        url: `${opts.mcpServerUrl}/mcp`,
        headers: {
          Authorization: `Bearer ${opts.bearerToken}`,
          'X-Memry-Conversation': opts.conversationId,
          'X-Memry-Window': opts.windowId
        }
      }
    }
  }
  await writeFile(configPath, JSON.stringify(config))

  const args = [
    '-p',
    '--input-format',
    'text',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--mcp-config',
    configPath,
    '--strict-mcp-config',
    '--no-session-persistence',
    '--tools',
    '',
    '--allowed-tools',
    opts.allowedTools
  ]

  logger.info(`Spawning claude pid=? args=${args.join(' ')}`)
  const proc = spawn(opts.binaryPath, args, {
    cwd: dir, // sandbox: temp dir, never the vault
    env: { ...process.env }
  })
  proc.stdin.write(opts.prompt)
  proc.stdin.end()

  return {
    pid: proc.pid ?? -1,
    proc,
    cleanup: async () => {
      try {
        await rm(dir, { recursive: true, force: true })
      } catch (err) {
        logger.warn('Failed to clean tempdir', err)
      }
    }
  }
}
```

- [ ] **Step 4: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/cli/__tests__/spawn.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/cli/spawn.ts apps/desktop/src/main/agent/cli/__tests__/spawn.test.ts
git commit -m "feat(agent-cli): spawn claude subprocess with strict MCP config"
```

---

## Task 5: Token estimator + compaction trigger

**Files:**

- Create: `apps/desktop/src/main/agent/runtime/token-estimator.ts`
- Create: `apps/desktop/src/main/agent/runtime/__tests__/token-estimator.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/desktop/src/main/agent/runtime/__tests__/token-estimator.test.ts
import { describe, it, expect } from 'vitest'
import { estimateTokens, COMPACTION_THRESHOLD } from '../token-estimator'

describe('Token estimator', () => {
  it('roughly approximates 4 chars per token', () => {
    expect(estimateTokens('a'.repeat(4))).toBe(1)
    expect(estimateTokens('a'.repeat(40))).toBe(10)
  })

  it('rounds up partial tokens', () => {
    expect(estimateTokens('a'.repeat(5))).toBe(2)
  })

  it('handles empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('exposes a 100k token compaction threshold', () => {
    expect(COMPACTION_THRESHOLD).toBe(100_000)
  })
})
```

- [ ] **Step 2: Implement**

```ts
// apps/desktop/src/main/agent/runtime/token-estimator.ts
export const COMPACTION_THRESHOLD = 100_000

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / 4)
}
```

- [ ] **Step 3: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/runtime/__tests__/token-estimator.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/agent/runtime/token-estimator.ts apps/desktop/src/main/agent/runtime/__tests__/token-estimator.test.ts
git commit -m "feat(agent-runtime): token estimator with 100k compaction threshold"
```

---

## Task 6: Prompt assembler

**Files:**

- Create: `apps/desktop/src/main/agent/runtime/prompt-assembler.ts`
- Create: `apps/desktop/src/main/agent/runtime/__tests__/prompt-assembler.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/desktop/src/main/agent/runtime/__tests__/prompt-assembler.test.ts
import { describe, it, expect } from 'vitest'
import { assemblePrompt, SYSTEM_PROMPT_HEADER } from '../prompt-assembler'
import type { Message, MessageAttachment } from '../../storage/types'

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

  it('serializes prior turns oldest → newest', () => {
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
    const firstIdx = out.indexOf('first')
    const secondIdx = out.indexOf('second')
    const thirdIdx = out.indexOf('third')
    expect(firstIdx).toBeLessThan(secondIdx)
    expect(secondIdx).toBeLessThan(thirdIdx)
  })

  it('inlines attached note content under a label and notes truncation', () => {
    const att: MessageAttachment = {
      kind: 'note',
      ref_id: 'n1',
      label: 'My Note',
      snapshot_at: 0,
      snapshot: {
        mode: 'inline_note',
        title: 'My Note',
        content_markdown: 'BODY',
        truncated: true
      }
    }
    const out = assemblePrompt({ history: [], userMessage: 'q', attachments: [att] })
    expect(out).toContain('Attached note: My Note (n1)')
    expect(out).toContain('BODY')
    expect(out).toContain('[truncated; use vault.read_note for full content]')
  })

  it('renders folder refs as reference-only', () => {
    const att: MessageAttachment = {
      kind: 'folder',
      ref_id: 'f1',
      label: 'Projects',
      snapshot_at: 0,
      snapshot: { mode: 'reference_only', path: '/Projects' }
    }
    const out = assemblePrompt({ history: [], userMessage: 'q', attachments: [att] })
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
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/runtime/__tests__/prompt-assembler.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/agent/runtime/prompt-assembler.ts
import type { Message, MessageAttachment } from '../storage/types'

export const SYSTEM_PROMPT_HEADER = `You are the Memry agent. You can read the user's vault and create or update notes/tasks/journals/inbox via the memry MCP tools. Each create or update is gated by the user's explicit approval. Read tools are free to call. When the user references a folder, use vault.list_folder and vault.read_note to drill in. Be concise.`

export interface AssembleInput {
  history: Message[]
  userMessage: string
  attachments: MessageAttachment[]
}

export function assemblePrompt(input: AssembleInput): string {
  const lines: string[] = [SYSTEM_PROMPT_HEADER, '']

  if (input.attachments.length > 0) {
    lines.push('--- Attached references ---')
    for (const att of input.attachments) {
      lines.push(...renderAttachment(att))
      lines.push('')
    }
  }

  if (input.history.length > 0) {
    lines.push('--- Prior turns ---')
    for (const m of input.history) {
      lines.push(...renderMessage(m))
    }
    lines.push('')
  }

  lines.push(`User: ${input.userMessage}`)
  return lines.join('\n')
}

function renderAttachment(att: MessageAttachment): string[] {
  const s = att.snapshot
  if (s.mode === 'inline_note') {
    const out = [`Attached note: ${s.title} (${att.ref_id})`, s.content_markdown]
    if (s.truncated) out.push('[truncated; use vault.read_note for full content]')
    return out
  }
  if (s.mode === 'inline_journal') {
    const out = [`Attached journal entry: ${s.date} (${att.ref_id})`, s.content_markdown]
    if (s.truncated) out.push('[truncated; use vault.get_journal_entry for full content]')
    return out
  }
  if (s.mode === 'inline_task') {
    return [
      `Attached task: ${s.title} (${att.ref_id}) status=${s.status}${
        s.due ? ` due=${s.due}` : ''
      }${s.project ? ` project=${s.project}` : ''}`
    ]
  }
  if (s.mode === 'inline_project') {
    return [
      `Attached project: ${s.name} (${att.ref_id})${s.task_count ? ` tasks=${s.task_count}` : ''}`
    ]
  }
  // reference_only
  const tag =
    att.kind === 'folder'
      ? `Attached folder reference: ${s.path ?? att.ref_id} — use vault.list_folder to drill in`
      : `Attached reference: ${att.label} (${att.ref_id})`
  return [tag]
}

function renderMessage(m: Message): string[] {
  if (m.role === 'user' && m.content.role === 'user') return [`User: ${m.content.data.text}`]
  if (m.role === 'assistant' && m.content.role === 'assistant')
    return [`Assistant: ${m.content.data.text}`]
  if (m.role === 'tool_call' && m.content.role === 'tool_call') {
    return [
      `Tool call: ${m.content.data.tool}`,
      `Args: ${JSON.stringify(m.content.data.args)}`,
      `Status: ${m.content.data.status}`
    ]
  }
  if (m.role === 'tool_result' && m.content.role === 'tool_result') {
    if (m.content.data.ok) return [`Tool result: ${JSON.stringify(m.content.data.data)}`]
    return [`Tool error: ${JSON.stringify(m.content.data.error)}`]
  }
  if (m.role === 'system' && m.content.role === 'system') {
    return [`System (${m.content.data.kind}): ${JSON.stringify(m.content.data.payload)}`]
  }
  return []
}
```

- [ ] **Step 4: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/runtime/__tests__/prompt-assembler.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/runtime/prompt-assembler.ts apps/desktop/src/main/agent/runtime/__tests__/prompt-assembler.test.ts
git commit -m "feat(agent-runtime): prompt assembler with attachment + history serialization"
```

---

## Task 7: Permission gate

**Files:**

- Create: `apps/desktop/src/main/agent/runtime/permission-gate.ts`
- Create: `apps/desktop/src/main/agent/runtime/__tests__/permission-gate.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/desktop/src/main/agent/runtime/__tests__/permission-gate.test.ts
import { describe, it, expect } from 'vitest'
import { decideToolGate } from '../permission-gate'

describe('decideToolGate', () => {
  it('auto-approves read tools regardless of trust list', () => {
    const d = decideToolGate({
      toolName: 'vault_read_note',
      trustList: [],
      pendingDecision: null
    })
    expect(d).toEqual({ outcome: 'auto_approve' })
  })

  it('auto-approves create tools that are in the trust list', () => {
    const d = decideToolGate({
      toolName: 'vault_create_task',
      trustList: ['vault_create_task'],
      pendingDecision: null
    })
    expect(d).toEqual({ outcome: 'auto_approve' })
  })

  it('asks for approval on create tools not in trust list', () => {
    const d = decideToolGate({
      toolName: 'vault_create_task',
      trustList: [],
      pendingDecision: null
    })
    expect(d).toEqual({ outcome: 'await_user', requiresDiff: false })
  })

  it('always asks on update tools, regardless of trust list', () => {
    const d = decideToolGate({
      toolName: 'vault_update_note',
      trustList: ['vault_update_note', 'vault_add_tag'],
      pendingDecision: null
    })
    expect(d).toEqual({ outcome: 'await_user', requiresDiff: true })
  })

  it('emits requiresDiff=true for vault_update_note specifically', () => {
    const d = decideToolGate({
      toolName: 'vault_update_note',
      trustList: [],
      pendingDecision: null
    })
    expect(d).toMatchObject({ requiresDiff: true })
  })

  it('forwards an existing decision without re-asking', () => {
    const d = decideToolGate({
      toolName: 'vault_create_task',
      trustList: [],
      pendingDecision: { kind: 'allow' }
    })
    expect(d).toEqual({ outcome: 'apply_decision', decision: { kind: 'allow' } })
  })
})
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/runtime/__tests__/permission-gate.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/agent/runtime/permission-gate.ts
import type { ApproveToolDecision } from '@memry/contracts/ipc-agent'
import {
  CREATE_TOOL_NAMES,
  READ_TOOL_NAMES,
  UPDATE_TOOL_NAMES,
  type ToolName
} from '../../mcp/tools/schemas'

export interface GateInput {
  toolName: string
  trustList: string[]
  pendingDecision: ApproveToolDecision | null
}

export type GateDecision =
  | { outcome: 'auto_approve' }
  | { outcome: 'await_user'; requiresDiff: boolean }
  | { outcome: 'apply_decision'; decision: ApproveToolDecision }

export function decideToolGate(input: GateInput): GateDecision {
  if (input.pendingDecision) {
    return { outcome: 'apply_decision', decision: input.pendingDecision }
  }
  if ((READ_TOOL_NAMES as string[]).includes(input.toolName)) {
    return { outcome: 'auto_approve' }
  }
  if ((CREATE_TOOL_NAMES as string[]).includes(input.toolName)) {
    if (input.trustList.includes(input.toolName)) return { outcome: 'auto_approve' }
    return { outcome: 'await_user', requiresDiff: false }
  }
  if ((UPDATE_TOOL_NAMES as string[]).includes(input.toolName)) {
    return { outcome: 'await_user', requiresDiff: input.toolName === 'vault_update_note' }
  }
  // Unknown tool — deny by going through approval (defensive default).
  return { outcome: 'await_user', requiresDiff: false }
}

export type { ToolName }
```

- [ ] **Step 4: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/runtime/__tests__/permission-gate.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/runtime/permission-gate.ts apps/desktop/src/main/agent/runtime/__tests__/permission-gate.test.ts
git commit -m "feat(agent-runtime): pure permission-gate decision function"
```

---

## Task 8: Event bus

**Files:**

- Create: `apps/desktop/src/main/agent/runtime/event-bus.ts`

- [ ] **Step 1: Implement**

```ts
// apps/desktop/src/main/agent/runtime/event-bus.ts
import { BrowserWindow } from 'electron'

import { AgentChannels, type AgentEvent } from '@memry/contracts/ipc-agent'

export function broadcastAgentEvent(event: AgentEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(AgentChannels.events.AGENT_EVENT, event)
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/main/agent/runtime/event-bus.ts
git commit -m "feat(agent-runtime): typed event broadcast helper"
```

---

## Task 9: AgentRuntime + turn orchestrator

The runtime is the connective tissue. It owns: per-conversation pending-approval map, single-writer turn lock per conversation, write-tool gate adapter for the Vault MCP server, and the per-turn orchestration loop.

**Files:**

- Create: `apps/desktop/src/main/agent/runtime/runtime.ts`
- Create: `apps/desktop/src/main/agent/runtime/turn.ts`
- Create: `apps/desktop/src/main/agent/runtime/__tests__/turn.test.ts`

- [ ] **Step 1: Implement turn module**

```ts
// apps/desktop/src/main/agent/runtime/turn.ts
import { randomUUID } from 'node:crypto'

import { createLogger } from '../../lib/logger'
import { createStreamParser } from '../cli/stream-parser'
import type { BackendEvent } from '../cli/types'
import type { ConversationStore } from '../storage/conversation-store'
import type { MessageStore } from '../storage/message-store'
import type { Message, MessageAttachment } from '../storage/types'
import { broadcastAgentEvent } from './event-bus'
import { assemblePrompt } from './prompt-assembler'

const logger = createLogger('AgentRuntime:Turn')

export interface TurnDeps {
  conversations: ConversationStore
  messages: MessageStore
  spawnSubprocess: (input: {
    prompt: string
    conversationId: string
    windowId: string
  }) => Promise<{
    stdout: AsyncIterable<Buffer>
    stderr: AsyncIterable<Buffer>
    pid: number
    kill: () => void
    waitExit: () => Promise<number>
    cleanup: () => Promise<void>
  }>
  toolHandlers: {
    routeToolCall: (input: {
      conversationId: string
      windowId: string
      toolUseId: string
      name: string
      args: unknown
    }) => Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>
  }
}

export interface RunTurnInput {
  conversationId: string
  sourceWindowId: string
  text: string
  attachments: MessageAttachment[]
}

export async function runTurn(deps: TurnDeps, input: RunTurnInput): Promise<{ turnId: string }> {
  const turnId = randomUUID()

  // 1. Persist the user message immediately as terminal.
  await deps.messages.append({
    conversationId: input.conversationId,
    role: 'user',
    content: { role: 'user', data: { text: input.text } },
    attachments: input.attachments,
    status: 'completed'
  })

  // 2. Build prompt from history + new message.
  const history = await deps.messages.listByConversation(input.conversationId)
  // Drop the just-inserted user message — we re-attach it as the explicit "user" turn.
  const prior = history.filter((m) => m.content !== undefined)
  const prompt = assemblePrompt({
    history: prior.slice(0, -1),
    userMessage: input.text,
    attachments: input.attachments
  })

  // 3. Spawn subprocess.
  const sub = await deps.spawnSubprocess({
    prompt,
    conversationId: input.conversationId,
    windowId: input.sourceWindowId
  })

  // 4. Create assistant placeholder message in 'streaming' state.
  const assistant = await deps.messages.append({
    conversationId: input.conversationId,
    role: 'assistant',
    content: { role: 'assistant', data: { text: '' } },
    attachments: [],
    status: 'streaming'
  })

  let buffered = ''
  const parser = createStreamParser(async (event) => {
    await handleBackendEvent(deps, event, {
      conversationId: input.conversationId,
      windowId: input.sourceWindowId,
      assistantMessageId: assistant.id,
      onAssistantText: (text) => {
        buffered += text
      }
    })
  })

  for await (const chunk of sub.stdout) parser.feed(chunk.toString('utf8'))
  parser.flush()

  // 5. Finalize assistant message.
  await deps.messages.markTerminal(assistant.id, 'completed', {
    content: { role: 'assistant', data: { text: buffered } }
  })

  await sub.cleanup()

  broadcastAgentEvent({
    kind: 'turn_completed',
    conversationId: input.conversationId,
    turnId
  })

  return { turnId }
}

async function handleBackendEvent(
  deps: TurnDeps,
  event: BackendEvent,
  ctx: {
    conversationId: string
    windowId: string
    assistantMessageId: string
    onAssistantText: (text: string) => void
  }
): Promise<void> {
  if (event.kind === 'assistant_delta') {
    ctx.onAssistantText(event.text)
    broadcastAgentEvent({
      kind: 'assistant_text_delta',
      conversationId: ctx.conversationId,
      messageId: ctx.assistantMessageId,
      text: event.text
    })
    return
  }
  if (event.kind === 'tool_use') {
    broadcastAgentEvent({
      kind: 'tool_call_started',
      conversationId: ctx.conversationId,
      toolCallId: event.toolUseId,
      name: event.name,
      args: event.args
    })
    const result = await deps.toolHandlers.routeToolCall({
      conversationId: ctx.conversationId,
      windowId: ctx.windowId,
      toolUseId: event.toolUseId,
      name: event.name,
      args: event.args
    })
    if (result.ok) {
      broadcastAgentEvent({
        kind: 'tool_call_completed',
        conversationId: ctx.conversationId,
        toolCallId: event.toolUseId,
        result: result.data
      })
    } else {
      broadcastAgentEvent({
        kind: 'tool_call_failed',
        conversationId: ctx.conversationId,
        toolCallId: event.toolUseId,
        error: result.error ?? { code: 'INTERNAL', message: 'unknown' }
      })
    }
    return
  }
  if (event.kind === 'message_stop') return
  if (event.kind === 'unknown') logger.debug('Unknown backend event', event.raw)
}
```

> **Note:** the runtime depends on `routeToolCall` for write-tool approval. The actual approval flow is connected through the `AgentRuntime` class in the next step — it suspends the turn while waiting for user approval, then resumes by feeding the tool result back into the parser path. For P3 v1, the simpler approach is: when the tool gate decides `await_user`, the runtime **does not** call the underlying MCP write tool; instead it broadcasts `tool_call_pending_approval` and waits for the renderer's `agent:approveTool` IPC. Once the user decides, the runtime executes (or denies) the tool and broadcasts `tool_call_completed` / `tool_call_failed`. Because this turn is run inside the subprocess (not on a separate channel), the gate must operate at the MCP boundary. The cleanest expression: AgentRuntime registers itself as the **write-tool gate** in the P1 lifecycle, and that gate is what blocks pending `await_user` decisions. See Task 11.

- [ ] **Step 2: Implement runtime**

```ts
// apps/desktop/src/main/agent/runtime/runtime.ts
import { createLogger } from '../../lib/logger'
import { setWriteGate as setMcpWriteGate } from '../mcp/lifecycle'
import type { ConversationStore } from '../storage/conversation-store'
import type { MessageStore } from '../storage/message-store'
import type { ApproveToolDecision } from '@memry/contracts/ipc-agent'
import { decideToolGate } from './permission-gate'
import { broadcastAgentEvent } from './event-bus'

const logger = createLogger('AgentRuntime')

interface PendingApproval {
  resolve: (decision: ApproveToolDecision) => void
}

interface SpawnDeps {
  spawn: (input: { prompt: string; conversationId: string; windowId: string }) => Promise<{
    stdout: AsyncIterable<Buffer>
    stderr: AsyncIterable<Buffer>
    pid: number
    kill: () => void
    waitExit: () => Promise<number>
    cleanup: () => Promise<void>
  }>
}

export interface AgentRuntimeDeps {
  conversations: ConversationStore
  messages: MessageStore
  spawn: SpawnDeps['spawn']
}

export class AgentRuntime {
  private inFlight = new Map<string, AbortController>() // conversationId → controller
  private pending = new Map<string, PendingApproval>() // toolCallId → resolver
  private subprocesses = new Set<{ pid: number; kill: () => void }>()

  constructor(private deps: AgentRuntimeDeps) {}

  install(): void {
    setMcpWriteGate(async (ctx) => {
      const conv = await this.deps.conversations.getById(ctx.conversationId)
      if (!conv) return { approved: false, reason: 'Unknown conversation' }
      const decision = decideToolGate({
        toolName: ctx.toolName,
        trustList: conv.trustList,
        pendingDecision: null
      })
      if (decision.outcome === 'auto_approve') {
        return { approved: true }
      }
      // await_user: broadcast and wait
      const toolCallId = `gate-${Date.now()}-${Math.random().toString(36).slice(2)}`
      broadcastAgentEvent({
        kind: 'tool_call_pending_approval',
        conversationId: ctx.conversationId,
        toolCallId,
        name: ctx.toolName,
        args: ctx.parsedArgs,
        requiresDiff: decision.outcome === 'await_user' ? decision.requiresDiff : false
      })
      const userDecision = await this.waitForApproval(toolCallId)
      if (userDecision.kind === 'deny') {
        return { approved: false, reason: 'User denied request.' }
      }
      if (userDecision.kind === 'allow_always') {
        await this.deps.conversations.addToTrustList(ctx.conversationId, ctx.toolName)
      }
      const args = userDecision.kind === 'edit_allow' ? userDecision.editedArgs : ctx.parsedArgs
      return { approved: true, args }
    })
  }

  resolveApproval(toolCallId: string, decision: ApproveToolDecision): void {
    const p = this.pending.get(toolCallId)
    if (!p) {
      logger.warn(`Stale approval for ${toolCallId}`)
      return
    }
    p.resolve(decision)
    this.pending.delete(toolCallId)
  }

  async killAll(): Promise<void> {
    for (const sub of this.subprocesses) {
      try {
        sub.kill()
      } catch (err) {
        logger.warn('Failed to kill subprocess', err)
      }
    }
    this.subprocesses.clear()
    for (const ctrl of this.inFlight.values()) ctrl.abort()
    this.inFlight.clear()
  }

  cancelTurn(conversationId: string): void {
    const ctrl = this.inFlight.get(conversationId)
    ctrl?.abort()
  }

  private waitForApproval(toolCallId: string): Promise<ApproveToolDecision> {
    return new Promise((resolve) => {
      this.pending.set(toolCallId, { resolve })
    })
  }
}
```

- [ ] **Step 3: Write a turn integration test against a stub backend**

```ts
// apps/desktop/src/main/agent/runtime/__tests__/turn.test.ts
import { describe, it, expect, beforeAll, vi } from 'vitest'
import sodium from 'libsodium-wrappers'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'
import { createConversationStore } from '../../storage/conversation-store'
import { createMessageStore } from '../../storage/message-store'
import { runTurn } from '../turn'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE agent_conversations (
      id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, title_ciphertext TEXT NOT NULL,
      backend TEXT NOT NULL, trust_list TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0,
      vector_clock TEXT NOT NULL, field_clocks TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      deleted_at INTEGER, last_synced_at INTEGER
    );
    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      content_ciphertext TEXT NOT NULL, attachments_ciphertext TEXT NOT NULL,
      tool_call_id TEXT, status TEXT NOT NULL, vector_clock TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
    );
  `)
  return drizzle(sqlite, { schema })
}

describe('runTurn against a stub backend', () => {
  let vaultKey: Uint8Array
  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  it('persists user + assistant messages and broadcasts events', async () => {
    const db = freshDb()
    const conversations = createConversationStore({ db, vaultKey, deviceId: 'd1' })
    const messages = createMessageStore({ db, vaultKey, deviceId: 'd1' })
    const conv = await conversations.create({
      vaultId: 'v',
      title: 'X',
      backend: 'claude_cli'
    })

    const stubStdout = (async function* () {
      yield Buffer.from(
        JSON.stringify({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hello ' }
        }) + '\n'
      )
      yield Buffer.from(
        JSON.stringify({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'world' }
        }) + '\n'
      )
      yield Buffer.from(JSON.stringify({ type: 'message_stop' }) + '\n')
    })()
    const stubStderr = (async function* () {})()

    const spawn = vi.fn(async () => ({
      stdout: stubStdout,
      stderr: stubStderr,
      pid: 1,
      kill: () => {},
      waitExit: async () => 0,
      cleanup: async () => {}
    }))

    await runTurn(
      {
        conversations,
        messages,
        spawnSubprocess: spawn,
        toolHandlers: { routeToolCall: vi.fn() }
      },
      {
        conversationId: conv.id,
        sourceWindowId: 'w1',
        text: 'hi',
        attachments: []
      }
    )

    const all = await messages.listByConversation(conv.id)
    expect(all).toHaveLength(2)
    expect(all[0].role).toBe('user')
    expect(all[1].role).toBe('assistant')
    if (all[1].content.role === 'assistant') {
      expect(all[1].content.data.text).toBe('Hello world')
    }
    expect(all[1].status).toBe('completed')
  })
})
```

- [ ] **Step 4: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/runtime/__tests__/turn.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/runtime/turn.ts apps/desktop/src/main/agent/runtime/runtime.ts apps/desktop/src/main/agent/runtime/__tests__/turn.test.ts
git commit -m "feat(agent-runtime): turn orchestrator + AgentRuntime with mcp gate adapter"
```

---

## Task 10: IPC handlers — `agent:*`

**Files:**

- Create: `apps/desktop/src/main/ipc/agent-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/index.ts`

- [ ] **Step 1: Implement**

```ts
// apps/desktop/src/main/ipc/agent-handlers.ts
import { ipcMain } from 'electron'

import {
  AgentChannels,
  AttachmentInputSchema,
  ApproveToolRequestSchema,
  SendTurnRequestSchema,
  type AttachmentInput
} from '@memry/contracts/ipc-agent'
import { detectClaudeBinary } from '../agent/cli/claude-binary'
import { AgentRuntime } from '../agent/runtime/runtime'
import type { ConversationStore } from '../agent/storage/conversation-store'
import type { MessageStore } from '../agent/storage/message-store'
import type { MessageAttachment } from '../agent/storage/types'
import { runTurn } from '../agent/runtime/turn'
import { getDisclosureState, acceptDisclosure } from '../agent/runtime/disclosure-state'
import { snapshotAttachments } from '../agent/runtime/attachment-snapshotter'

interface Deps {
  runtime: AgentRuntime
  conversations: ConversationStore
  messages: MessageStore
  spawn: Parameters<typeof runTurn>[0]['spawnSubprocess']
  routeToolCall: Parameters<typeof runTurn>[0]['toolHandlers']['routeToolCall']
  vaultId: string
}

export function registerAgentHandlers(deps: Deps): void {
  ipcMain.handle(AgentChannels.invoke.LIST_CONVERSATIONS, async (_e, payload) => {
    const { vaultId } = payload as { vaultId: string }
    return deps.conversations.listByVault(vaultId)
  })

  ipcMain.handle(AgentChannels.invoke.CREATE_CONVERSATION, async (_e, payload) => {
    const { vaultId, backend } = payload as { vaultId: string; backend?: string }
    return deps.conversations.create({
      vaultId,
      title: 'New conversation',
      backend: backend ?? 'claude_cli'
    })
  })

  ipcMain.handle(AgentChannels.invoke.LOAD_CONVERSATION, async (_e, payload) => {
    const { id } = payload as { id: string }
    const conversation = await deps.conversations.getById(id)
    const messages = await deps.messages.listByConversation(id)
    return { conversation, messages }
  })

  ipcMain.handle(AgentChannels.invoke.SEND_TURN, async (_e, payload) => {
    const req = SendTurnRequestSchema.parse(payload)
    const fullAttachments = await snapshotAttachments(req.attachments as AttachmentInput[])
    void runTurn(
      {
        conversations: deps.conversations,
        messages: deps.messages,
        spawnSubprocess: deps.spawn,
        toolHandlers: { routeToolCall: deps.routeToolCall }
      },
      {
        conversationId: req.conversationId,
        sourceWindowId: req.sourceWindowId,
        text: req.text,
        attachments: fullAttachments
      }
    )
    return { ok: true }
  })

  ipcMain.handle(AgentChannels.invoke.CANCEL_TURN, async (_e, payload) => {
    const { conversationId } = payload as { conversationId: string }
    deps.runtime.cancelTurn(conversationId)
    return { ok: true }
  })

  ipcMain.handle(AgentChannels.invoke.APPROVE_TOOL, async (_e, payload) => {
    const req = ApproveToolRequestSchema.parse(payload)
    deps.runtime.resolveApproval(req.toolCallId, req.decision)
    return { ok: true }
  })

  ipcMain.handle(AgentChannels.invoke.EDIT_TRUST_LIST, async (_e, payload) => {
    const { conversationId, add, remove } = payload as {
      conversationId: string
      add?: string[]
      remove?: string[]
    }
    for (const t of add ?? []) await deps.conversations.addToTrustList(conversationId, t)
    for (const t of remove ?? []) await deps.conversations.removeFromTrustList(conversationId, t)
    return deps.conversations.getById(conversationId)
  })

  ipcMain.handle(AgentChannels.invoke.GET_BINARY_STATUS, () => detectClaudeBinary())

  ipcMain.handle(AgentChannels.invoke.GET_DISCLOSURE_STATE, () => getDisclosureState())
  ipcMain.handle(AgentChannels.invoke.ACCEPT_DISCLOSURE, () => acceptDisclosure())
}
```

> **Note:** `disclosure-state.ts` (small persistence shim around an existing settings table — store a single boolean key like `agent.disclosureAccepted`) and `attachment-snapshotter.ts` (uses Vault MCP service handles to materialize current-note / note / journal markdown into the attachment snapshot at send-time, capped at 30k chars) are tiny utilities. Add them as supporting modules in this same task with their own simple unit tests.

- [ ] **Step 2: Register in IPC index**

Add to `apps/desktop/src/main/ipc/index.ts`:

```ts
import { registerAgentHandlers } from './agent-handlers'
// ...inside the bootstrap function, after services are constructed:
registerAgentHandlers({
  runtime,
  conversations,
  messages,
  spawn: spawnAdapter,
  routeToolCall: toolRouter,
  vaultId
})
```

The `runtime`, `conversations`, `messages`, `spawnAdapter`, `toolRouter`, `vaultId` come from a new bootstrap module — see Task 12 for the wiring.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/ipc/agent-handlers.ts apps/desktop/src/main/ipc/index.ts \
  apps/desktop/src/main/agent/runtime/disclosure-state.ts apps/desktop/src/main/agent/runtime/attachment-snapshotter.ts
git commit -m "feat(agent-ipc): wire agent:* IPC handlers"
```

---

## Task 11: Bootstrap — wire stores, runtime, MCP gate, IPC

**Files:**

- Create: `apps/desktop/src/main/agent/bootstrap.ts`
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Write bootstrap**

```ts
// apps/desktop/src/main/agent/bootstrap.ts
import { createLogger } from '../lib/logger'
import { getDatabase } from '../database'
import { detectClaudeBinary } from './cli/claude-binary'
import { spawnClaudeTurn } from './cli/spawn'
import { getOrCreateVaultUuid } from './storage/vault-id'
import { createConversationStore } from './storage/conversation-store'
import { createMessageStore } from './storage/message-store'
import { AgentRuntime } from './runtime/runtime'
import { registerAgentHandlers } from '../ipc/agent-handlers'
import { getPublicStatus } from './mcp/lifecycle'
import { getVaultKey } from '../crypto/vault-key' // existing helper

const logger = createLogger('AgentBootstrap')

export async function startAgent(): Promise<{ shutdown: () => Promise<void> }> {
  const dataDb = getDatabase()
  const vaultKey = await getVaultKey()
  const deviceId = process.env.MEMRY_DEVICE_ID ?? 'desktop' // existing helper if available

  const vaultId = await getOrCreateVaultUuid(dataDb)
  const conversations = createConversationStore({ db: dataDb, vaultKey, deviceId })
  const messages = createMessageStore({ db: dataDb, vaultKey, deviceId })

  const runtime = new AgentRuntime({ conversations, messages, spawn: dummySpawn })
  runtime.install() // wires the write-tool gate into MCP lifecycle

  const spawnAdapter: Parameters<typeof registerAgentHandlers>[0]['spawn'] = async ({
    prompt,
    conversationId,
    windowId
  }) => {
    const status = getPublicStatus()
    const binary = await detectClaudeBinary()
    if (!binary.detected || !binary.meetsMinimum) {
      throw new Error(binary.installHint ?? 'Claude CLI unavailable')
    }
    if (!status.url || !status.token) {
      throw new Error('Agent MCP server not running')
    }
    const sub = await spawnClaudeTurn({
      binaryPath: 'claude', // resolved via PATH; can be replaced with detected path
      mcpServerUrl: status.url,
      bearerToken: status.token,
      conversationId,
      windowId,
      allowedTools:
        'mcp__memry__vault_search_notes,mcp__memry__vault_read_note,mcp__memry__vault_list_folder,mcp__memry__vault_get_current_note,mcp__memry__vault_list_tasks,mcp__memry__vault_list_projects,mcp__memry__vault_get_journal_entry,mcp__memry__vault_list_journal_entries,mcp__memry__vault_list_inbox_items,mcp__memry__vault_get_tags,mcp__memry__vault_create_note,mcp__memry__vault_create_task,mcp__memry__vault_create_journal_entry,mcp__memry__vault_add_to_inbox,mcp__memry__vault_update_note,mcp__memry__vault_update_task,mcp__memry__vault_add_tag,mcp__memry__vault_remove_tag,mcp__memry__vault_move_to_folder',
      prompt
    })
    return {
      stdout: sub.proc.stdout!,
      stderr: sub.proc.stderr!,
      pid: sub.pid,
      kill: () => sub.proc.kill('SIGTERM'),
      waitExit: () =>
        new Promise<number>((resolve) => sub.proc.once('exit', (code) => resolve(code ?? 0))),
      cleanup: sub.cleanup
    }
  }

  // Tool routing for read tools is delegated entirely to the MCP server (Claude calls it directly).
  // The runtime's routeToolCall is a no-op fallback for events the parser surfaces — the gate
  // already wraps writes. We still need this for streaming UI updates: it's a dummy success since
  // the real tool result has already been delivered via the MCP transport on a separate channel.
  const routeToolCall: Parameters<typeof registerAgentHandlers>[0]['routeToolCall'] = async () => ({
    ok: true,
    data: null
  })

  registerAgentHandlers({
    runtime,
    conversations,
    messages,
    spawn: spawnAdapter,
    routeToolCall,
    vaultId
  })

  logger.info(`Agent runtime ready (vaultId=${vaultId})`)

  return {
    shutdown: async () => {
      await runtime.killAll()
    }
  }
}

const dummySpawn = (() => {
  throw new Error('AgentRuntime spawn unset; bootstrap should replace before turns run')
}) as never as Parameters<typeof AgentRuntime>[0]['spawn']
```

- [ ] **Step 2: Wire into main entrypoint**

Edit `apps/desktop/src/main/index.ts`:

```ts
import { startAgent } from './agent/bootstrap'

// ...after MCP server starts:
const agent = await startAgent()

// In before-quit:
app.on('before-quit', async (event) => {
  // ...existing teardown
  await agent.shutdown()
})
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/agent/bootstrap.ts apps/desktop/src/main/index.ts
git commit -m "feat(agent-runtime): bootstrap wiring for stores + runtime + IPC"
```

---

## Task 12: Renderer agent context

**Files:**

- Create: `apps/desktop/src/renderer/src/agent-chat/agent-context.tsx`
- Create: `apps/desktop/src/renderer/src/agent-chat/__tests__/agent-context.test.tsx`

- [ ] **Step 1: Implement context with reducer**

```tsx
// apps/desktop/src/renderer/src/agent-chat/agent-context.tsx
import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react'

import type { AgentEvent, BinaryStatus } from '@memry/contracts/ipc-agent'

interface AgentState {
  binaryStatus: BinaryStatus | null
  disclosureAccepted: boolean | null
  activeConversationId: string | null
  pendingApprovals: Array<{
    toolCallId: string
    name: string
    args: unknown
    requiresDiff: boolean
    conversationId: string
  }>
  streamingTextByMessage: Record<string, string>
  inFlight: Record<string, boolean>
}

type Action =
  | { type: 'set_binary_status'; status: BinaryStatus }
  | { type: 'set_disclosure'; accepted: boolean }
  | { type: 'set_active_conversation'; id: string | null }
  | { type: 'event'; event: AgentEvent }
  | { type: 'clear_pending'; toolCallId: string }

const initial: AgentState = {
  binaryStatus: null,
  disclosureAccepted: null,
  activeConversationId: null,
  pendingApprovals: [],
  streamingTextByMessage: {},
  inFlight: {}
}

function reducer(state: AgentState, action: Action): AgentState {
  switch (action.type) {
    case 'set_binary_status':
      return { ...state, binaryStatus: action.status }
    case 'set_disclosure':
      return { ...state, disclosureAccepted: action.accepted }
    case 'set_active_conversation':
      return { ...state, activeConversationId: action.id }
    case 'clear_pending':
      return {
        ...state,
        pendingApprovals: state.pendingApprovals.filter((p) => p.toolCallId !== action.toolCallId)
      }
    case 'event': {
      const e = action.event
      if (e.kind === 'assistant_text_delta') {
        return {
          ...state,
          streamingTextByMessage: {
            ...state.streamingTextByMessage,
            [e.messageId]: (state.streamingTextByMessage[e.messageId] ?? '') + e.text
          }
        }
      }
      if (e.kind === 'tool_call_pending_approval') {
        return {
          ...state,
          pendingApprovals: [
            ...state.pendingApprovals,
            {
              toolCallId: e.toolCallId,
              name: e.name,
              args: e.args,
              requiresDiff: e.requiresDiff,
              conversationId: e.conversationId
            }
          ]
        }
      }
      if (e.kind === 'turn_completed' || e.kind === 'turn_cancelled' || e.kind === 'turn_error') {
        return { ...state, inFlight: { ...state.inFlight, [e.conversationId]: false } }
      }
      return state
    }
    default:
      return state
  }
}

interface AgentContextValue {
  state: AgentState
  dispatch: (a: Action) => void
}

const Ctx = createContext<AgentContextValue | null>(null)

export function AgentProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initial)

  useEffect(() => {
    void window.api.agent
      .getBinaryStatus()
      .then((s) => dispatch({ type: 'set_binary_status', status: s }))
    void window.api.agent
      .getDisclosureState()
      .then((s) => dispatch({ type: 'set_disclosure', accepted: s.accepted }))
    const off = window.api.agent.onEvent((evt) => dispatch({ type: 'event', event: evt }))
    return () => {
      off()
    }
  }, [])

  const value = useMemo(() => ({ state, dispatch }), [state])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAgent(): AgentContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAgent must be used inside <AgentProvider>')
  return v
}
```

- [ ] **Step 2: Add a reducer-only test**

```tsx
// apps/desktop/src/renderer/src/agent-chat/__tests__/agent-context.test.tsx
import { describe, it, expect } from 'vitest'

// Re-export reducer for testing — small refactor of agent-context.tsx splits the reducer + initial
// state into agent-context.reducer.ts; the test imports from there.
import { reducer, initial } from '../agent-context.reducer'

describe('Agent context reducer', () => {
  it('appends streaming text deltas', () => {
    const state = reducer(initial, {
      type: 'event',
      event: {
        kind: 'assistant_text_delta',
        conversationId: 'c',
        messageId: 'm',
        text: 'hi '
      }
    })
    const next = reducer(state, {
      type: 'event',
      event: {
        kind: 'assistant_text_delta',
        conversationId: 'c',
        messageId: 'm',
        text: 'there'
      }
    })
    expect(next.streamingTextByMessage.m).toBe('hi there')
  })

  it('queues pending approvals in arrival order', () => {
    let s = reducer(initial, {
      type: 'event',
      event: {
        kind: 'tool_call_pending_approval',
        conversationId: 'c',
        toolCallId: 't1',
        name: 'vault_create_task',
        args: {},
        requiresDiff: false
      }
    })
    s = reducer(s, {
      type: 'event',
      event: {
        kind: 'tool_call_pending_approval',
        conversationId: 'c',
        toolCallId: 't2',
        name: 'vault_update_note',
        args: {},
        requiresDiff: true
      }
    })
    expect(s.pendingApprovals.map((p) => p.toolCallId)).toEqual(['t1', 't2'])
  })

  it('clears a pending approval when resolved', () => {
    const s = reducer(
      {
        ...initial,
        pendingApprovals: [
          { toolCallId: 't1', name: 'x', args: {}, requiresDiff: false, conversationId: 'c' }
        ]
      },
      { type: 'clear_pending', toolCallId: 't1' }
    )
    expect(s.pendingApprovals).toEqual([])
  })
})
```

> **Note:** split the reducer + initial state into a separate file `agent-context.reducer.ts` and re-export from `agent-context.tsx` so the unit test can import without React.

- [ ] **Step 3: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/renderer/src/agent-chat/__tests__/agent-context.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/agent-chat/agent-context.tsx apps/desktop/src/renderer/src/agent-chat/agent-context.reducer.ts apps/desktop/src/renderer/src/agent-chat/__tests__/agent-context.test.tsx
git commit -m "feat(agent-chat): renderer agent state context with reducer"
```

---

## Task 13: Right-sidebar tabbed header (Day | Agent)

**Files:**

- Create: `apps/desktop/src/renderer/src/agent-chat/sidebar-tabs.tsx`
- Modify: `apps/desktop/src/renderer/src/components/day-panel/global-day-panel.tsx`

- [ ] **Step 1: Implement segmented control**

```tsx
// apps/desktop/src/renderer/src/agent-chat/sidebar-tabs.tsx
import { type ReactNode, useState } from 'react'

import { useAgent } from './agent-context'

export type RightSidebarTab = 'day' | 'agent'

interface Props {
  children: { day: ReactNode; agent: ReactNode }
  defaultTab?: RightSidebarTab
}

export function SidebarTabs({ children, defaultTab = 'day' }: Props): JSX.Element {
  const [active, setActive] = useState<RightSidebarTab>(defaultTab)
  const {
    state: { pendingApprovals, streamingTextByMessage }
  } = useAgent()
  const hasBackgroundActivity =
    active !== 'agent' &&
    (pendingApprovals.length > 0 || Object.values(streamingTextByMessage).some(Boolean))

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border ps-2 pe-2 py-1">
        <Tab active={active === 'day'} onClick={() => setActive('day')}>
          Day
        </Tab>
        <Tab active={active === 'agent'} onClick={() => setActive('agent')}>
          Agent
          {hasBackgroundActivity && (
            <span
              className="ms-1 inline-block h-1.5 w-1.5 rounded-full bg-primary"
              aria-label={
                pendingApprovals.length > 0
                  ? `${pendingApprovals.length} pending approval`
                  : 'streaming'
              }
            />
          )}
        </Tab>
      </div>
      <div className="flex-1 overflow-hidden">
        {active === 'day' ? children.day : children.agent}
      </div>
    </div>
  )
}

function Tab({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-2 py-1 text-sm transition-colors ${
        active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50'
      }`}
    >
      {children}
    </button>
  )
}
```

- [ ] **Step 2: Integrate into Day panel container**

Edit `apps/desktop/src/renderer/src/components/day-panel/global-day-panel.tsx`. Replace the rendered content (currently the Day pane) with `<SidebarTabs>{{ day: <existing day pane>, agent: <AgentPane /> }}</SidebarTabs>`. Persist the chosen tab to `localStorage` keyed `right-sidebar-tab`.

- [ ] **Step 3: Manual sanity check**

Run `pnpm dev`, observe both tabs render and switch.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/agent-chat/sidebar-tabs.tsx apps/desktop/src/renderer/src/components/day-panel/global-day-panel.tsx
git commit -m "feat(agent-chat): right-sidebar Day | Agent tabbed header"
```

---

## Task 14: AgentPane root + enablement screen

**Files:**

- Create: `apps/desktop/src/renderer/src/agent-chat/agent-pane.tsx`
- Create: `apps/desktop/src/renderer/src/agent-chat/enablement.tsx`
- Create: `apps/desktop/src/renderer/src/agent-chat/empty-state.tsx`

- [ ] **Step 1: Implement enablement**

```tsx
// apps/desktop/src/renderer/src/agent-chat/enablement.tsx
import { Button } from '@/components/ui/button'

interface Props {
  onAccept: () => void
}

export function Enablement({ onAccept }: Props): JSX.Element {
  return (
    <div className="flex h-full flex-col items-start gap-4 p-6">
      <h2 className="text-lg font-medium">Enable Memry Agent</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Memry Agent uses your local Claude CLI subscription to chat about your vault. Each turn
        sends your message, attached references, prior conversation context, and tool results to
        Anthropic under your Claude account. Memry encrypts your local and synced chat history, but
        cannot make remote model inference local or zero-knowledge. You can revoke access at any
        time by signing out of <code>claude</code>.
      </p>
      <ul className="list-disc text-sm text-muted-foreground ps-5 space-y-1">
        <li>Read tools (search, read, list) run automatically.</li>
        <li>Create/update tools require your explicit approval.</li>
        <li>Update tools always show a diff or before/after preview.</li>
      </ul>
      <Button onClick={onAccept}>Enable Claude CLI chat</Button>
    </div>
  )
}
```

- [ ] **Step 2: Implement empty state**

```tsx
// apps/desktop/src/renderer/src/agent-chat/empty-state.tsx
import type { BinaryStatus } from '@memry/contracts/ipc-agent'

interface Props {
  binaryStatus: BinaryStatus | null
  onCreateConversation: () => void
}

export function EmptyState({ binaryStatus, onCreateConversation }: Props): JSX.Element {
  return (
    <div className="flex h-full flex-col items-start gap-3 p-6">
      <h2 className="text-base font-medium">Start chatting with your vault</h2>
      <BinaryLine status={binaryStatus} />
      <button
        className="mt-4 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
        onClick={onCreateConversation}
        disabled={!binaryStatus?.detected || !binaryStatus.meetsMinimum}
      >
        New conversation
      </button>
    </div>
  )
}

function BinaryLine({ status }: { status: BinaryStatus | null }): JSX.Element {
  if (!status) return <span className="text-sm text-muted-foreground">Checking Claude CLI…</span>
  if (!status.detected)
    return (
      <span className="text-sm text-amber-700">
        <code>claude</code> not found. {status.installHint}
      </span>
    )
  if (!status.meetsMinimum)
    return (
      <span className="text-sm text-amber-700">
        <code>claude</code> {status.version} too old; need {status.minimumRequired}.{' '}
        {status.installHint}
      </span>
    )
  return (
    <span className="text-sm text-emerald-700">
      <code>claude</code> {status.version} detected and ready.
    </span>
  )
}
```

- [ ] **Step 3: Implement pane root**

```tsx
// apps/desktop/src/renderer/src/agent-chat/agent-pane.tsx
import { useState } from 'react'

import { useAgent } from './agent-context'
import { Enablement } from './enablement'
import { EmptyState } from './empty-state'
import { ConversationView } from './conversation-view'

export function AgentPane(): JSX.Element {
  const { state, dispatch } = useAgent()
  const [creating, setCreating] = useState(false)

  if (state.disclosureAccepted === null || state.binaryStatus === null) {
    return <div className="p-4 text-sm text-muted-foreground">Loading…</div>
  }
  if (!state.disclosureAccepted) {
    return (
      <Enablement
        onAccept={async () => {
          await window.api.agent.acceptDisclosure()
          dispatch({ type: 'set_disclosure', accepted: true })
        }}
      />
    )
  }
  if (!state.activeConversationId) {
    return (
      <EmptyState
        binaryStatus={state.binaryStatus}
        onCreateConversation={async () => {
          setCreating(true)
          const conv = await window.api.agent.createConversation({
            vaultId: 'current' // see note below
          })
          dispatch({ type: 'set_active_conversation', id: conv.id })
          setCreating(false)
        }}
      />
    )
  }
  return <ConversationView conversationId={state.activeConversationId} />
}
```

> **Note:** the `vaultId` for `createConversation` should come from a renderer-exposed accessor that mirrors the main-process `getOrCreateVaultUuid`. Add a tiny IPC channel `agent_mcp:get_vault_id` (or piggyback on `agentMcp.getStatus()`'s payload to include it). Whichever path the codebase prefers — keep the renderer un-aware of the concrete UUID logic.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/agent-chat/agent-pane.tsx apps/desktop/src/renderer/src/agent-chat/enablement.tsx apps/desktop/src/renderer/src/agent-chat/empty-state.tsx
git commit -m "feat(agent-chat): pane root + enablement + empty state"
```

---

## Task 15: Conversation list dropdown + header

**Files:**

- Create: `apps/desktop/src/renderer/src/agent-chat/conversation-header.tsx`
- Create: `apps/desktop/src/renderer/src/agent-chat/conversation-list.tsx`

- [ ] **Step 1: Implement**

```tsx
// apps/desktop/src/renderer/src/agent-chat/conversation-header.tsx
import { useEffect, useState } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'

import type { Conversation } from '../../../../main/agent/storage/types'
import { useAgent } from './agent-context'

interface Props {
  conversation: Conversation
  vaultId: string
}

export function ConversationHeader({ conversation, vaultId }: Props): JSX.Element {
  const { dispatch } = useAgent()
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<Conversation[]>([])

  useEffect(() => {
    if (!open) return
    void window.api.agent.listConversations({ vaultId }).then(setList)
  }, [open, vaultId])

  return (
    <header className="flex items-center justify-between border-b border-border ps-3 pe-3 py-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="text-base font-medium">
            {conversation.title} ▾
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-1">
          <div className="flex flex-col">
            <button
              className="rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent"
              onClick={async () => {
                const conv = await window.api.agent.createConversation({ vaultId })
                dispatch({ type: 'set_active_conversation', id: conv.id })
                setOpen(false)
              }}
            >
              + New conversation
            </button>
            <div className="my-1 border-t border-border" />
            {list.map((c) => (
              <button
                key={c.id}
                className="rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent"
                onClick={() => {
                  dispatch({ type: 'set_active_conversation', id: c.id })
                  setOpen(false)
                }}
              >
                {c.title}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </header>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/agent-chat/conversation-header.tsx
git commit -m "feat(agent-chat): conversation header with switcher dropdown"
```

---

## Task 16: Conversation view — message stream + composer

**Files:**

- Create: `apps/desktop/src/renderer/src/agent-chat/conversation-view.tsx`
- Create: `apps/desktop/src/renderer/src/agent-chat/message-stream.tsx`
- Create: `apps/desktop/src/renderer/src/agent-chat/messages/{user,assistant,tool-call,tool-result,system}-message.tsx`

- [ ] **Step 1: Implement message renderers**

Each message component takes a `Message` (re-exported from main types) and renders its kind. User messages use bubble styling with attachment chips. Assistant messages render markdown via either:

- a thin wrapper around BlockNote in `readOnly` mode (preferred — matches editor style), or
- the `react-markdown` library if BlockNote read-only is too heavy.

This task implements basic Tailwind-styled components. Code is lengthy but mechanical — each component is ~30-60 lines following the spec's "five message kinds" enumeration. **Implementer:** follow the spec section "Message stream" verbatim and use the project's existing `<Markdown>` component if you find one; otherwise install `react-markdown` (`pnpm --filter @memry/desktop add react-markdown remark-gfm`).

- [ ] **Step 2: Implement message-stream**

```tsx
// apps/desktop/src/renderer/src/agent-chat/message-stream.tsx
import { useEffect, useRef } from 'react'

import type { Message } from '../../../../main/agent/storage/types'
import { useAgent } from './agent-context'
import { UserMessage } from './messages/user-message'
import { AssistantMessage } from './messages/assistant-message'
import { ToolCallCard } from './messages/tool-call-card'
import { ToolResultCard } from './messages/tool-result-card'
import { SystemNote } from './messages/system-note'

interface Props {
  messages: Message[]
}

export function MessageStream({ messages }: Props): JSX.Element {
  const { state } = useAgent()
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [messages.length, state.streamingTextByMessage])

  return (
    <div ref={ref} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
      {messages.map((m) => {
        if (m.role === 'user') return <UserMessage key={m.id} message={m} />
        if (m.role === 'assistant') {
          const liveText = state.streamingTextByMessage[m.id]
          return <AssistantMessage key={m.id} message={m} liveText={liveText} />
        }
        if (m.role === 'tool_call') return <ToolCallCard key={m.id} message={m} />
        if (m.role === 'tool_result') return <ToolResultCard key={m.id} message={m} />
        if (m.role === 'system') return <SystemNote key={m.id} message={m} />
        return null
      })}
    </div>
  )
}
```

- [ ] **Step 3: Implement conversation-view glue**

```tsx
// apps/desktop/src/renderer/src/agent-chat/conversation-view.tsx
import { useEffect, useState } from 'react'

import type { Message } from '../../../../main/agent/storage/types'
import { ConversationHeader } from './conversation-header'
import { MessageStream } from './message-stream'
import { Composer } from './composer'

interface Props {
  conversationId: string
}

export function ConversationView({ conversationId }: Props): JSX.Element {
  const [conversation, setConversation] = useState<Awaited<
    ReturnType<typeof window.api.agent.loadConversation>
  > | null>(null)
  const [messages, setMessages] = useState<Message[]>([])

  useEffect(() => {
    void window.api.agent.loadConversation({ id: conversationId }).then((res) => {
      setConversation(res)
      setMessages(res.messages)
    })
    const off = window.api.agent.onEvent(async (e) => {
      if (e.kind === 'turn_completed') {
        // Re-fetch terminal messages
        const fresh = await window.api.agent.loadConversation({ id: conversationId })
        setMessages(fresh.messages)
      }
    })
    return () => off()
  }, [conversationId])

  if (!conversation?.conversation) return <div className="p-4">Loading conversation…</div>

  return (
    <div className="flex h-full flex-col">
      <ConversationHeader
        conversation={conversation.conversation}
        vaultId={conversation.conversation.vaultId}
      />
      <MessageStream messages={messages} />
      <Composer conversationId={conversationId} sourceWindowId={String(window.api.windowId)} />
    </div>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/agent-chat/conversation-view.tsx \
  apps/desktop/src/renderer/src/agent-chat/message-stream.tsx \
  apps/desktop/src/renderer/src/agent-chat/messages
git commit -m "feat(agent-chat): conversation view with streaming message renderer"
```

---

## Task 17: Composer with `@`-ref picker and attached chip strip

**Files:**

- Create: `apps/desktop/src/renderer/src/agent-chat/composer.tsx`
- Create: `apps/desktop/src/renderer/src/agent-chat/ref-picker.tsx`
- Create: `apps/desktop/src/renderer/src/agent-chat/__tests__/composer.test.tsx`

- [ ] **Step 1: Write failing test for submit-on-cmd-enter**

```tsx
// apps/desktop/src/renderer/src/agent-chat/__tests__/composer.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Composer } from '../composer'

vi.mock('../agent-context', () => ({
  useAgent: () => ({ state: { activeConversationId: 'c', inFlight: {} }, dispatch: vi.fn() })
}))

describe('Composer', () => {
  it('submits on Cmd+Enter', () => {
    const send = vi.fn()
    Object.defineProperty(window, 'api', {
      value: {
        agent: { sendTurn: send }
      },
      configurable: true
    })
    render(<Composer conversationId="c" sourceWindowId="w" />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'hello' } })
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })
    expect(send).toHaveBeenCalledWith({
      conversationId: 'c',
      sourceWindowId: 'w',
      text: 'hello',
      attachments: []
    })
  })

  it('does NOT submit on plain Enter', () => {
    const send = vi.fn()
    Object.defineProperty(window, 'api', { value: { agent: { sendTurn: send } } })
    render(<Composer conversationId="c" sourceWindowId="w" />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'hello' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(send).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Implement composer**

```tsx
// apps/desktop/src/renderer/src/agent-chat/composer.tsx
import { useState, useRef } from 'react'

import type { AttachmentInput } from '@memry/contracts/ipc-agent'
import { useAgent } from './agent-context'
import { RefPicker } from './ref-picker'
import { useActiveTab } from '../contexts/tabs/context'

interface Props {
  conversationId: string
  sourceWindowId: string
}

export function Composer({ conversationId, sourceWindowId }: Props): JSX.Element {
  const { state } = useAgent()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<AttachmentInput[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const activeTab = useActiveTab()

  // Auto-attach current note as a sticky chip
  const currentNoteAttached = attachments.some((a) => a.kind === 'current_note')
  if (
    !currentNoteAttached &&
    activeTab?.kind === 'note' &&
    activeTab.entityId &&
    !attachments.find((a) => a.ref_id === '__current__')
  ) {
    setAttachments((prev) => [
      ...prev,
      {
        kind: 'current_note',
        ref_id: '__current__',
        label: activeTab.title || 'current note'
      }
    ])
  }

  const inFlight = state.inFlight[conversationId] === true

  const submit = (): void => {
    if (!text.trim() || inFlight) return
    void window.api.agent.sendTurn({
      conversationId,
      sourceWindowId,
      text,
      attachments
    })
    setText('')
    setAttachments([])
  }

  return (
    <div className="border-t border-border p-2">
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {attachments.map((a) => (
            <span
              key={a.ref_id}
              className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs"
            >
              {a.label}
              <button
                onClick={() => setAttachments((prev) => prev.filter((x) => x.ref_id !== a.ref_id))}
                aria-label={`Remove ${a.label}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          if (e.target.value.endsWith('@')) setPickerOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            submit()
          }
        }}
        rows={3}
        className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm"
        placeholder="Ask the agent…  (⌘↵ to send, @ to attach)"
        disabled={inFlight}
      />
      {pickerOpen && (
        <RefPicker
          query={text.split('@').pop() ?? ''}
          onPick={(att) => {
            setAttachments((prev) => [...prev, att])
            setText((prev) => prev.replace(/@\S*$/, ''))
            setPickerOpen(false)
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 3: Implement ref picker (FTS-backed)**

```tsx
// apps/desktop/src/renderer/src/agent-chat/ref-picker.tsx
import { useEffect, useState } from 'react'

import type { AttachmentInput } from '@memry/contracts/ipc-agent'

interface Props {
  query: string
  onPick: (att: AttachmentInput) => void
  onClose: () => void
}

export function RefPicker({ query, onPick, onClose }: Props): JSX.Element {
  const [results, setResults] = useState<
    Array<{ kind: AttachmentInput['kind']; id: string; label: string }>
  >([])

  useEffect(() => {
    if (!query) {
      setResults([])
      return
    }
    void window.api.search.searchAll({ query, limit: 20 }).then((res) => {
      const flat: typeof results = []
      for (const g of res.groups) {
        for (const r of g.results) {
          flat.push({
            kind:
              g.kind === 'notes'
                ? 'note'
                : g.kind === 'folders'
                  ? 'folder'
                  : g.kind === 'tasks'
                    ? 'task'
                    : 'project',
            id: r.id,
            label: r.title ?? r.name ?? r.id
          })
        }
      }
      setResults(flat)
    })
  }, [query])

  return (
    <div className="absolute z-50 mt-1 max-h-64 w-72 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow">
      {results.length === 0 && <div className="p-2 text-xs text-muted-foreground">No matches.</div>}
      {results.map((r) => (
        <button
          key={`${r.kind}-${r.id}`}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-start text-sm hover:bg-accent"
          onClick={() => onPick({ kind: r.kind, ref_id: r.id, label: r.label })}
        >
          <span className="text-muted-foreground capitalize">{r.kind}</span>
          <span>{r.label}</span>
        </button>
      ))}
      <button onClick={onClose} className="mt-1 w-full text-xs text-muted-foreground">
        ESC to close
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Run, see tests pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/renderer/src/agent-chat/__tests__/composer.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/agent-chat/composer.tsx apps/desktop/src/renderer/src/agent-chat/ref-picker.tsx apps/desktop/src/renderer/src/agent-chat/__tests__/composer.test.tsx
git commit -m "feat(agent-chat): composer with cmd+enter submit and @ ref picker"
```

---

## Task 18: Approval modal — create-tool gate UI

**Files:**

- Create: `apps/desktop/src/renderer/src/agent-chat/approval-modal.tsx`

- [ ] **Step 1: Implement**

```tsx
// apps/desktop/src/renderer/src/agent-chat/approval-modal.tsx
import { useState } from 'react'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAgent } from './agent-context'

export function ApprovalModal(): JSX.Element | null {
  const { state, dispatch } = useAgent()
  const pending = state.pendingApprovals[0]
  const [editing, setEditing] = useState(false)
  const [edited, setEdited] = useState('')

  if (!pending) return null

  const isUpdate =
    pending.name.startsWith('vault_update_') ||
    pending.name === 'vault_move_to_folder' ||
    pending.name === 'vault_add_tag' ||
    pending.name === 'vault_remove_tag'

  const respond = async (
    decision:
      | { kind: 'allow' }
      | { kind: 'allow_always' }
      | { kind: 'deny' }
      | { kind: 'edit_allow'; editedArgs: unknown }
  ): Promise<void> => {
    await window.api.agent.approveTool({
      conversationId: pending.conversationId,
      toolCallId: pending.toolCallId,
      decision
    })
    dispatch({ type: 'clear_pending', toolCallId: pending.toolCallId })
    setEditing(false)
    setEdited('')
  }

  return (
    <Dialog open={true} onOpenChange={(open) => !open && respond({ kind: 'deny' })}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Allow {pending.name}?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          The agent wants to call <code>{pending.name}</code> with these arguments:
        </p>
        {!editing ? (
          <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs">
            {JSON.stringify(pending.args, null, 2)}
          </pre>
        ) : (
          <textarea
            value={edited || JSON.stringify(pending.args, null, 2)}
            onChange={(e) => setEdited(e.target.value)}
            rows={10}
            className="w-full rounded-md border border-border p-2 font-mono text-xs"
          />
        )}
        <div className="flex flex-wrap gap-2">
          {!isUpdate ? (
            <>
              <Button onClick={() => respond({ kind: 'allow' })}>Allow once</Button>
              <Button variant="secondary" onClick={() => respond({ kind: 'allow_always' })}>
                Allow & always
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  if (!editing) {
                    setEditing(true)
                    return
                  }
                  try {
                    respond({ kind: 'edit_allow', editedArgs: JSON.parse(edited) })
                  } catch {
                    // surface a toast in real impl
                  }
                }}
              >
                {editing ? 'Apply edits' : 'Edit & allow'}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={() => respond({ kind: 'allow' })}>Apply once</Button>
              <Button
                variant="secondary"
                onClick={() => {
                  if (!editing) {
                    setEditing(true)
                    return
                  }
                  try {
                    respond({ kind: 'edit_allow', editedArgs: JSON.parse(edited) })
                  } catch {
                    // surface toast
                  }
                }}
              >
                {editing ? 'Apply edits' : 'Edit & apply'}
              </Button>
            </>
          )}
          <Button variant="destructive" onClick={() => respond({ kind: 'deny' })}>
            Deny
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Mount**

Add `<ApprovalModal />` to `agent-pane.tsx` so it's rendered alongside the conversation view.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/agent-chat/approval-modal.tsx apps/desktop/src/renderer/src/agent-chat/agent-pane.tsx
git commit -m "feat(agent-chat): approval modal with allow/edit/deny + trust list"
```

---

## Task 19: Diff modal for `vault_update_note`

**Files:**

- Create: `apps/desktop/src/renderer/src/agent-chat/diff-modal.tsx`
- Add dependency: `react-diff-view` (or hand-rolled — choose at impl time)

- [ ] **Step 1: Decide implementation strategy**

Prefer hand-rolled side-by-side textarea with diff highlighting if you can do it in <150 lines; otherwise add `pnpm --filter @memry/desktop add react-diff-view`.

- [ ] **Step 2: Implement diff modal**

The modal:

1. Reads the proposed `args` (id, mode, content_markdown).
2. Calls a new IPC channel `agent:previewDiff` that runs `vault.read_note` then applies `mode` against current content to produce candidate.
3. Renders a side-by-side or unified diff.
4. Allows the user to edit the candidate side before confirming.
5. Dispatches `edit_allow` with the modified `content_markdown`.

This is the heaviest UI task. Build it incrementally:

a. IPC handler `agent:previewDiff(input: { conversationId, toolCallId }) → { current, candidate }` in `agent-handlers.ts`.

b. The component tree in `diff-modal.tsx`:

- When the active pending approval has `requiresDiff=true`, render this instead of `<ApprovalModal>`.
- Show two panels: "Current" (read-only) and "Candidate" (editable textarea preset to candidate).
- Buttons: Apply / Edit & apply / Deny.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/agent-chat/diff-modal.tsx apps/desktop/src/main/ipc/agent-handlers.ts
git commit -m "feat(agent-chat): diff preview modal for vault_update_note"
```

---

## Task 20: Mount AgentProvider, exposure in preload

**Files:**

- Modify: `apps/desktop/src/main/preload/index.ts`
- Modify: `apps/desktop/src/renderer/src/App.tsx`

- [ ] **Step 1: Expose `agent` and `search` in preload**

```ts
// apps/desktop/src/main/preload/index.ts (additions)
import { AgentChannels } from '@memry/contracts/ipc-agent'

const api = {
  // ...existing
  agent: {
    listConversations: (input: { vaultId: string }) =>
      ipcRenderer.invoke(AgentChannels.invoke.LIST_CONVERSATIONS, input),
    createConversation: (input: { vaultId: string; backend?: string }) =>
      ipcRenderer.invoke(AgentChannels.invoke.CREATE_CONVERSATION, input),
    loadConversation: (input: { id: string }) =>
      ipcRenderer.invoke(AgentChannels.invoke.LOAD_CONVERSATION, input),
    sendTurn: (input: {
      conversationId: string
      sourceWindowId: string
      text: string
      attachments: unknown[]
    }) => ipcRenderer.invoke(AgentChannels.invoke.SEND_TURN, input),
    cancelTurn: (input: { conversationId: string }) =>
      ipcRenderer.invoke(AgentChannels.invoke.CANCEL_TURN, input),
    approveTool: (input: { conversationId: string; toolCallId: string; decision: unknown }) =>
      ipcRenderer.invoke(AgentChannels.invoke.APPROVE_TOOL, input),
    editTrustList: (input: { conversationId: string; add?: string[]; remove?: string[] }) =>
      ipcRenderer.invoke(AgentChannels.invoke.EDIT_TRUST_LIST, input),
    getBinaryStatus: () => ipcRenderer.invoke(AgentChannels.invoke.GET_BINARY_STATUS),
    acceptDisclosure: () => ipcRenderer.invoke(AgentChannels.invoke.ACCEPT_DISCLOSURE),
    getDisclosureState: () => ipcRenderer.invoke(AgentChannels.invoke.GET_DISCLOSURE_STATE),
    onEvent: (cb: (e: unknown) => void) => {
      const handler = (_evt: unknown, payload: unknown) => cb(payload)
      ipcRenderer.on(AgentChannels.events.AGENT_EVENT, handler)
      return () => ipcRenderer.off(AgentChannels.events.AGENT_EVENT, handler)
    }
  },
  windowId: process.contextIsolated
    ? undefined
    : (require('@electron/remote').getCurrentWindow().id ?? null)
}
```

> **Note:** the project may not use `@electron/remote`. The cleanest way to expose the current `BrowserWindow.id` to the renderer is a one-shot IPC channel `system:get_window_id` that resolves the calling window's id from `event.sender.id`. Add that channel inline.

- [ ] **Step 2: Mount provider**

Add to `App.tsx` near the existing context providers:

```tsx
import { AgentProvider } from './agent-chat/agent-context'

// wrap AppContent:
;<AgentProvider>
  <AppContent />
</AgentProvider>
```

- [ ] **Step 3: Run IPC check and commit**

```bash
pnpm ipc:generate
pnpm ipc:check
git add apps/desktop/src/main/preload/index.ts apps/desktop/src/renderer/src/App.tsx apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts
git commit -m "feat(agent-chat): wire preload bridge + mount AgentProvider"
```

---

## Task 21: Cancel turn — Stop button + Esc

**Files:**

- Modify: `apps/desktop/src/renderer/src/agent-chat/conversation-view.tsx`
- Modify: `apps/desktop/src/main/agent/runtime/runtime.ts`

- [ ] **Step 1: Add Stop button**

In conversation-view, render a small "Stop" button when `state.inFlight[conversationId]` is true. Wire it to `window.api.agent.cancelTurn({ conversationId })` and bind `Esc` (when the agent pane has focus) to the same.

- [ ] **Step 2: Implement subprocess kill in runtime**

In `runtime.ts`, when `cancelTurn` is called, look up the AbortController for that conversation, signal abort, and call kill on the tracked subprocess. Add `track(subprocess)` and `untrack(pid)` helpers used by the spawn adapter.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/agent-chat/conversation-view.tsx apps/desktop/src/main/agent/runtime/runtime.ts
git commit -m "feat(agent-chat): stop button and Esc cancel running turn"
```

---

## Task 22: Subprocess cleanup on `app.before-quit`

**Files:**

- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Add cleanup hook**

```ts
app.on('before-quit', async (event) => {
  event.preventDefault()
  await Promise.allSettled([
    agent.shutdown(), // already added in Task 11
    stopAgentMcpLifecycle()
  ])
  app.exit(0)
})
```

> **Note:** macOS Electron sometimes leaves child processes alive when the parent dies. The runtime tracks every spawned `claude` subprocess; `runtime.killAll()` sends SIGTERM, then SIGKILL after 500 ms. Verify with `ps -ef | grep claude` after a test app quit — there should be no orphans.

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "feat(agent-runtime): kill spawned claude subprocesses on app quit"
```

---

## Task 23: E2E — "create a task from current note"

**Files:**

- Create: `apps/desktop/tests/e2e/agent-chat-create-task.e2e.ts`

This is the P3 acceptance test. It exercises the full Phase-1 + Phase-2 + Phase-3 flow with a stubbed Claude binary that emits a fixed stream-json sequence calling `vault_create_task`.

- [ ] **Step 1: Build a stub `claude` binary**

Create `apps/desktop/tests/fixtures/claude-stub.ts`:

```ts
#!/usr/bin/env node
// Stub claude that emits a hardcoded stream-json sequence on stdout.
// Reads stdin (the prompt), ignores it, then prints the canned events.
import process from 'node:process'

process.stdin.on('data', () => {})
process.stdin.on('end', () => {
  const events = [
    {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: "Sure, I'll create a task." }
    },
    {
      type: 'content_block_start',
      content_block: {
        type: 'tool_use',
        id: 'tu_1',
        name: 'mcp__memry__vault_create_task',
        input: { title: 'Buy milk' }
      }
    },
    { type: 'message_stop' }
  ]
  for (const e of events) process.stdout.write(JSON.stringify(e) + '\n')
  setTimeout(() => process.exit(0), 50)
})
process.stdin.resume()
```

Compile and put on PATH inside the test:

```bash
pnpm --filter @memry/desktop exec esbuild tests/fixtures/claude-stub.ts --bundle --platform=node --outfile=tests/fixtures/claude-stub.js
chmod +x tests/fixtures/claude-stub.js
```

- [ ] **Step 2: Write the test**

```ts
// apps/desktop/tests/e2e/agent-chat-create-task.e2e.ts
import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'

test.describe('Agent chat — create task from current note', () => {
  let app: Awaited<ReturnType<typeof electron.launch>>

  test.beforeAll(async () => {
    app = await electron.launch({
      args: [path.resolve('out/main/index.js')],
      env: {
        ...process.env,
        // Override PATH so spawn finds our stub instead of the real claude
        PATH: `${path.resolve('tests/fixtures')}:${process.env.PATH}`,
        MEMRY_CLAUDE_BIN: path.resolve('tests/fixtures/claude-stub.js')
      }
    })
  })

  test.afterAll(async () => {
    await app.close()
  })

  test('user opens a note, asks the agent for a task, approves, and a task appears', async () => {
    const window = await app.firstWindow()
    await window.waitForSelector('[data-testid="app-ready"]', { timeout: 30000 })

    // 1. Open a note (assume seed data has one)
    await window.click('[data-testid="note-list-item"]')
    await window.waitForSelector('[data-testid="note-editor"]')

    // 2. Open Agent tab
    await window.click('button:has-text("Agent")')

    // 3. Accept disclosure
    await window.click('button:has-text("Enable Claude CLI chat")')

    // 4. Start a new conversation
    await window.click('button:has-text("New conversation")')

    // 5. Type a message and submit
    const composer = window.locator('textarea[placeholder*="agent"]')
    await composer.fill('Create a task from this note')
    await composer.press('Meta+Enter')

    // 6. Approval modal appears for vault_create_task
    await window.waitForSelector('text=Allow vault_create_task?')
    await window.click('button:has-text("Allow once")')

    // 7. Task appears
    await window.click('button:has-text("Tasks")') // navigate to tasks view
    await expect(window.locator('text=Buy milk')).toBeVisible({ timeout: 5000 })
  })
})
```

- [ ] **Step 3: Run**

```bash
bash apps/desktop/scripts/ensure-native.sh electron
pnpm --filter @memry/desktop exec electron-vite build
pnpm --filter @memry/desktop test:e2e -- agent-chat-create-task.e2e.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/tests/fixtures/claude-stub.ts apps/desktop/tests/e2e/agent-chat-create-task.e2e.ts
git commit -m "test(agent-chat): e2e create-task-from-current-note flow"
```

---

## Task 24: Conversation compactor

When prompt size approaches the 100k-token cap, the runtime summarizes the oldest 50% of message history into a synthetic system note (`role=system`, `kind=compacted`) generated by another `claude -p` call with a fixed compaction prompt. The summary is persisted as a new system message; original messages stay in the DB; future prompt rebuilds use the summary in place of the summarized prefix.

**Files:**

- Create: `apps/desktop/src/main/agent/runtime/compactor.ts`
- Create: `apps/desktop/src/main/agent/runtime/__tests__/compactor.test.ts`
- Modify: `apps/desktop/src/main/agent/runtime/turn.ts` (call compactor before assembling prompt)
- Modify: `apps/desktop/src/main/agent/runtime/prompt-assembler.ts` (skip messages older than the latest compaction marker)

- [ ] **Step 1: Write failing test**

```ts
// apps/desktop/src/main/agent/runtime/__tests__/compactor.test.ts
import { describe, it, expect, beforeAll, vi } from 'vitest'
import sodium from 'libsodium-wrappers'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'
import { createMessageStore } from '../../storage/message-store'
import { maybeCompact, COMPACT_PROMPT } from '../compactor'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      content_ciphertext TEXT NOT NULL, attachments_ciphertext TEXT NOT NULL,
      tool_call_id TEXT, status TEXT NOT NULL, vector_clock TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
    );
  `)
  return drizzle(sqlite, { schema })
}

describe('Conversation compactor', () => {
  let vaultKey: Uint8Array
  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  it('does nothing when prompt size is under the threshold', async () => {
    const db = freshDb()
    const messages = createMessageStore({ db, vaultKey, deviceId: 'd1' })
    const summarize = vi.fn(async () => 'summary')
    await maybeCompact({
      conversationId: 'c',
      messages,
      summarize,
      tokenThreshold: 100_000,
      currentTokenEstimate: 1_000
    })
    expect(summarize).not.toHaveBeenCalled()
  })

  it('summarizes oldest 50% when over threshold and persists a system note', async () => {
    const db = freshDb()
    const messages = createMessageStore({ db, vaultKey, deviceId: 'd1' })
    for (let i = 0; i < 6; i++) {
      await messages.append({
        conversationId: 'c',
        role: 'user',
        content: { role: 'user', data: { text: `msg-${i}` } },
        attachments: [],
        status: 'completed'
      })
      await new Promise((r) => setTimeout(r, 1))
    }
    const summarize = vi.fn(
      async (toSummarize: string) => `SUMMARY of: ${toSummarize.slice(0, 20)}`
    )
    await maybeCompact({
      conversationId: 'c',
      messages,
      summarize,
      tokenThreshold: 1, // force compaction
      currentTokenEstimate: 2
    })
    expect(summarize).toHaveBeenCalledTimes(1)
    const all = await messages.listByConversation('c')
    const systemNotes = all.filter((m) => m.role === 'system')
    expect(systemNotes).toHaveLength(1)
    if (systemNotes[0].content.role === 'system') {
      expect(systemNotes[0].content.data.kind).toBe('compacted')
    }
    // Original messages still in DB (not deleted)
    expect(all.filter((m) => m.role === 'user')).toHaveLength(6)
  })

  it('uses the spec-mandated compaction prompt prefix', () => {
    expect(COMPACT_PROMPT).toContain('Earlier in this conversation')
  })
})
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/runtime/__tests__/compactor.test.ts`
Expected: FAIL — `../compactor` missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/agent/runtime/compactor.ts
import type { MessageStore } from '../storage/message-store'

export const COMPACT_PROMPT =
  'Summarize the following conversation history concisely. Begin your output with "Earlier in this conversation:" and preserve the user\'s intents, decisions, and any task ids or note ids that were created. Skip pleasantries.'

export interface MaybeCompactInput {
  conversationId: string
  messages: MessageStore
  summarize: (toSummarize: string) => Promise<string>
  tokenThreshold: number
  currentTokenEstimate: number
}

export async function maybeCompact(input: MaybeCompactInput): Promise<void> {
  if (input.currentTokenEstimate < input.tokenThreshold) return

  const all = await input.messages.listByConversation(input.conversationId)
  // Skip already-compacted prefix.
  const lastCompactedIdx = findLastCompactedIndex(all)
  const slice = all.slice(lastCompactedIdx + 1)
  if (slice.length < 2) return

  const halfway = Math.floor(slice.length / 2)
  const oldest = slice.slice(0, halfway)
  const dump = oldest
    .map((m) => `[${m.role}] ${JSON.stringify((m.content as { data: unknown }).data)}`)
    .join('\n')

  const summary = await input.summarize(`${COMPACT_PROMPT}\n\n${dump}`)
  await input.messages.append({
    conversationId: input.conversationId,
    role: 'system',
    content: {
      role: 'system',
      data: {
        kind: 'compacted',
        payload: {
          summary,
          summarizedThroughId: oldest[oldest.length - 1].id,
          summarizedAt: Date.now()
        }
      }
    },
    attachments: [],
    status: 'completed'
  })
}

function findLastCompactedIndex(
  messages: ReturnType<MessageStore['listByConversation']> extends Promise<infer T> ? T : never
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'system' && m.content.role === 'system' && m.content.data.kind === 'compacted') {
      return i
    }
  }
  return -1
}
```

- [ ] **Step 4: Wire into turn orchestrator**

Edit `apps/desktop/src/main/agent/runtime/turn.ts`. Before assembling the prompt, call:

```ts
import { maybeCompact } from './compactor'
import { estimateTokens, COMPACTION_THRESHOLD } from './token-estimator'

// inside runTurn, before assemblePrompt:
const draftPrompt = assemblePrompt({
  history: prior,
  userMessage: input.text,
  attachments: input.attachments
})
await maybeCompact({
  conversationId: input.conversationId,
  messages: deps.messages,
  summarize: async (textToSummarize) => {
    // Spawn a separate claude -p just for the summary.
    const sub = await deps.spawnSubprocess({
      prompt: textToSummarize,
      conversationId: input.conversationId,
      windowId: input.sourceWindowId
    })
    let buf = ''
    for await (const chunk of sub.stdout) buf += chunk.toString('utf8')
    await sub.cleanup()
    return buf
  },
  tokenThreshold: COMPACTION_THRESHOLD,
  currentTokenEstimate: estimateTokens(draftPrompt)
})
```

Then re-fetch `history` and re-assemble after compaction so the new system note is included.

- [ ] **Step 5: Update prompt assembler to honor compaction marker**

In `prompt-assembler.ts`, when serializing history, if a system message with `kind === 'compacted'` is found, render its `payload.summary` and skip messages whose ids are `<= summarizedThroughId`.

- [ ] **Step 6: Run, see all tests pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/runtime/__tests__/compactor.test.ts src/main/agent/runtime/__tests__/prompt-assembler.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/agent/runtime/compactor.ts apps/desktop/src/main/agent/runtime/__tests__/compactor.test.ts apps/desktop/src/main/agent/runtime/turn.ts apps/desktop/src/main/agent/runtime/prompt-assembler.ts
git commit -m "feat(agent-runtime): compact oldest 50% of history when prompt > 100k tokens"
```

---

## Task 25: Concurrent-turn lock at the conversation level

Spec: "v1: forbidden. The send button is disabled while a turn is in flight. (Multi-window edge case: lock at conversation level via main-process map, second sender gets 'another window is mid-turn' error.)" The renderer's `inFlight` map is good enough for single-window, but two windows watching the same conversation could both submit before either sees the in-flight state.

**Files:**

- Modify: `apps/desktop/src/main/agent/runtime/runtime.ts`
- Modify: `apps/desktop/src/main/ipc/agent-handlers.ts`
- Create: `apps/desktop/src/main/agent/runtime/__tests__/runtime-lock.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/desktop/src/main/agent/runtime/__tests__/runtime-lock.test.ts
import { describe, it, expect, vi, beforeAll } from 'vitest'
import sodium from 'libsodium-wrappers'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'
import { AgentRuntime } from '../runtime'
import { createConversationStore } from '../../storage/conversation-store'
import { createMessageStore } from '../../storage/message-store'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE agent_conversations (
      id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, title_ciphertext TEXT NOT NULL,
      backend TEXT NOT NULL, trust_list TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0,
      vector_clock TEXT NOT NULL, field_clocks TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      deleted_at INTEGER, last_synced_at INTEGER
    );
    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      content_ciphertext TEXT NOT NULL, attachments_ciphertext TEXT NOT NULL,
      tool_call_id TEXT, status TEXT NOT NULL, vector_clock TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
    );
  `)
  return drizzle(sqlite, { schema })
}

describe('AgentRuntime concurrent-turn lock', () => {
  let vaultKey: Uint8Array
  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  it('rejects a second send for a conversation that already has a turn in flight', async () => {
    const db = freshDb()
    const conversations = createConversationStore({ db, vaultKey, deviceId: 'd1' })
    const messages = createMessageStore({ db, vaultKey, deviceId: 'd1' })
    const runtime = new AgentRuntime({ conversations, messages, spawn: vi.fn() as never })

    runtime.acquireTurnLock('conv-1') // simulate first send
    expect(() => runtime.acquireTurnLock('conv-1')).toThrow(/already a turn in flight/i)
  })

  it('releases the lock when explicitly cleared', async () => {
    const db = freshDb()
    const conversations = createConversationStore({ db, vaultKey, deviceId: 'd1' })
    const messages = createMessageStore({ db, vaultKey, deviceId: 'd1' })
    const runtime = new AgentRuntime({ conversations, messages, spawn: vi.fn() as never })

    runtime.acquireTurnLock('conv-1')
    runtime.releaseTurnLock('conv-1')
    expect(() => runtime.acquireTurnLock('conv-1')).not.toThrow()
  })

  it('locks per conversation, not globally', async () => {
    const db = freshDb()
    const conversations = createConversationStore({ db, vaultKey, deviceId: 'd1' })
    const messages = createMessageStore({ db, vaultKey, deviceId: 'd1' })
    const runtime = new AgentRuntime({ conversations, messages, spawn: vi.fn() as never })

    runtime.acquireTurnLock('conv-1')
    expect(() => runtime.acquireTurnLock('conv-2')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/runtime/__tests__/runtime-lock.test.ts`
Expected: FAIL — `acquireTurnLock` does not exist.

- [ ] **Step 3: Implement on AgentRuntime**

Add to `runtime.ts`:

```ts
private turnLocks = new Set<string>()

acquireTurnLock(conversationId: string): void {
  if (this.turnLocks.has(conversationId)) {
    throw new Error(
      `There is already a turn in flight for conversation ${conversationId}; another window may be mid-turn.`
    )
  }
  this.turnLocks.add(conversationId)
}

releaseTurnLock(conversationId: string): void {
  this.turnLocks.delete(conversationId)
}
```

- [ ] **Step 4: Wire into IPC handler**

Edit `agent-handlers.ts` `SEND_TURN` handler to wrap the `runTurn` call:

```ts
ipcMain.handle(AgentChannels.invoke.SEND_TURN, async (_e, payload) => {
  const req = SendTurnRequestSchema.parse(payload)
  try {
    deps.runtime.acquireTurnLock(req.conversationId)
  } catch (err) {
    return { ok: false, error: extractErrorMessage(err, 'Conversation busy') }
  }
  const fullAttachments = await snapshotAttachments(req.attachments as AttachmentInput[])
  void runTurn(/* ... */).finally(() => deps.runtime.releaseTurnLock(req.conversationId))
  return { ok: true }
})
```

The renderer should treat `{ ok: false }` as a non-fatal toast (`'Another window is mid-turn for this conversation. Wait for it to finish or stop it from there.'`).

- [ ] **Step 5: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/runtime/__tests__/runtime-lock.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/agent/runtime/runtime.ts apps/desktop/src/main/ipc/agent-handlers.ts apps/desktop/src/main/agent/runtime/__tests__/runtime-lock.test.ts
git commit -m "feat(agent-runtime): per-conversation turn lock for multi-window safety"
```

---

## Task 26: Final verification + docs

- [ ] **Step 1: Run the full verify suite**

```bash
pnpm lint
pnpm typecheck:node && pnpm typecheck:web
pnpm --filter @memry/desktop test
pnpm test:e2e -- agent
```

Expected: all green (modulo CLAUDE.md known pre-existing failures).

- [ ] **Step 2: Manual exploratory pass**

Boot `pnpm dev`, run through:

- [ ] Disclosure flow first time
- [ ] Open conversation, ask "list my tasks" — read tools auto-approved, response streams
- [ ] Ask "create a task to call mom" — approval modal appears, accept, task created
- [ ] Edit-and-allow path on a `vault_create_note`
- [ ] Update-note flow with diff preview, edit candidate before applying
- [ ] Allow-always elevates to trust list, second create skips modal
- [ ] Stop button mid-stream cancels turn
- [ ] Switch tab to Day, watch dot badge appear when an approval is pending
- [ ] Quit app while turn in progress — no zombie `claude` processes

Document any issues found and fix before merging.

- [ ] **Step 3: Docs impact**

```bash
pnpm docs:impact
pnpm docs:ai-update
pnpm docs:impact --strict
pnpm docs:build
```

Update `apps/docs/src/*` to describe:

- Agent chat user flow
- Privacy disclosure language
- Tool surface and approval model
- How external MCP clients connect (cross-link to P1)
- Trust list semantics

- [ ] **Step 4: Commit docs**

```bash
git add apps/docs
git commit -m "docs: agent chat user guide (P3)"
```

---

## Final P3 deliverable checklist

- [ ] Day | Agent right-sidebar tab works; activity badge fires
- [ ] First-time disclosure required; subprocess never starts before acceptance
- [ ] Claude binary detection + version pin; install hint shown when missing/old
- [ ] Conversation create / list / load / switch via dropdown
- [ ] Composer with `@` ref picker, attached chips, current-note auto-attach, Cmd/Ctrl+Enter submit
- [ ] Streaming assistant text renders smoothly; tool-call cards appear inline
- [ ] Read tools auto-approved; create tools through approval modal; update tools through diff/before-after modal
- [ ] Allow-always grows trust list; trust list is per-conversation only
- [ ] Stop / Esc cancels a running turn; subprocess SIGTERM → SIGKILL after 500 ms
- [ ] Subprocess cleanup on app quit confirmed (no zombies)
- [ ] Conversation compaction triggers above 100k tokens; oldest 50% summarized into a system note
- [ ] Per-conversation turn lock blocks concurrent sends from a second window with a clear error
- [ ] E2E test passes: create task from current note end-to-end
- [ ] All P3 tests green; lint + typecheck pass; docs updated

P3 ships the alpha-ready Agent Chat. Phases P4 (Codex CLI) and P5 (cloud / Ollama backends) follow as separate specs and plans.

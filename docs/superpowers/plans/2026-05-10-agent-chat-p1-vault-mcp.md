# Agent Chat — P1: Vault MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a localhost HTTP/SSE MCP server in memry's main process that exposes the vault's read tools to any MCP client (Claude CLI, Cursor, Zed, Claude Desktop) and registers all create/update tools with `PERMISSION_DENIED` until an approval surface exists in P3.

**Architecture:** Single Node `http.Server` on `127.0.0.1:RANDOM_PORT`, bearer-token authenticated, hosting the official `@modelcontextprotocol/sdk` server with one tool per spec entry. Tools delegate to existing main-process domain services (notes, tasks, projects, journal, inbox, folders, tags) — they never query the DB directly. `vault.get_current_note` snapshots state from a renderer window via IPC. Server lifecycle is bound to the Electron `app.whenReady` / `app.before-quit` events; per-launch bearer token lives in process memory only.

**Tech Stack:** Node 20 `http`, `@modelcontextprotocol/sdk` (new dep), Zod v4 (already installed), Vitest (already installed), Playwright (already installed), libsodium (already installed for token gen).

**Spec reference:** [`docs/superpowers/specs/2026-05-10-agent-chat-design.md`](../specs/2026-05-10-agent-chat-design.md) — Phase 1 section.

---

## File Structure

**New files (this plan creates):**

| Path                                                            | Responsibility                                                                                                                                                        |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/main/agent/mcp/server.ts`                     | HTTP server boot, port selection, bearer-token middleware, MCP transport wiring                                                                                       |
| `apps/desktop/src/main/agent/mcp/session.ts`                    | Per-launch token, per-conversation context map, header parsing                                                                                                        |
| `apps/desktop/src/main/agent/mcp/registry.ts`                   | Tool registration manifest (drives both server registration and Claude `--allowed-tools` list)                                                                        |
| `apps/desktop/src/main/agent/mcp/errors.ts`                     | `AgentToolError` class with structured `code` field; MCP-format error helpers                                                                                         |
| `apps/desktop/src/main/agent/mcp/tools/read-tools.ts`           | Read-only tool implementations (search_notes, read_note, list_folder, list_tasks, list_projects, list_journal_entries, get_journal_entry, list_inbox_items, get_tags) |
| `apps/desktop/src/main/agent/mcp/tools/current-note.ts`         | `vault.get_current_note` + the IPC bridge to the renderer                                                                                                             |
| `apps/desktop/src/main/agent/mcp/tools/write-tools.ts`          | All create/update tool registrations; in P1 they validate args then return `PERMISSION_DENIED` unless an approval gate is supplied (gate = `null` in P1)              |
| `apps/desktop/src/main/agent/mcp/tools/schemas.ts`              | Zod input/output schemas, single source of truth for both server tools and renderer settings UI                                                                       |
| `apps/desktop/src/main/agent/mcp/lifecycle.ts`                  | `startAgentMcpServer` / `stopAgentMcpServer` exported, hooked into app boot                                                                                           |
| `apps/desktop/src/main/ipc/agent-mcp-handlers.ts`               | IPC channels for the settings panel (`agent_mcp:get_status`, `agent_mcp:rotate_token`) and for renderer current-note snapshot replies                                 |
| `packages/contracts/src/agent-mcp-channels.ts`                  | IPC channel constants + Zod schemas for the settings/status surface                                                                                                   |
| `apps/desktop/src/main/agent/mcp/__tests__/server.test.ts`      | Auth, port, token rotation, lifecycle                                                                                                                                 |
| `apps/desktop/src/main/agent/mcp/__tests__/read-tools.test.ts`  | One test per read tool against in-memory main services                                                                                                                |
| `apps/desktop/src/main/agent/mcp/__tests__/write-tools.test.ts` | All write tools deny without an approval gate                                                                                                                         |
| `apps/desktop/tests/e2e/agent-mcp-external-client.e2e.ts`       | Playwright-driven smoke test simulating an external MCP client                                                                                                        |

**Files to modify:**

| Path                                     | Why                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `apps/desktop/package.json`              | Add `@modelcontextprotocol/sdk` dependency                                                |
| `apps/desktop/src/main/index.ts`         | Boot `startAgentMcpServer()` after services are ready; stop on quit; kill child processes |
| `apps/desktop/src/main/ipc/index.ts`     | Register `agent-mcp-handlers`                                                             |
| `packages/contracts/src/index.ts`        | Re-export `agent-mcp-channels`                                                            |
| `apps/desktop/src/main/preload/index.ts` | Expose `agent_mcp:*` channels in the IPC bridge                                           |

---

## Conventions

- **Logging:** every file uses `createLogger('AgentMcpServer')` / `createLogger('AgentMcp:Tools')`. No raw `console.*`.
- **Errors:** never throw raw strings. Return `AgentToolError` instances with structured `code`.
- **Tool naming:** snake_case, no dots — `vault_read_note`, `vault_create_task`, etc. Documented aliases in the spec (`vault.read_note`) are for prose only; the wire name is the snake_case form.
- **Validation:** every tool input is parsed with `schema.safeParse()` before service call. Failures return `VALIDATION` errors.
- **Tests:** every task ships failing test → minimal impl → passing test → commit. Use Vitest's `describe`/`it`. For tests that need DB access, use the existing test fixture builder (see `apps/desktop/src/main/database/__tests__/test-db.ts` if it exists; otherwise the test will instantiate an in-memory `better-sqlite3` instance and run migrations).
- **Commit messages:** `feat(agent-mcp): <task description>`.

---

## Task 1: Add MCP SDK dependency

**Files:**

- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @memry/desktop add @modelcontextprotocol/sdk@^1.0.0
```

Expected: `pnpm-lock.yaml` updates. `apps/desktop/package.json` `dependencies` gains `@modelcontextprotocol/sdk`.

- [ ] **Step 2: Verify import resolves**

Create a temp file `apps/desktop/src/main/agent/mcp/__probe__.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
const probe: typeof McpServer = McpServer
void probe
```

Run: `pnpm --filter @memry/desktop exec tsc --noEmit src/main/agent/mcp/__probe__.ts`

Expected: no errors. Then delete the probe file.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat(agent-mcp): add @modelcontextprotocol/sdk dependency"
```

---

## Task 2: AgentToolError + structured error envelope

**Files:**

- Create: `apps/desktop/src/main/agent/mcp/errors.ts`
- Create: `apps/desktop/src/main/agent/mcp/__tests__/errors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/agent/mcp/__tests__/errors.test.ts
import { describe, it, expect } from 'vitest'
import { AgentToolError, toMcpToolErrorContent, type AgentToolErrorCode } from '../errors'

describe('AgentToolError', () => {
  it('carries a structured code, message, and details', () => {
    const err = new AgentToolError('NOT_FOUND', 'Note not found', { id: 'abc' })
    expect(err.code).toBe('NOT_FOUND')
    expect(err.message).toBe('Note not found')
    expect(err.details).toEqual({ id: 'abc' })
    expect(err).toBeInstanceOf(Error)
  })

  it('serializes to MCP tool-error content shape', () => {
    const err = new AgentToolError('VALIDATION', 'bad arg')
    const out = toMcpToolErrorContent(err)
    expect(out).toEqual({
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({ code: 'VALIDATION', message: 'bad arg', details: undefined })
        }
      ]
    })
  })

  it('coerces unknown errors into INTERNAL', () => {
    const out = toMcpToolErrorContent(new Error('boom'))
    expect(out.isError).toBe(true)
    const payload = JSON.parse(out.content[0].text)
    expect(payload.code).toBe('INTERNAL')
    expect(payload.message).toBe('boom')
  })

  it('exports the union of legal codes', () => {
    const codes: AgentToolErrorCode[] = ['NOT_FOUND', 'PERMISSION_DENIED', 'VALIDATION', 'INTERNAL']
    expect(codes).toHaveLength(4)
  })
})
```

- [ ] **Step 2: Run the test, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/__tests__/errors.test.ts`
Expected: FAIL — module `'../errors'` not found.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/agent/mcp/errors.ts
export type AgentToolErrorCode = 'NOT_FOUND' | 'PERMISSION_DENIED' | 'VALIDATION' | 'INTERNAL'

export class AgentToolError extends Error {
  readonly code: AgentToolErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: AgentToolErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'AgentToolError'
    this.code = code
    this.details = details
  }
}

export interface McpErrorContent {
  isError: true
  content: Array<{ type: 'text'; text: string }>
}

export function toMcpToolErrorContent(err: unknown): McpErrorContent {
  const tool =
    err instanceof AgentToolError
      ? { code: err.code, message: err.message, details: err.details }
      : {
          code: 'INTERNAL' as const,
          message: err instanceof Error ? err.message : String(err),
          details: undefined
        }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(tool) }]
  }
}
```

- [ ] **Step 4: Run the test, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/__tests__/errors.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/mcp/errors.ts apps/desktop/src/main/agent/mcp/__tests__/errors.test.ts
git commit -m "feat(agent-mcp): add AgentToolError with structured codes"
```

---

## Task 3: Session manager — per-launch token + conversation context

**Files:**

- Create: `apps/desktop/src/main/agent/mcp/session.ts`
- Create: `apps/desktop/src/main/agent/mcp/__tests__/session.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/agent/mcp/__tests__/session.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createMcpSession } from '../session'

describe('McpSession', () => {
  let session: ReturnType<typeof createMcpSession>

  beforeEach(() => {
    session = createMcpSession()
  })

  it('mints a 64-char hex bearer token on creation', () => {
    expect(session.token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rotates the token to a new value', () => {
    const previous = session.token
    const next = session.rotateToken()
    expect(next).not.toBe(previous)
    expect(session.token).toBe(next)
    expect(next).toMatch(/^[0-9a-f]{64}$/)
  })

  it('extracts conversation id from X-Memry-Conversation header', () => {
    const ctx = session.contextFromHeaders({
      authorization: `Bearer ${session.token}`,
      'x-memry-conversation': 'conv-42',
      'x-memry-window': 'win-7'
    })
    expect(ctx).toEqual({ conversationId: 'conv-42', windowId: 'win-7' })
  })

  it('returns null context when the header is absent (external client)', () => {
    const ctx = session.contextFromHeaders({ authorization: `Bearer ${session.token}` })
    expect(ctx).toEqual({ conversationId: null, windowId: null })
  })

  it('verifies bearer token in constant time', () => {
    expect(session.verifyToken(session.token)).toBe(true)
    expect(session.verifyToken('deadbeef')).toBe(false)
    expect(session.verifyToken(undefined)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/__tests__/session.test.ts`
Expected: FAIL — `../session` not found.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/agent/mcp/session.ts
import { randomBytes, timingSafeEqual } from 'node:crypto'

export interface McpSessionContext {
  conversationId: string | null
  windowId: string | null
}

export interface McpSession {
  readonly token: string
  rotateToken(): string
  verifyToken(candidate: string | undefined): boolean
  contextFromHeaders(headers: Record<string, string | string[] | undefined>): McpSessionContext
}

function mintToken(): string {
  return randomBytes(32).toString('hex')
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | null {
  const lower = name.toLowerCase()
  const raw = headers[lower] ?? headers[name]
  if (!raw) return null
  return Array.isArray(raw) ? (raw[0] ?? null) : raw
}

export function createMcpSession(): McpSession {
  let token = mintToken()
  return {
    get token() {
      return token
    },
    rotateToken() {
      token = mintToken()
      return token
    },
    verifyToken(candidate) {
      if (!candidate) return false
      const a = Buffer.from(candidate, 'utf8')
      const b = Buffer.from(token, 'utf8')
      if (a.length !== b.length) return false
      return timingSafeEqual(a, b)
    },
    contextFromHeaders(headers) {
      return {
        conversationId: readHeader(headers, 'x-memry-conversation'),
        windowId: readHeader(headers, 'x-memry-window')
      }
    }
  }
}
```

- [ ] **Step 4: Run the test, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/__tests__/session.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/mcp/session.ts apps/desktop/src/main/agent/mcp/__tests__/session.test.ts
git commit -m "feat(agent-mcp): add session manager with per-launch token"
```

---

## Task 4: Tool input/output schemas (Zod, single source of truth)

**Files:**

- Create: `apps/desktop/src/main/agent/mcp/tools/schemas.ts`
- Create: `apps/desktop/src/main/agent/mcp/tools/__tests__/schemas.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/agent/mcp/tools/__tests__/schemas.test.ts
import { describe, it, expect } from 'vitest'
import { TOOL_SCHEMAS, ALL_TOOL_NAMES, READ_TOOL_NAMES, WRITE_TOOL_NAMES } from '../schemas'

describe('Vault MCP tool schemas', () => {
  it('declares every tool the spec requires', () => {
    expect(ALL_TOOL_NAMES).toEqual([
      'vault_search_notes',
      'vault_read_note',
      'vault_list_folder',
      'vault_get_current_note',
      'vault_list_tasks',
      'vault_list_projects',
      'vault_get_journal_entry',
      'vault_list_journal_entries',
      'vault_list_inbox_items',
      'vault_get_tags',
      'vault_create_note',
      'vault_create_task',
      'vault_create_journal_entry',
      'vault_add_to_inbox',
      'vault_update_note',
      'vault_update_task',
      'vault_add_tag',
      'vault_remove_tag',
      'vault_move_to_folder'
    ])
  })

  it('partitions tools by mutation semantics', () => {
    expect(READ_TOOL_NAMES).toContain('vault_search_notes')
    expect(READ_TOOL_NAMES).not.toContain('vault_create_note')
    expect(WRITE_TOOL_NAMES).toContain('vault_create_note')
    expect(WRITE_TOOL_NAMES).toContain('vault_update_note')
    expect(WRITE_TOOL_NAMES).not.toContain('vault_read_note')
  })

  it('round-trips a known-good search input', () => {
    const parsed = TOOL_SCHEMAS.vault_search_notes.input.parse({ query: 'hello', limit: 10 })
    expect(parsed).toEqual({ query: 'hello', limit: 10 })
  })

  it('rejects an empty query for search', () => {
    const r = TOOL_SCHEMAS.vault_search_notes.input.safeParse({ query: '' })
    expect(r.success).toBe(false)
  })

  it('rejects unknown update_note modes', () => {
    const r = TOOL_SCHEMAS.vault_update_note.input.safeParse({
      id: 'x',
      mode: 'invalid',
      content_markdown: '...'
    })
    expect(r.success).toBe(false)
  })
})
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/tools/__tests__/schemas.test.ts`
Expected: FAIL — `../schemas` missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/agent/mcp/tools/schemas.ts
import { z } from 'zod'

const idSchema = z.string().min(1)

export const TOOL_SCHEMAS = {
  vault_search_notes: {
    input: z.object({
      query: z.string().min(1),
      limit: z.number().int().positive().max(50).optional(),
      folder_id: idSchema.optional()
    }),
    description: 'Full-text search across notes; returns id, title, snippet, folder_path.'
  },
  vault_read_note: {
    input: z.object({ id: idSchema }),
    description: 'Read a note by id; returns full markdown content + metadata.'
  },
  vault_list_folder: {
    input: z.object({
      path: z.string().optional(),
      id: idSchema.optional(),
      recursive: z.boolean().optional()
    }),
    description: 'List folder contents (sub-folders and notes).'
  },
  vault_get_current_note: {
    input: z.object({}).default({}),
    description: 'Return the note currently open in the originating renderer window, or null.'
  },
  vault_list_tasks: {
    input: z.object({
      status: z.string().optional(),
      project_id: idSchema.optional(),
      due_before: z.string().optional(),
      tag: z.string().optional(),
      limit: z.number().int().positive().max(200).optional()
    }),
    description: 'List tasks with optional filters.'
  },
  vault_list_projects: {
    input: z.object({}).default({}),
    description: 'List all projects with task counts.'
  },
  vault_get_journal_entry: {
    input: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    description: 'Return the journal entry for an ISO date or null.'
  },
  vault_list_journal_entries: {
    input: z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    }),
    description: 'List journal entry summaries within a date range (inclusive).'
  },
  vault_list_inbox_items: {
    input: z.object({ unread_only: z.boolean().optional() }),
    description: 'List inbox items (unread first by default).'
  },
  vault_get_tags: {
    input: z.object({}).default({}),
    description: 'List all tags with usage counts.'
  },
  vault_create_note: {
    input: z.object({
      title: z.string().min(1),
      content_markdown: z.string(),
      folder_path: z.string().optional(),
      tags: z.array(z.string()).optional()
    }),
    description: 'Create a new note. Requires user approval.'
  },
  vault_create_task: {
    input: z.object({
      title: z.string().min(1),
      project_id: idSchema.optional(),
      due: z.string().optional(),
      priority: z.number().int().min(0).max(3).optional(),
      tags: z.array(z.string()).optional(),
      notes: z.string().optional()
    }),
    description: 'Create a new task. Requires user approval.'
  },
  vault_create_journal_entry: {
    input: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      content_markdown: z.string()
    }),
    description: 'Create or return existing journal entry for date. Requires user approval.'
  },
  vault_add_to_inbox: {
    input: z.object({
      source: z.string().min(1),
      title: z.string().min(1),
      content: z.string()
    }),
    description: 'Append a new inbox item. Requires user approval.'
  },
  vault_update_note: {
    input: z.object({
      id: idSchema,
      mode: z.enum(['append', 'prepend', 'replace']),
      content_markdown: z.string()
    }),
    description: 'Update note body. Requires user approval with diff preview.'
  },
  vault_update_task: {
    input: z.object({
      id: idSchema,
      title: z.string().optional(),
      status: z.string().optional(),
      project_id: idSchema.nullish(),
      due: z.string().nullish(),
      priority: z.number().int().min(0).max(3).optional(),
      notes: z.string().optional()
    }),
    description: 'Update task fields. Requires user approval with before/after preview.'
  },
  vault_add_tag: {
    input: z.object({
      id: idSchema,
      kind: z.enum(['note', 'task']),
      tag: z.string().min(1)
    }),
    description: 'Add a tag to a note or task. Requires user approval.'
  },
  vault_remove_tag: {
    input: z.object({
      id: idSchema,
      kind: z.enum(['note', 'task']),
      tag: z.string().min(1)
    }),
    description: 'Remove a tag from a note or task. Requires user approval.'
  },
  vault_move_to_folder: {
    input: z.object({ id: idSchema, folder_path: z.string().min(1) }),
    description: 'Move a note to a folder. Requires user approval.'
  }
} as const

export type ToolName = keyof typeof TOOL_SCHEMAS

export const READ_TOOL_NAMES: ToolName[] = [
  'vault_search_notes',
  'vault_read_note',
  'vault_list_folder',
  'vault_get_current_note',
  'vault_list_tasks',
  'vault_list_projects',
  'vault_get_journal_entry',
  'vault_list_journal_entries',
  'vault_list_inbox_items',
  'vault_get_tags'
]

export const WRITE_TOOL_NAMES: ToolName[] = [
  'vault_create_note',
  'vault_create_task',
  'vault_create_journal_entry',
  'vault_add_to_inbox',
  'vault_update_note',
  'vault_update_task',
  'vault_add_tag',
  'vault_remove_tag',
  'vault_move_to_folder'
]

export const CREATE_TOOL_NAMES: ToolName[] = [
  'vault_create_note',
  'vault_create_task',
  'vault_create_journal_entry',
  'vault_add_to_inbox'
]

export const UPDATE_TOOL_NAMES: ToolName[] = [
  'vault_update_note',
  'vault_update_task',
  'vault_add_tag',
  'vault_remove_tag',
  'vault_move_to_folder'
]

export const ALL_TOOL_NAMES: ToolName[] = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]
```

- [ ] **Step 4: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/tools/__tests__/schemas.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/mcp/tools/schemas.ts apps/desktop/src/main/agent/mcp/tools/__tests__/schemas.test.ts
git commit -m "feat(agent-mcp): declare Zod schemas for all 19 vault tools"
```

---

## Task 5: Tool registry — drives MCP registration + Claude allowlist

**Files:**

- Create: `apps/desktop/src/main/agent/mcp/registry.ts`
- Create: `apps/desktop/src/main/agent/mcp/__tests__/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/agent/mcp/__tests__/registry.test.ts
import { describe, it, expect } from 'vitest'
import { buildClaudeAllowedToolsList, MCP_NAMESPACE } from '../registry'
import { ALL_TOOL_NAMES } from '../tools/schemas'

describe('Tool registry', () => {
  it('emits the namespace prefix expected by Claude --allowed-tools', () => {
    expect(MCP_NAMESPACE).toBe('memry')
  })

  it('builds a comma-separated list of mcp__memry__* names matching ALL_TOOL_NAMES', () => {
    const list = buildClaudeAllowedToolsList()
    const names = list.split(',')
    expect(names).toHaveLength(ALL_TOOL_NAMES.length)
    expect(names[0]).toBe('mcp__memry__vault_search_notes')
    for (const tool of ALL_TOOL_NAMES) {
      expect(names).toContain(`mcp__memry__${tool}`)
    }
  })
})
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/__tests__/registry.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/agent/mcp/registry.ts
import { ALL_TOOL_NAMES } from './tools/schemas'

export const MCP_NAMESPACE = 'memry'

export function buildClaudeAllowedToolsList(): string {
  return ALL_TOOL_NAMES.map((name) => `mcp__${MCP_NAMESPACE}__${name}`).join(',')
}
```

- [ ] **Step 4: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/__tests__/registry.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/mcp/registry.ts apps/desktop/src/main/agent/mcp/__tests__/registry.test.ts
git commit -m "feat(agent-mcp): add registry helpers for Claude --allowed-tools"
```

---

## Task 6: HTTP server with bearer-token auth (no tools yet)

**Files:**

- Create: `apps/desktop/src/main/agent/mcp/server.ts`
- Create: `apps/desktop/src/main/agent/mcp/__tests__/server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/agent/mcp/__tests__/server.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startAgentMcpServer, type AgentMcpServerHandle } from '../server'

describe('Agent MCP HTTP server', () => {
  let handle: AgentMcpServerHandle

  beforeEach(async () => {
    handle = await startAgentMcpServer({ toolRegistrations: [] })
  })

  afterEach(async () => {
    await handle.stop()
  })

  it('binds to 127.0.0.1 on a random port', () => {
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const port = Number(handle.url.split(':').pop())
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThan(0)
  })

  it('rejects requests with no Authorization header', async () => {
    const r = await fetch(`${handle.url}/mcp`, { method: 'POST', body: '{}' })
    expect(r.status).toBe(401)
  })

  it('rejects requests with a bad bearer token', async () => {
    const r = await fetch(`${handle.url}/mcp`, {
      method: 'POST',
      body: '{}',
      headers: { authorization: 'Bearer wrong-token' }
    })
    expect(r.status).toBe(401)
  })

  it('accepts a request with the right bearer token', async () => {
    const r = await fetch(`${handle.url}/healthz`, {
      headers: { authorization: `Bearer ${handle.token}` }
    })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body).toEqual({ ok: true })
  })

  it('rotates the bearer token and rejects the previous one', async () => {
    const previous = handle.token
    const next = handle.rotateToken()
    expect(next).not.toBe(previous)
    const r = await fetch(`${handle.url}/healthz`, {
      headers: { authorization: `Bearer ${previous}` }
    })
    expect(r.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/__tests__/server.test.ts`
Expected: FAIL — `../server` missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/agent/mcp/server.ts
import http from 'node:http'

import { createLogger } from '../../lib/logger'
import { createMcpSession, type McpSession } from './session'

const logger = createLogger('AgentMcpServer')

export interface ToolRegistration {
  name: string
  description: string
  inputSchema: unknown
  handler: (
    input: unknown,
    ctx: { conversationId: string | null; windowId: string | null }
  ) => Promise<unknown>
}

export interface StartOptions {
  toolRegistrations: ToolRegistration[]
}

export interface AgentMcpServerHandle {
  readonly url: string
  readonly token: string
  rotateToken(): string
  registerTool(reg: ToolRegistration): void
  stop(): Promise<void>
}

export async function startAgentMcpServer(opts: StartOptions): Promise<AgentMcpServerHandle> {
  const session = createMcpSession()
  const tools = new Map<string, ToolRegistration>()
  for (const reg of opts.toolRegistrations) tools.set(reg.name, reg)

  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization
    const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined
    if (!session.verifyToken(token)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    // /mcp routing wired in Task 7.
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found' }))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  if (!addr || typeof addr !== 'object') {
    server.close()
    throw new Error('Failed to bind agent MCP server')
  }
  const url = `http://127.0.0.1:${addr.port}`
  logger.info(`Agent MCP server listening on ${url}`)

  return {
    url,
    get token() {
      return session.token
    },
    rotateToken: () => session.rotateToken(),
    registerTool(reg) {
      tools.set(reg.name, reg)
    },
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      logger.info('Agent MCP server stopped')
    }
  }
}
```

- [ ] **Step 4: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/__tests__/server.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/mcp/server.ts apps/desktop/src/main/agent/mcp/__tests__/server.test.ts
git commit -m "feat(agent-mcp): boot localhost http server with bearer-token auth"
```

---

## Task 7: Wire MCP SDK transport into the HTTP server

**Files:**

- Modify: `apps/desktop/src/main/agent/mcp/server.ts`
- Modify: `apps/desktop/src/main/agent/mcp/__tests__/server.test.ts`

- [ ] **Step 1: Add a failing tool round-trip test**

Append to `server.test.ts`:

```ts
import { z } from 'zod'

describe('Agent MCP server tool round-trip', () => {
  it('routes a registered tool call through the SDK', async () => {
    const handle = await startAgentMcpServer({
      toolRegistrations: [
        {
          name: 'echo_tool',
          description: 'echo input',
          inputSchema: z.object({ msg: z.string() }),
          handler: async (input) => ({ echoed: (input as { msg: string }).msg })
        }
      ]
    })

    const r = await fetch(`${handle.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${handle.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'echo_tool', arguments: { msg: 'hi' } }
      })
    })

    expect(r.status).toBe(200)
    const text = await r.text()
    expect(text).toContain('"echoed":"hi"')

    await handle.stop()
  })
})
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/__tests__/server.test.ts`
Expected: FAIL — server returns 404 for `/mcp`.

- [ ] **Step 3: Wire MCP SDK transport into the server**

Replace the `/mcp routing wired in Task 7.` comment block in `server.ts` with the SDK wiring. Full replacement file:

```ts
// apps/desktop/src/main/agent/mcp/server.ts
import http from 'node:http'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z, type ZodTypeAny } from 'zod'

import { createLogger } from '../../lib/logger'
import { toMcpToolErrorContent } from './errors'
import { createMcpSession } from './session'

const logger = createLogger('AgentMcpServer')

export interface ToolRegistration {
  name: string
  description: string
  inputSchema: ZodTypeAny
  handler: (
    input: unknown,
    ctx: { conversationId: string | null; windowId: string | null }
  ) => Promise<unknown>
}

export interface StartOptions {
  toolRegistrations: ToolRegistration[]
}

export interface AgentMcpServerHandle {
  readonly url: string
  readonly token: string
  rotateToken(): string
  registerTool(reg: ToolRegistration): void
  stop(): Promise<void>
}

export async function startAgentMcpServer(opts: StartOptions): Promise<AgentMcpServerHandle> {
  const session = createMcpSession()
  const tools = new Map<string, ToolRegistration>()

  const mcp = new McpServer({ name: 'memry-vault', version: '1.0.0' })

  function bindTool(reg: ToolRegistration): void {
    mcp.registerTool(
      reg.name,
      { description: reg.description, inputSchema: reg.inputSchema as unknown as z.ZodRawShape },
      async (input, extra) => {
        const reqHeaders = (extra?.requestInfo?.headers ?? {}) as Record<
          string,
          string | string[] | undefined
        >
        const ctx = session.contextFromHeaders(reqHeaders)
        try {
          const result = await reg.handler(input, ctx)
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        } catch (err) {
          logger.error(`Tool ${reg.name} failed`, err)
          return toMcpToolErrorContent(err)
        }
      }
    )
    tools.set(reg.name, reg)
  }

  for (const reg of opts.toolRegistrations) bindTool(reg)

  const server = http.createServer(async (req, res) => {
    const auth = req.headers.authorization
    const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined
    if (!session.verifyToken(token)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (req.method === 'POST' && req.url === '/mcp') {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      try {
        await mcp.connect(transport)
        const body = await readJson(req)
        await transport.handleRequest(req, res, body)
      } catch (err) {
        logger.error('MCP request failed', err)
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'internal' }))
        }
      } finally {
        transport.close()
      }
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found' }))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  if (!addr || typeof addr !== 'object') {
    server.close()
    throw new Error('Failed to bind agent MCP server')
  }
  const url = `http://127.0.0.1:${addr.port}`
  logger.info(`Agent MCP server listening on ${url}`)

  return {
    url,
    get token() {
      return session.token
    },
    rotateToken: () => session.rotateToken(),
    registerTool: bindTool,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      logger.info('Agent MCP server stopped')
    }
  }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
```

- [ ] **Step 4: Run, see all server tests pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/__tests__/server.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/mcp/server.ts apps/desktop/src/main/agent/mcp/__tests__/server.test.ts
git commit -m "feat(agent-mcp): wire @modelcontextprotocol/sdk transport into http server"
```

---

## Task 8: Service handles for tools (dependency-injection seam)

The MCP tools must call into existing main-process services without taking direct DB references. This task introduces a `VaultServiceHandles` type that exposes only the methods we need. Tests will fake it.

**Files:**

- Create: `apps/desktop/src/main/agent/mcp/tools/handles.ts`

- [ ] **Step 1: Write the file**

```ts
// apps/desktop/src/main/agent/mcp/tools/handles.ts
// Dependency-injected facade: every tool calls into here, never directly into stores.
// Tests pass a fake; production wiring constructs from real services in lifecycle.ts.

export interface NoteSummary {
  id: string
  title: string
  snippet: string
  folder_path: string | null
}

export interface NoteFull {
  id: string
  title: string
  content_markdown: string
  tags: string[]
  folder_path: string | null
  frontmatter: Record<string, unknown>
}

export interface FolderEntry {
  kind: 'folder' | 'note'
  id: string
  name: string
  path: string
}

export interface TaskSummary {
  id: string
  title: string
  status: string
  due: string | null
  project: string | null
  tags: string[]
}

export interface ProjectSummary {
  id: string
  name: string
  status: string | null
  task_count: number
}

export interface JournalEntry {
  id: string
  date: string
  content_markdown: string
}

export interface JournalSummary {
  id: string
  date: string
  title: string
}

export interface InboxSummary {
  id: string
  source: string
  title: string
  snippet: string
  captured_at: number
}

export interface TagCount {
  name: string
  count: number
}

export interface CurrentNoteSnapshot {
  id: string
  title: string
  content_markdown: string
  tags: string[]
}

export interface VaultServiceHandles {
  notes: {
    search(input: { query: string; limit?: number; folderId?: string }): Promise<NoteSummary[]>
    read(id: string): Promise<NoteFull | null>
    create(input: {
      title: string
      content_markdown: string
      folder_path?: string
      tags?: string[]
    }): Promise<{ id: string }>
    update(input: {
      id: string
      mode: 'append' | 'prepend' | 'replace'
      content_markdown: string
    }): Promise<void>
    addTag(input: { id: string; tag: string }): Promise<void>
    removeTag(input: { id: string; tag: string }): Promise<void>
    moveToFolder(input: { id: string; folder_path: string }): Promise<void>
  }
  folders: {
    list(input: { path?: string; id?: string; recursive?: boolean }): Promise<FolderEntry[]>
  }
  tasks: {
    list(input: {
      status?: string
      project_id?: string
      due_before?: string
      tag?: string
      limit?: number
    }): Promise<TaskSummary[]>
    create(input: {
      title: string
      project_id?: string
      due?: string
      priority?: number
      tags?: string[]
      notes?: string
    }): Promise<{ id: string }>
    update(
      id: string,
      patch: {
        title?: string
        status?: string
        project_id?: string | null
        due?: string | null
        priority?: number
        notes?: string
      }
    ): Promise<void>
    addTag(input: { id: string; tag: string }): Promise<void>
    removeTag(input: { id: string; tag: string }): Promise<void>
  }
  projects: {
    list(): Promise<ProjectSummary[]>
  }
  journal: {
    getByDate(date: string): Promise<JournalEntry | null>
    listInRange(input: { from: string; to: string }): Promise<JournalSummary[]>
    createIfMissing(input: {
      date: string
      content_markdown: string
    }): Promise<{ id: string; created: boolean }>
  }
  inbox: {
    list(input: { unread_only?: boolean }): Promise<InboxSummary[]>
    add(input: { source: string; title: string; content: string }): Promise<{ id: string }>
  }
  tags: {
    listAll(): Promise<TagCount[]>
  }
  windows: {
    snapshotCurrentNote(windowId: string): Promise<CurrentNoteSnapshot | null>
  }
}
```

- [ ] **Step 2: Verify the type compiles**

Run: `pnpm --filter @memry/desktop exec tsc --noEmit`
Expected: no new errors. (Pre-existing test-file errors from CLAUDE.md "Known Gotchas" are fine.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/agent/mcp/tools/handles.ts
git commit -m "feat(agent-mcp): declare VaultServiceHandles dependency-injection seam"
```

---

## Task 9: Read tools — implement and test against fake handles

**Files:**

- Create: `apps/desktop/src/main/agent/mcp/tools/read-tools.ts`
- Create: `apps/desktop/src/main/agent/mcp/tools/__tests__/read-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/src/main/agent/mcp/tools/__tests__/read-tools.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { buildReadTools } from '../read-tools'
import type { VaultServiceHandles } from '../handles'
import { AgentToolError } from '../../errors'

function fake(): VaultServiceHandles {
  return {
    notes: {
      search: async ({ query }) =>
        query === 'hit'
          ? [{ id: 'n1', title: 'Hit', snippet: 'hit me', folder_path: '/Inbox' }]
          : [],
      read: async (id) =>
        id === 'n1'
          ? {
              id: 'n1',
              title: 'Hit',
              content_markdown: '# Hit',
              tags: ['t'],
              folder_path: '/Inbox',
              frontmatter: { foo: 1 }
            }
          : null,
      create: async () => ({ id: 'unused' }),
      update: async () => {},
      addTag: async () => {},
      removeTag: async () => {},
      moveToFolder: async () => {}
    },
    folders: {
      list: async ({ path }) =>
        path === '/'
          ? [
              { kind: 'folder', id: 'f1', name: 'Inbox', path: '/Inbox' },
              { kind: 'note', id: 'n1', name: 'Hit', path: '/Inbox/Hit.md' }
            ]
          : []
    },
    tasks: {
      list: async () => [
        { id: 't1', title: 'Buy milk', status: 'todo', due: null, project: null, tags: [] }
      ],
      create: async () => ({ id: 'unused' }),
      update: async () => {},
      addTag: async () => {},
      removeTag: async () => {}
    },
    projects: {
      list: async () => [{ id: 'p1', name: 'Memry', status: 'active', task_count: 5 }]
    },
    journal: {
      getByDate: async (date) =>
        date === '2026-05-10' ? { id: 'j1', date, content_markdown: '# Today' } : null,
      listInRange: async () => [{ id: 'j1', date: '2026-05-10', title: 'Today' }],
      createIfMissing: async () => ({ id: 'unused', created: false })
    },
    inbox: {
      list: async () => [
        { id: 'i1', source: 'web', title: 'Cool', snippet: '...', captured_at: 0 }
      ],
      add: async () => ({ id: 'unused' })
    },
    tags: {
      listAll: async () => [{ name: 'todo', count: 3 }]
    },
    windows: {
      snapshotCurrentNote: async () => null
    }
  }
}

describe('Read tools', () => {
  let handles: VaultServiceHandles
  let tools: ReturnType<typeof buildReadTools>

  beforeEach(() => {
    handles = fake()
    tools = buildReadTools(handles)
  })

  it('vault_search_notes returns hits', async () => {
    const out = await tools
      .find((t) => t.name === 'vault_search_notes')!
      .handler({ query: 'hit' }, { conversationId: null, windowId: null })
    expect(out).toEqual([{ id: 'n1', title: 'Hit', snippet: 'hit me', folder_path: '/Inbox' }])
  })

  it('vault_read_note throws NOT_FOUND for missing note', async () => {
    await expect(
      tools
        .find((t) => t.name === 'vault_read_note')!
        .handler({ id: 'missing' }, { conversationId: null, windowId: null })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('vault_read_note returns full note', async () => {
    const out = await tools
      .find((t) => t.name === 'vault_read_note')!
      .handler({ id: 'n1' }, { conversationId: null, windowId: null })
    expect(out).toMatchObject({ id: 'n1', title: 'Hit', content_markdown: '# Hit' })
  })

  it('vault_list_folder returns mixed entries', async () => {
    const out = (await tools
      .find((t) => t.name === 'vault_list_folder')!
      .handler({ path: '/' }, { conversationId: null, windowId: null })) as unknown[]
    expect(out).toHaveLength(2)
  })

  it('vault_list_tasks returns rows', async () => {
    const out = (await tools
      .find((t) => t.name === 'vault_list_tasks')!
      .handler({}, { conversationId: null, windowId: null })) as unknown[]
    expect(out).toHaveLength(1)
  })

  it('vault_list_projects returns rows', async () => {
    const out = (await tools
      .find((t) => t.name === 'vault_list_projects')!
      .handler({}, { conversationId: null, windowId: null })) as unknown[]
    expect(out).toHaveLength(1)
  })

  it('vault_get_journal_entry returns null for missing date', async () => {
    const out = await tools
      .find((t) => t.name === 'vault_get_journal_entry')!
      .handler({ date: '2020-01-01' }, { conversationId: null, windowId: null })
    expect(out).toBeNull()
  })

  it('vault_get_journal_entry returns entry for known date', async () => {
    const out = await tools
      .find((t) => t.name === 'vault_get_journal_entry')!
      .handler({ date: '2026-05-10' }, { conversationId: null, windowId: null })
    expect(out).toMatchObject({ id: 'j1', date: '2026-05-10' })
  })

  it('vault_list_journal_entries returns range', async () => {
    const out = (await tools
      .find((t) => t.name === 'vault_list_journal_entries')!
      .handler(
        { from: '2026-05-01', to: '2026-05-31' },
        { conversationId: null, windowId: null }
      )) as unknown[]
    expect(out).toHaveLength(1)
  })

  it('vault_list_inbox_items returns rows', async () => {
    const out = (await tools
      .find((t) => t.name === 'vault_list_inbox_items')!
      .handler({}, { conversationId: null, windowId: null })) as unknown[]
    expect(out).toHaveLength(1)
  })

  it('vault_get_tags returns tag counts', async () => {
    const out = (await tools
      .find((t) => t.name === 'vault_get_tags')!
      .handler({}, { conversationId: null, windowId: null })) as unknown[]
    expect(out).toEqual([{ name: 'todo', count: 3 }])
  })

  it('vault_get_current_note returns null when window header missing', async () => {
    const out = await tools
      .find((t) => t.name === 'vault_get_current_note')!
      .handler({}, { conversationId: null, windowId: null })
    expect(out).toBeNull()
  })

  it('vault_get_current_note delegates to windows.snapshotCurrentNote when window present', async () => {
    handles.windows.snapshotCurrentNote = async () => ({
      id: 'n1',
      title: 'Hit',
      content_markdown: '# Hit',
      tags: []
    })
    tools = buildReadTools(handles)
    const out = await tools
      .find((t) => t.name === 'vault_get_current_note')!
      .handler({}, { conversationId: null, windowId: 'win-1' })
    expect(out).toMatchObject({ id: 'n1', title: 'Hit' })
  })

  it('rejects an invalid input via Zod (bubbles VALIDATION error)', async () => {
    const t = tools.find((x) => x.name === 'vault_search_notes')!
    await expect(
      t.handler({ query: '' }, { conversationId: null, windowId: null })
    ).rejects.toBeInstanceOf(AgentToolError)
  })
})
```

- [ ] **Step 2: Run, see them fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/tools/__tests__/read-tools.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/agent/mcp/tools/read-tools.ts
import type { ZodTypeAny } from 'zod'

import { AgentToolError } from '../errors'
import type { ToolRegistration } from '../server'
import type { VaultServiceHandles } from './handles'
import { TOOL_SCHEMAS, READ_TOOL_NAMES } from './schemas'

function parse<T>(schema: ZodTypeAny, input: unknown): T {
  const r = schema.safeParse(input)
  if (!r.success) {
    throw new AgentToolError('VALIDATION', 'Invalid tool input', { issues: r.error.issues })
  }
  return r.data as T
}

export function buildReadTools(handles: VaultServiceHandles): ToolRegistration[] {
  const factories: Record<(typeof READ_TOOL_NAMES)[number], ToolRegistration> = {
    vault_search_notes: {
      name: 'vault_search_notes',
      description: TOOL_SCHEMAS.vault_search_notes.description,
      inputSchema: TOOL_SCHEMAS.vault_search_notes.input,
      handler: async (input) => {
        const a = parse<{ query: string; limit?: number; folder_id?: string }>(
          TOOL_SCHEMAS.vault_search_notes.input,
          input
        )
        return handles.notes.search({ query: a.query, limit: a.limit, folderId: a.folder_id })
      }
    },
    vault_read_note: {
      name: 'vault_read_note',
      description: TOOL_SCHEMAS.vault_read_note.description,
      inputSchema: TOOL_SCHEMAS.vault_read_note.input,
      handler: async (input) => {
        const a = parse<{ id: string }>(TOOL_SCHEMAS.vault_read_note.input, input)
        const note = await handles.notes.read(a.id)
        if (!note) throw new AgentToolError('NOT_FOUND', `Note ${a.id} not found`, { id: a.id })
        return note
      }
    },
    vault_list_folder: {
      name: 'vault_list_folder',
      description: TOOL_SCHEMAS.vault_list_folder.description,
      inputSchema: TOOL_SCHEMAS.vault_list_folder.input,
      handler: async (input) => {
        const a = parse<{ path?: string; id?: string; recursive?: boolean }>(
          TOOL_SCHEMAS.vault_list_folder.input,
          input
        )
        return handles.folders.list(a)
      }
    },
    vault_get_current_note: {
      name: 'vault_get_current_note',
      description: TOOL_SCHEMAS.vault_get_current_note.description,
      inputSchema: TOOL_SCHEMAS.vault_get_current_note.input,
      handler: async (_input, ctx) => {
        if (!ctx.windowId) return null
        return handles.windows.snapshotCurrentNote(ctx.windowId)
      }
    },
    vault_list_tasks: {
      name: 'vault_list_tasks',
      description: TOOL_SCHEMAS.vault_list_tasks.description,
      inputSchema: TOOL_SCHEMAS.vault_list_tasks.input,
      handler: async (input) => {
        const a = parse<{
          status?: string
          project_id?: string
          due_before?: string
          tag?: string
          limit?: number
        }>(TOOL_SCHEMAS.vault_list_tasks.input, input)
        return handles.tasks.list(a)
      }
    },
    vault_list_projects: {
      name: 'vault_list_projects',
      description: TOOL_SCHEMAS.vault_list_projects.description,
      inputSchema: TOOL_SCHEMAS.vault_list_projects.input,
      handler: async () => handles.projects.list()
    },
    vault_get_journal_entry: {
      name: 'vault_get_journal_entry',
      description: TOOL_SCHEMAS.vault_get_journal_entry.description,
      inputSchema: TOOL_SCHEMAS.vault_get_journal_entry.input,
      handler: async (input) => {
        const a = parse<{ date: string }>(TOOL_SCHEMAS.vault_get_journal_entry.input, input)
        return handles.journal.getByDate(a.date)
      }
    },
    vault_list_journal_entries: {
      name: 'vault_list_journal_entries',
      description: TOOL_SCHEMAS.vault_list_journal_entries.description,
      inputSchema: TOOL_SCHEMAS.vault_list_journal_entries.input,
      handler: async (input) => {
        const a = parse<{ from: string; to: string }>(
          TOOL_SCHEMAS.vault_list_journal_entries.input,
          input
        )
        return handles.journal.listInRange(a)
      }
    },
    vault_list_inbox_items: {
      name: 'vault_list_inbox_items',
      description: TOOL_SCHEMAS.vault_list_inbox_items.description,
      inputSchema: TOOL_SCHEMAS.vault_list_inbox_items.input,
      handler: async (input) => {
        const a = parse<{ unread_only?: boolean }>(TOOL_SCHEMAS.vault_list_inbox_items.input, input)
        return handles.inbox.list(a)
      }
    },
    vault_get_tags: {
      name: 'vault_get_tags',
      description: TOOL_SCHEMAS.vault_get_tags.description,
      inputSchema: TOOL_SCHEMAS.vault_get_tags.input,
      handler: async () => handles.tags.listAll()
    }
  }

  return READ_TOOL_NAMES.map((name) => factories[name])
}
```

- [ ] **Step 4: Run, see them pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/tools/__tests__/read-tools.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/mcp/tools/read-tools.ts apps/desktop/src/main/agent/mcp/tools/__tests__/read-tools.test.ts
git commit -m "feat(agent-mcp): implement all 10 read tools against VaultServiceHandles"
```

---

## Task 10: Write tools that always deny in P1 (P3 will inject the gate)

P1 still registers the create/update tools so external clients can see them and the Claude `--allowed-tools` list stays accurate. The handler returns `PERMISSION_DENIED` until P3 wires in an approval gate. Inputs are still parsed so the agent gets a `VALIDATION` error for malformed args.

**Files:**

- Create: `apps/desktop/src/main/agent/mcp/tools/write-tools.ts`
- Create: `apps/desktop/src/main/agent/mcp/tools/__tests__/write-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/src/main/agent/mcp/tools/__tests__/write-tools.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { buildWriteTools, type WriteToolGate } from '../write-tools'
import { WRITE_TOOL_NAMES } from '../schemas'
import type { VaultServiceHandles } from '../handles'

const handles: VaultServiceHandles = {
  notes: {
    search: async () => [],
    read: async () => null,
    create: async () => ({ id: 'created-note' }),
    update: async () => {},
    addTag: async () => {},
    removeTag: async () => {},
    moveToFolder: async () => {}
  },
  folders: { list: async () => [] },
  tasks: {
    list: async () => [],
    create: async () => ({ id: 'created-task' }),
    update: async () => {},
    addTag: async () => {},
    removeTag: async () => {}
  },
  projects: { list: async () => [] },
  journal: {
    getByDate: async () => null,
    listInRange: async () => [],
    createIfMissing: async () => ({ id: 'jrnl', created: true })
  },
  inbox: { list: async () => [], add: async () => ({ id: 'inbox' }) },
  tags: { listAll: async () => [] },
  windows: { snapshotCurrentNote: async () => null }
}

describe('Write tools — P1 deny-by-default', () => {
  let tools: ReturnType<typeof buildWriteTools>

  beforeEach(() => {
    tools = buildWriteTools(handles, null)
  })

  it('registers all 9 write tools', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...WRITE_TOOL_NAMES].sort())
  })

  it('returns PERMISSION_DENIED for vault_create_note when no gate is wired', async () => {
    const t = tools.find((x) => x.name === 'vault_create_note')!
    await expect(
      t.handler({ title: 't', content_markdown: 'body' }, { conversationId: null, windowId: null })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('returns PERMISSION_DENIED for every write tool with valid args and no gate', async () => {
    const valid: Record<string, unknown> = {
      vault_create_note: { title: 't', content_markdown: 'b' },
      vault_create_task: { title: 't' },
      vault_create_journal_entry: { date: '2026-05-10', content_markdown: 'b' },
      vault_add_to_inbox: { source: 'cli', title: 't', content: 'b' },
      vault_update_note: { id: 'x', mode: 'append', content_markdown: 'b' },
      vault_update_task: { id: 'x', title: 'new' },
      vault_add_tag: { id: 'x', kind: 'note', tag: 'a' },
      vault_remove_tag: { id: 'x', kind: 'note', tag: 'a' },
      vault_move_to_folder: { id: 'x', folder_path: '/Inbox' }
    }
    for (const t of tools) {
      await expect(
        t.handler(valid[t.name], { conversationId: null, windowId: null })
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    }
  })

  it('still rejects malformed args with VALIDATION before gating', async () => {
    const t = tools.find((x) => x.name === 'vault_create_note')!
    await expect(
      t.handler({ title: '' }, { conversationId: null, windowId: null })
    ).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('forwards to handles when a gate approves', async () => {
    const gate: WriteToolGate = async () => ({ approved: true, args: undefined })
    const withGate = buildWriteTools(handles, gate)
    const t = withGate.find((x) => x.name === 'vault_create_note')!
    const out = await t.handler(
      { title: 'x', content_markdown: 'y' },
      { conversationId: 'c1', windowId: 'w1' }
    )
    expect(out).toEqual({ id: 'created-note' })
  })

  it('lets the gate edit args before forwarding', async () => {
    let received: { title: string; content_markdown: string } | null = null
    const localHandles: VaultServiceHandles = {
      ...handles,
      notes: {
        ...handles.notes,
        create: async (input) => {
          received = input
          return { id: 'note-edited' }
        }
      }
    }
    const gate: WriteToolGate = async () => ({
      approved: true,
      args: { title: 'EDITED', content_markdown: 'EDITED-BODY' }
    })
    const withGate = buildWriteTools(localHandles, gate)
    const t = withGate.find((x) => x.name === 'vault_create_note')!
    await t.handler(
      { title: 'orig', content_markdown: 'orig' },
      { conversationId: 'c1', windowId: 'w1' }
    )
    expect(received).toEqual({ title: 'EDITED', content_markdown: 'EDITED-BODY' })
  })

  it('returns PERMISSION_DENIED when the gate denies', async () => {
    const gate: WriteToolGate = async () => ({ approved: false, reason: 'user denied' })
    const withGate = buildWriteTools(handles, gate)
    const t = withGate.find((x) => x.name === 'vault_create_note')!
    await expect(
      t.handler({ title: 't', content_markdown: 'b' }, { conversationId: 'c1', windowId: 'w1' })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })
})
```

- [ ] **Step 2: Run, see them fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/tools/__tests__/write-tools.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/agent/mcp/tools/write-tools.ts
import type { ZodTypeAny } from 'zod'

import { AgentToolError } from '../errors'
import type { ToolRegistration } from '../server'
import type { VaultServiceHandles } from './handles'
import { TOOL_SCHEMAS, WRITE_TOOL_NAMES, type ToolName } from './schemas'

export interface GateContext {
  conversationId: string
  windowId: string | null
  toolName: ToolName
  parsedArgs: unknown
}

export type WriteToolGate = (
  ctx: GateContext
) => Promise<{ approved: true; args?: unknown } | { approved: false; reason?: string }>

function parse<T>(schema: ZodTypeAny, input: unknown): T {
  const r = schema.safeParse(input)
  if (!r.success) {
    throw new AgentToolError('VALIDATION', 'Invalid tool input', { issues: r.error.issues })
  }
  return r.data as T
}

async function gateOrDeny(gate: WriteToolGate | null, ctx: GateContext): Promise<unknown> {
  if (!gate) {
    throw new AgentToolError(
      'PERMISSION_DENIED',
      'Write tools require an active Memry Agent conversation with an approval gate.'
    )
  }
  if (!ctx.conversationId) {
    throw new AgentToolError(
      'PERMISSION_DENIED',
      'Write tools require X-Memry-Conversation header.'
    )
  }
  const decision = await gate(ctx)
  if (!decision.approved) {
    throw new AgentToolError('PERMISSION_DENIED', decision.reason ?? 'User denied request.')
  }
  return decision.args ?? ctx.parsedArgs
}

export function buildWriteTools(
  handles: VaultServiceHandles,
  gate: WriteToolGate | null
): ToolRegistration[] {
  const factories: Record<(typeof WRITE_TOOL_NAMES)[number], ToolRegistration> = {
    vault_create_note: {
      name: 'vault_create_note',
      description: TOOL_SCHEMAS.vault_create_note.description,
      inputSchema: TOOL_SCHEMAS.vault_create_note.input,
      handler: async (input, ctx) => {
        const parsed = parse<{
          title: string
          content_markdown: string
          folder_path?: string
          tags?: string[]
        }>(TOOL_SCHEMAS.vault_create_note.input, input)
        const args = (await gateOrDeny(gate, {
          conversationId: ctx.conversationId ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_create_note',
          parsedArgs: parsed
        })) as typeof parsed
        return handles.notes.create(args)
      }
    },
    vault_create_task: {
      name: 'vault_create_task',
      description: TOOL_SCHEMAS.vault_create_task.description,
      inputSchema: TOOL_SCHEMAS.vault_create_task.input,
      handler: async (input, ctx) => {
        const parsed = parse<{
          title: string
          project_id?: string
          due?: string
          priority?: number
          tags?: string[]
          notes?: string
        }>(TOOL_SCHEMAS.vault_create_task.input, input)
        const args = (await gateOrDeny(gate, {
          conversationId: ctx.conversationId ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_create_task',
          parsedArgs: parsed
        })) as typeof parsed
        return handles.tasks.create(args)
      }
    },
    vault_create_journal_entry: {
      name: 'vault_create_journal_entry',
      description: TOOL_SCHEMAS.vault_create_journal_entry.description,
      inputSchema: TOOL_SCHEMAS.vault_create_journal_entry.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ date: string; content_markdown: string }>(
          TOOL_SCHEMAS.vault_create_journal_entry.input,
          input
        )
        const args = (await gateOrDeny(gate, {
          conversationId: ctx.conversationId ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_create_journal_entry',
          parsedArgs: parsed
        })) as typeof parsed
        return handles.journal.createIfMissing(args)
      }
    },
    vault_add_to_inbox: {
      name: 'vault_add_to_inbox',
      description: TOOL_SCHEMAS.vault_add_to_inbox.description,
      inputSchema: TOOL_SCHEMAS.vault_add_to_inbox.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ source: string; title: string; content: string }>(
          TOOL_SCHEMAS.vault_add_to_inbox.input,
          input
        )
        const args = (await gateOrDeny(gate, {
          conversationId: ctx.conversationId ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_add_to_inbox',
          parsedArgs: parsed
        })) as typeof parsed
        return handles.inbox.add(args)
      }
    },
    vault_update_note: {
      name: 'vault_update_note',
      description: TOOL_SCHEMAS.vault_update_note.description,
      inputSchema: TOOL_SCHEMAS.vault_update_note.input,
      handler: async (input, ctx) => {
        const parsed = parse<{
          id: string
          mode: 'append' | 'prepend' | 'replace'
          content_markdown: string
        }>(TOOL_SCHEMAS.vault_update_note.input, input)
        const args = (await gateOrDeny(gate, {
          conversationId: ctx.conversationId ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_update_note',
          parsedArgs: parsed
        })) as typeof parsed
        await handles.notes.update(args)
        return { id: args.id }
      }
    },
    vault_update_task: {
      name: 'vault_update_task',
      description: TOOL_SCHEMAS.vault_update_task.description,
      inputSchema: TOOL_SCHEMAS.vault_update_task.input,
      handler: async (input, ctx) => {
        const parsed = parse<{
          id: string
          title?: string
          status?: string
          project_id?: string | null
          due?: string | null
          priority?: number
          notes?: string
        }>(TOOL_SCHEMAS.vault_update_task.input, input)
        const args = (await gateOrDeny(gate, {
          conversationId: ctx.conversationId ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_update_task',
          parsedArgs: parsed
        })) as typeof parsed
        const { id, ...patch } = args
        await handles.tasks.update(id, patch)
        return { id }
      }
    },
    vault_add_tag: {
      name: 'vault_add_tag',
      description: TOOL_SCHEMAS.vault_add_tag.description,
      inputSchema: TOOL_SCHEMAS.vault_add_tag.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string; kind: 'note' | 'task'; tag: string }>(
          TOOL_SCHEMAS.vault_add_tag.input,
          input
        )
        const args = (await gateOrDeny(gate, {
          conversationId: ctx.conversationId ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_add_tag',
          parsedArgs: parsed
        })) as typeof parsed
        if (args.kind === 'note') await handles.notes.addTag({ id: args.id, tag: args.tag })
        else await handles.tasks.addTag({ id: args.id, tag: args.tag })
        return { id: args.id }
      }
    },
    vault_remove_tag: {
      name: 'vault_remove_tag',
      description: TOOL_SCHEMAS.vault_remove_tag.description,
      inputSchema: TOOL_SCHEMAS.vault_remove_tag.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string; kind: 'note' | 'task'; tag: string }>(
          TOOL_SCHEMAS.vault_remove_tag.input,
          input
        )
        const args = (await gateOrDeny(gate, {
          conversationId: ctx.conversationId ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_remove_tag',
          parsedArgs: parsed
        })) as typeof parsed
        if (args.kind === 'note') await handles.notes.removeTag({ id: args.id, tag: args.tag })
        else await handles.tasks.removeTag({ id: args.id, tag: args.tag })
        return { id: args.id }
      }
    },
    vault_move_to_folder: {
      name: 'vault_move_to_folder',
      description: TOOL_SCHEMAS.vault_move_to_folder.description,
      inputSchema: TOOL_SCHEMAS.vault_move_to_folder.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string; folder_path: string }>(
          TOOL_SCHEMAS.vault_move_to_folder.input,
          input
        )
        const args = (await gateOrDeny(gate, {
          conversationId: ctx.conversationId ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_move_to_folder',
          parsedArgs: parsed
        })) as typeof parsed
        await handles.notes.moveToFolder(args)
        return { id: args.id }
      }
    }
  }

  return WRITE_TOOL_NAMES.map((name) => factories[name])
}
```

- [ ] **Step 4: Run, see them pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/tools/__tests__/write-tools.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/mcp/tools/write-tools.ts apps/desktop/src/main/agent/mcp/tools/__tests__/write-tools.test.ts
git commit -m "feat(agent-mcp): register write tools (deny in P1, gateable for P3)"
```

---

## Task 11: Build adapter that maps real services to VaultServiceHandles

This task wires the production main-process services to the `VaultServiceHandles` shape. It's pure plumbing — it takes the existing exports identified in the codebase audit and adapts shapes/names.

**Files:**

- Create: `apps/desktop/src/main/agent/mcp/tools/handles-adapter.ts`

- [ ] **Step 1: Implement**

```ts
// apps/desktop/src/main/agent/mcp/tools/handles-adapter.ts
import type { Database } from 'better-sqlite3'

import { searchQueries } from '../../../search/store'
import { createNoteCommand, updateNoteCommand } from '../../../notes/domain'
import * as notesCrud from '../../../vault/notes-crud'
import * as folders from '../../../vault/folders'
import * as journalQueries from '../../../database/queries/notes'
import * as projectsQueries from '../../../database/queries/projects'
import * as tagsStore from '../../../tags/store'
import type { VaultServiceHandles } from './handles'
import { snapshotCurrentNoteFromWindow } from './current-note'

export interface AdapterDeps {
  dataDb: Database
  indexDb: Database
}

export function createVaultServiceHandles(deps: AdapterDeps): VaultServiceHandles {
  const { dataDb, indexDb } = deps

  return {
    notes: {
      async search({ query, limit, folderId }) {
        const result = await searchQueries.searchAll(indexDb, dataDb, {
          query,
          limit,
          folder_id: folderId
        })
        const notes = result.groups.find((g) => g.kind === 'notes')?.results ?? []
        return notes.map((r) => ({
          id: r.id,
          title: r.title,
          snippet: r.snippet ?? '',
          folder_path: r.folder_path ?? null
        }))
      },
      async read(id) {
        const note = await notesCrud.getNoteById(id)
        if (!note) return null
        return {
          id: note.id,
          title: note.title,
          content_markdown: note.content_markdown,
          tags: note.tags ?? [],
          folder_path: note.folder_path ?? null,
          frontmatter: note.frontmatter ?? {}
        }
      },
      async create(input) {
        const note = await createNoteCommand({
          title: input.title,
          content_markdown: input.content_markdown,
          folder_path: input.folder_path ?? null,
          tags: input.tags ?? []
        })
        return { id: note.id }
      },
      async update(input) {
        await updateNoteCommand({
          id: input.id,
          mode: input.mode,
          content_markdown: input.content_markdown
        })
      },
      async addTag({ id, tag }) {
        await notesCrud.addTagToNote(id, tag)
      },
      async removeTag({ id, tag }) {
        await notesCrud.removeTagFromNote(id, tag)
      },
      async moveToFolder({ id, folder_path }) {
        await notesCrud.moveNoteToFolder(id, folder_path)
      }
    },
    folders: {
      async list({ path, id, recursive }) {
        const cfg = await folders.readFolderConfig({ path, id, recursive: recursive ?? false })
        return cfg.entries.map((e) => ({
          kind: e.kind,
          id: e.id,
          name: e.name,
          path: e.path
        }))
      }
    },
    tasks: {
      async list(input) {
        const { listTasksForAgent } = await import('../../../tasks/runtime-effects')
        return listTasksForAgent(dataDb, input)
      },
      async create(input) {
        const { createTaskForAgent } = await import('../../../tasks/runtime-effects')
        return createTaskForAgent(dataDb, input)
      },
      async update(id, patch) {
        const { updateTaskForAgent } = await import('../../../tasks/runtime-effects')
        await updateTaskForAgent(dataDb, id, patch)
      },
      async addTag({ id, tag }) {
        const { addTaskTagForAgent } = await import('../../../tasks/runtime-effects')
        await addTaskTagForAgent(dataDb, id, tag)
      },
      async removeTag({ id, tag }) {
        const { removeTaskTagForAgent } = await import('../../../tasks/runtime-effects')
        await removeTaskTagForAgent(dataDb, id, tag)
      }
    },
    projects: {
      async list() {
        const all = await projectsQueries.getAllProjects(dataDb)
        return all.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status ?? null,
          task_count: p.taskCount ?? 0
        }))
      }
    },
    journal: {
      async getByDate(date) {
        const entry = await journalQueries.getJournalEntryByDate(dataDb, date)
        if (!entry) return null
        return { id: entry.id, date: entry.date, content_markdown: entry.content_markdown }
      },
      async listInRange({ from, to }) {
        const rows = await journalQueries.listJournalEntriesInRange(dataDb, from, to)
        return rows.map((r) => ({ id: r.id, date: r.date, title: r.title }))
      },
      async createIfMissing({ date, content_markdown }) {
        const existing = await journalQueries.getJournalEntryByDate(dataDb, date)
        if (existing) return { id: existing.id, created: false }
        const created = await createNoteCommand({
          title: date,
          content_markdown,
          frontmatter: { journal: true, date }
        })
        return { id: created.id, created: true }
      }
    },
    inbox: {
      async list({ unread_only }) {
        const { listInboxForAgent } = await import('../../../inbox/index')
        return listInboxForAgent(dataDb, { unread_only })
      },
      async add({ source, title, content }) {
        const { addInboxForAgent } = await import('../../../inbox/index')
        return addInboxForAgent(dataDb, { source, title, content })
      }
    },
    tags: {
      async listAll() {
        return tagsStore.getAllTagsWithCounts(indexDb, dataDb)
      }
    },
    windows: {
      async snapshotCurrentNote(windowId) {
        return snapshotCurrentNoteFromWindow(windowId)
      }
    }
  }
}
```

> **Note for the implementer:** The adapter references `listTasksForAgent`, `createTaskForAgent`, `updateTaskForAgent`, `addTaskTagForAgent`, `removeTaskTagForAgent` in `tasks/runtime-effects.ts` and `listInboxForAgent`, `addInboxForAgent` in `inbox/index.ts`. These thin facades likely don't exist yet because existing IPC handlers compose the equivalent inline. **Check first** — if they don't exist, add them as small functions next to the existing IPC handler in the same file (do not duplicate logic; call into the same domain functions the IPC handler uses, just without IPC ceremony). Same for `addTagToNote`, `removeTagFromNote`, `moveNoteToFolder`, `updateNoteCommand`, `listJournalEntriesInRange` — add the missing thin functions in their existing modules.

- [ ] **Step 2: Add missing thin facades as discovered**

For each `import { ... } from '../../../<module>'` that fails:

1. Open the referenced module
2. Locate the existing IPC handler that already does this work
3. Extract the handler's inner logic into a named export with the signature the adapter expects
4. Have the IPC handler call that export

Example pattern (for `addTagToNote`):

```ts
// apps/desktop/src/main/vault/notes-crud.ts
// Existing IPC handler is something like handleAddTagToNote(input) — extract its body:
export async function addTagToNote(noteId: string, tag: string): Promise<void> {
  const db = getDatabase()
  await db.transaction(async (tx) => {
    // ...existing body of the IPC handler
  })
  syncNoteUpdate(noteId, ['tags'])
}
```

Rule: never duplicate logic, never widen behavior — just expose what already exists under a callable name.

- [ ] **Step 3: Verify it typechecks**

Run: `pnpm --filter @memry/desktop exec tsc --noEmit -p tsconfig.node.json`
Expected: clean (modulo pre-existing test-file errors per CLAUDE.md known gotchas).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/agent/mcp/tools/handles-adapter.ts
git add $(git status --porcelain | awk '$1=="M"{print $2}' | grep -E 'src/main/(notes|tasks|inbox|vault|database/queries)')
git commit -m "feat(agent-mcp): adapt main-process services to VaultServiceHandles"
```

---

## Task 12: Renderer current-note IPC bridge

**Files:**

- Create: `apps/desktop/src/main/agent/mcp/tools/current-note.ts`
- Create: `apps/desktop/src/main/agent/mcp/tools/__tests__/current-note.test.ts`
- Modify: `packages/contracts/src/agent-mcp-channels.ts` (will be created in Task 16)

- [ ] **Step 1: Write failing test**

```ts
// apps/desktop/src/main/agent/mcp/tools/__tests__/current-note.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn() }
}))

import { BrowserWindow } from 'electron'
import { snapshotCurrentNoteFromWindow } from '../current-note'

describe('snapshotCurrentNoteFromWindow', () => {
  beforeEach(() => {
    vi.mocked(BrowserWindow.fromId).mockReset()
  })

  it('returns null when window id is invalid', async () => {
    vi.mocked(BrowserWindow.fromId).mockReturnValue(null)
    const out = await snapshotCurrentNoteFromWindow('123')
    expect(out).toBeNull()
  })

  it('returns null when window id is non-numeric', async () => {
    const out = await snapshotCurrentNoteFromWindow('not-a-number')
    expect(out).toBeNull()
  })

  it('asks the renderer via IPC and returns the snapshot', async () => {
    const send = vi.fn()
    const handler = vi.fn(async () => ({
      id: 'n1',
      title: 'X',
      content_markdown: '# X',
      tags: ['a']
    }))
    const fakeWindow = {
      webContents: {
        send,
        // Simulate ipcRenderer.invoke round-trip via a helper we install on webContents:
        invoke: handler
      }
    } as unknown as Electron.BrowserWindow
    vi.mocked(BrowserWindow.fromId).mockReturnValue(fakeWindow)

    const out = await snapshotCurrentNoteFromWindow('99')
    expect(out).toEqual({ id: 'n1', title: 'X', content_markdown: '# X', tags: ['a'] })
    expect(handler).toHaveBeenCalledWith('agent_mcp:get_current_note', undefined)
  })
})
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/tools/__tests__/current-note.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/agent/mcp/tools/current-note.ts
import { BrowserWindow } from 'electron'

import type { CurrentNoteSnapshot } from './handles'

export async function snapshotCurrentNoteFromWindow(
  windowId: string
): Promise<CurrentNoteSnapshot | null> {
  const numeric = Number(windowId)
  if (!Number.isInteger(numeric)) return null
  const win = BrowserWindow.fromId(numeric)
  if (!win) return null
  const wc = win.webContents as unknown as {
    invoke?: (channel: string, payload?: unknown) => Promise<CurrentNoteSnapshot | null>
  }
  if (typeof wc.invoke !== 'function') return null
  return wc.invoke('agent_mcp:get_current_note', undefined)
}
```

> **Note:** Electron's `webContents` does not natively support a renderer-to-main `invoke`-style callback request from main → renderer. This wrapper assumes a small helper installed during preload setup that listens for `agent_mcp:get_current_note` from main and responds via a `webContents.send` + Promise pair, OR that the codebase already has a `MainToRenderer.invoke()` utility (search `apps/desktop/src/main/lib` for `request` / `sendAndWait`). If neither exists, **create** a small `mainToRendererInvoke(channel, win, payload)` helper at `apps/desktop/src/main/lib/window-rpc.ts` (request-id correlation: send `{requestId, channel, payload}` via `webContents.send('main:invoke', ...)`, await reply via a one-shot `ipcMain.once` keyed by request id). Document it. The test above can target that helper directly instead.

- [ ] **Step 4: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/tools/__tests__/current-note.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/mcp/tools/current-note.ts apps/desktop/src/main/agent/mcp/tools/__tests__/current-note.test.ts apps/desktop/src/main/lib/window-rpc.ts
git commit -m "feat(agent-mcp): bridge vault.get_current_note to renderer via IPC"
```

---

## Task 13: Renderer-side handler for `agent_mcp:get_current_note`

**Files:**

- Create: `apps/desktop/src/renderer/src/agent-mcp/current-note-handler.ts`
- Modify: `apps/desktop/src/renderer/src/App.tsx` (mount the handler once)

- [ ] **Step 1: Implement the handler**

```ts
// apps/desktop/src/renderer/src/agent-mcp/current-note-handler.ts
import { useEffect } from 'react'

import { useActiveTab } from '../contexts/tabs/context'
import { extractMarkdownFromActiveEditor } from '../components/note/content-area/hooks/use-editor-sync'

interface MainInvokePayload {
  requestId: string
  channel: string
}

export function useAgentMcpCurrentNoteResponder(): void {
  const activeTab = useActiveTab()

  useEffect(() => {
    const off = window.api.onMainInvoke('main:invoke', async (payload: MainInvokePayload) => {
      if (payload.channel !== 'agent_mcp:get_current_note') return
      let response: { id: string; title: string; content_markdown: string; tags: string[] } | null =
        null
      if (activeTab && activeTab.kind === 'note' && activeTab.entityId) {
        const md = await extractMarkdownFromActiveEditor()
        response = {
          id: activeTab.entityId,
          title: activeTab.title,
          content_markdown: md ?? '',
          tags: []
        }
      }
      window.api.respondToMainInvoke(payload.requestId, response)
    })
    return () => {
      off?.()
    }
  }, [activeTab])
}
```

> **Note for the implementer:** `window.api.onMainInvoke` and `window.api.respondToMainInvoke` are companion preload bindings to the `mainToRendererInvoke` helper from Task 12. If you didn't add that helper, add the preload exposures here too (see preload index for the pattern of exposing IPC bridge methods). `extractMarkdownFromActiveEditor` is a thin helper to add inside `use-editor-sync.ts` that runs the existing block-to-markdown conversion against the currently mounted editor instance — if no editor is mounted, return `null`.

- [ ] **Step 2: Mount in App**

Add to `apps/desktop/src/renderer/src/App.tsx` at the top of the main `<AppContent />` (or wherever components are mounted unconditionally per app):

```tsx
import { useAgentMcpCurrentNoteResponder } from './agent-mcp/current-note-handler'
// ...inside AppContent:
useAgentMcpCurrentNoteResponder()
```

- [ ] **Step 3: Manual verification**

Boot the dev app (`pnpm dev`), open a note, and from a Node REPL with the bearer token, hit `vault_get_current_note` with `X-Memry-Window: <window id from devtools>`. Expected: returns `{ id, title, content_markdown }`. Hand off to Task 17 for the full E2E.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/agent-mcp/current-note-handler.ts apps/desktop/src/renderer/src/App.tsx apps/desktop/src/main/preload/index.ts apps/desktop/src/renderer/src/components/note/content-area/hooks/use-editor-sync.ts
git commit -m "feat(agent-mcp): renderer responder for current-note IPC bridge"
```

---

## Task 14: Lifecycle wiring — start/stop with the Electron app

**Files:**

- Create: `apps/desktop/src/main/agent/mcp/lifecycle.ts`
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Implement lifecycle module**

```ts
// apps/desktop/src/main/agent/mcp/lifecycle.ts
import { createLogger } from '../../lib/logger'
import { getDatabase, getIndexDatabase } from '../../database'
import { buildReadTools } from './tools/read-tools'
import { buildWriteTools, type WriteToolGate } from './tools/write-tools'
import { createVaultServiceHandles } from './tools/handles-adapter'
import { startAgentMcpServer, type AgentMcpServerHandle } from './server'

const logger = createLogger('AgentMcp:Lifecycle')

let handle: AgentMcpServerHandle | null = null
let writeGate: WriteToolGate | null = null

export interface PublicStatus {
  url: string | null
  token: string | null
  toolCount: number
}

export async function startAgentMcpLifecycle(): Promise<void> {
  if (handle) return
  const handles = createVaultServiceHandles({
    dataDb: getDatabase(),
    indexDb: getIndexDatabase()
  })
  const tools = [...buildReadTools(handles), ...buildWriteTools(handles, writeGate)]
  handle = await startAgentMcpServer({ toolRegistrations: tools })
  logger.info(`Agent MCP lifecycle started; ${tools.length} tools registered`)
}

export async function stopAgentMcpLifecycle(): Promise<void> {
  if (!handle) return
  await handle.stop()
  handle = null
}

export function getPublicStatus(): PublicStatus {
  if (!handle) return { url: null, token: null, toolCount: 0 }
  return { url: handle.url, token: handle.token, toolCount: 19 }
}

export function rotateToken(): string {
  if (!handle) throw new Error('Agent MCP server not running')
  return handle.rotateToken()
}

export function setWriteGate(gate: WriteToolGate | null): void {
  // P3 calls this to wire approval flow. P1: always null.
  writeGate = gate
  // Re-bind write tools so the gate change takes effect for the running server.
  if (!handle) return
  const handles = createVaultServiceHandles({
    dataDb: getDatabase(),
    indexDb: getIndexDatabase()
  })
  for (const t of buildWriteTools(handles, writeGate)) {
    handle.registerTool(t)
  }
}
```

- [ ] **Step 2: Wire into main entrypoint**

Edit `apps/desktop/src/main/index.ts`:

```ts
// Near the existing service-startup block (after databases are open and migrations applied):
import { startAgentMcpLifecycle, stopAgentMcpLifecycle } from './agent/mcp/lifecycle'

// After app.whenReady() services bootstrap:
await startAgentMcpLifecycle()

// In app.before-quit handler:
app.on('before-quit', async (event) => {
  // ...existing teardown...
  await stopAgentMcpLifecycle()
})
```

- [ ] **Step 3: Manual smoke test**

```bash
pnpm dev
# In another shell, after the app boots and you can see "Agent MCP server listening on http://127.0.0.1:NNNN" in the logs:
curl -i -H "Authorization: Bearer <token from logs>" http://127.0.0.1:NNNN/healthz
# Expected: HTTP/1.1 200 OK with body {"ok":true}
```

> **Note:** the bearer token is logged at info level for dev convenience. Before cutting a release, downgrade the token log line to debug-only.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/agent/mcp/lifecycle.ts apps/desktop/src/main/index.ts
git commit -m "feat(agent-mcp): start/stop server with electron app lifecycle"
```

---

## Task 15: Settings IPC channels for Agent MCP status / token rotation

**Files:**

- Create: `packages/contracts/src/agent-mcp-channels.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/desktop/src/main/ipc/agent-mcp-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/index.ts`
- Modify: `apps/desktop/src/main/preload/index.ts`

- [ ] **Step 1: Add contract**

```ts
// packages/contracts/src/agent-mcp-channels.ts
import { z } from 'zod'

export const AgentMcpChannels = {
  invoke: {
    GET_STATUS: 'agent_mcp:get_status',
    ROTATE_TOKEN: 'agent_mcp:rotate_token'
  }
} as const

export const AgentMcpStatusSchema = z.object({
  url: z.string().nullable(),
  token: z.string().nullable(),
  toolCount: z.number().int().nonnegative()
})
export type AgentMcpStatus = z.infer<typeof AgentMcpStatusSchema>
```

Add `export * from './agent-mcp-channels'` to `packages/contracts/src/index.ts`.

- [ ] **Step 2: Add main-process handler**

```ts
// apps/desktop/src/main/ipc/agent-mcp-handlers.ts
import { ipcMain } from 'electron'

import { AgentMcpChannels } from '@memry/contracts/agent-mcp-channels'
import { getPublicStatus, rotateToken } from '../agent/mcp/lifecycle'

export function registerAgentMcpHandlers(): void {
  ipcMain.handle(AgentMcpChannels.invoke.GET_STATUS, () => getPublicStatus())
  ipcMain.handle(AgentMcpChannels.invoke.ROTATE_TOKEN, () => {
    rotateToken()
    return getPublicStatus()
  })
}
```

Register in `apps/desktop/src/main/ipc/index.ts` (find the existing `register*Handlers()` block).

- [ ] **Step 3: Expose in preload**

In `apps/desktop/src/main/preload/index.ts`, add to the exposed `api`:

```ts
agentMcp: {
  getStatus: () => ipcRenderer.invoke(AgentMcpChannels.invoke.GET_STATUS),
  rotateToken: () => ipcRenderer.invoke(AgentMcpChannels.invoke.ROTATE_TOKEN)
}
```

- [ ] **Step 4: Generate IPC invoke map**

```bash
pnpm ipc:generate
pnpm ipc:check
```

Expected: invoke map updates, type-check passes.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/agent-mcp-channels.ts packages/contracts/src/index.ts \
  apps/desktop/src/main/ipc/agent-mcp-handlers.ts apps/desktop/src/main/ipc/index.ts \
  apps/desktop/src/main/preload/index.ts apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts
git commit -m "feat(agent-mcp): expose status + rotate-token IPC channels"
```

---

## Task 16: Settings panel UI — show URL, token, copy buttons, rotate

**Files:**

- Create: `apps/desktop/src/renderer/src/components/settings/agent-mcp-section.tsx`
- Modify: existing settings modal/page to include the new section (file is in `components/settings/`)

- [ ] **Step 1: Implement section**

```tsx
// apps/desktop/src/renderer/src/components/settings/agent-mcp-section.tsx
import { useEffect, useState } from 'react'

import type { AgentMcpStatus } from '@memry/contracts/agent-mcp-channels'
import { Button } from '@/components/ui/button'

export function AgentMcpSection(): JSX.Element {
  const [status, setStatus] = useState<AgentMcpStatus | null>(null)
  useEffect(() => {
    void window.api.agentMcp.getStatus().then(setStatus)
  }, [])

  if (!status) return <p className="text-sm text-muted-foreground">Loading…</p>

  return (
    <section className="ms-0 me-0 space-y-4">
      <header>
        <h3 className="text-base font-medium">Local MCP server</h3>
        <p className="text-sm text-muted-foreground">
          Read-only access from external clients (Cursor, Claude Desktop, Zed). Write tools require
          an active Memry Agent conversation. Token rotates on every app launch.
        </p>
      </header>

      <Field label="URL" value={status.url ?? '—'} />
      <Field label="Bearer token" value={status.token ?? '—'} mono />

      <Button
        size="sm"
        variant="secondary"
        onClick={async () => setStatus(await window.api.agentMcp.rotateToken())}
      >
        Rotate token
      </Button>
    </section>
  )
}

function Field({
  label,
  value,
  mono = false
}: {
  label: string
  value: string
  mono?: boolean
}): JSX.Element {
  return (
    <div className="flex items-start gap-2">
      <span className="text-sm text-muted-foreground w-32 shrink-0">{label}</span>
      <code className={`text-sm break-all ${mono ? 'font-mono' : ''}`}>{value}</code>
      <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(value)}>
        Copy
      </Button>
    </div>
  )
}
```

- [ ] **Step 2: Mount in settings**

Locate the settings modal section list (likely in `components/settings/settings-modal.tsx` or similar) and add a new entry for "Agent MCP" routing to `<AgentMcpSection />`.

- [ ] **Step 3: Manual verification**

Open settings → Agent MCP. URL and token visible, copy buttons work, rotate-token regenerates a new token and the displayed value updates.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/settings/agent-mcp-section.tsx \
  apps/desktop/src/renderer/src/components/settings/settings-modal.tsx
git commit -m "feat(agent-mcp): settings panel with URL, token, rotate button"
```

---

## Task 17: External-client smoke E2E — `tools/list` over the wire

This is the P1 acceptance test. It launches the Electron app via the existing Playwright harness, scrapes the bearer token from the settings panel, and exercises `tools/list` and a sample read tool with raw HTTP — no Claude binary involved.

**Files:**

- Create: `apps/desktop/tests/e2e/agent-mcp-external-client.e2e.ts`

- [ ] **Step 1: Pre-step — rebuild Electron native bindings**

```bash
bash apps/desktop/scripts/ensure-native.sh electron
```

Expected: better-sqlite3 builds for Electron's NODE_MODULE_VERSION. Skipping this is the #1 cause of E2E failures per CLAUDE.md.

- [ ] **Step 2: Build the desktop bundle**

```bash
pnpm --filter @memry/desktop exec electron-vite build
```

Expected: `apps/desktop/out/main/index.js` updates. E2E launches `out/`, not source — this build is required before every test run after source edits.

- [ ] **Step 3: Write the test**

```ts
// apps/desktop/tests/e2e/agent-mcp-external-client.e2e.ts
import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'

test.describe('Agent MCP external client', () => {
  let app: Awaited<ReturnType<typeof electron.launch>>
  let url: string
  let token: string

  test.beforeAll(async () => {
    app = await electron.launch({ args: [path.resolve('out/main/index.js')] })
    const window = await app.firstWindow()
    await window.waitForSelector('[data-testid="app-ready"]', { timeout: 30000 })
    // Read status via the renderer-exposed API
    const status = (await window.evaluate(() => (window as any).api.agentMcp.getStatus())) as {
      url: string
      token: string
    }
    url = status.url
    token = status.token
  })

  test.afterAll(async () => {
    await app.close()
  })

  test('lists 19 tools', async () => {
    const r = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    expect(r.status).toBe(200)
    const text = await r.text()
    expect(text).toContain('vault_search_notes')
    expect(text).toContain('vault_create_note')
    // Spot-check overall count via JSON parsing of SSE-formatted reply:
    const events = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice('data: '.length)))
    const toolsResponse = events.find((e) => e.id === 1)
    expect(toolsResponse?.result?.tools).toHaveLength(19)
  })

  test('write tools deny without conversation header', async () => {
    const r = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'vault_create_note',
          arguments: { title: 'Test', content_markdown: 'body' }
        }
      })
    })
    expect(r.status).toBe(200)
    const text = await r.text()
    expect(text).toContain('PERMISSION_DENIED')
  })

  test('rejects requests with the wrong bearer', async () => {
    const r = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer wrong`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    })
    expect(r.status).toBe(401)
  })
})
```

- [ ] **Step 4: Run the test**

```bash
pnpm --filter @memry/desktop test:e2e -- agent-mcp-external-client.e2e.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/tests/e2e/agent-mcp-external-client.e2e.ts
git commit -m "test(agent-mcp): external-client smoke e2e (tools/list + deny + auth)"
```

---

## Task 18: Run the full verify suite + docs check

- [ ] **Step 1: Run lint, typecheck, unit, e2e**

```bash
pnpm lint
pnpm typecheck:node && pnpm typecheck:web
pnpm --filter @memry/desktop test
pnpm test:e2e -- agent-mcp
```

Expected: all green (allowing pre-existing typecheck failures listed in CLAUDE.md "Known Gotchas" — `websocket.test.ts`, `folders.test.ts`, `sync-telemetry.ts`).

- [ ] **Step 2: Docs impact**

```bash
pnpm docs:impact
```

Expected: report mentions desktop changes affect docs. Then either:

```bash
pnpm docs:ai-update
# OR manually edit apps/docs/src/* to describe the MCP server, the bearer-token rotation, and how external clients connect
pnpm docs:impact --strict
pnpm docs:build
```

- [ ] **Step 3: Commit any docs**

```bash
git add apps/docs
git commit -m "docs: document agent MCP server (P1)"
```

---

## Final P1 deliverable checklist

- [ ] All 19 vault tools registered in the MCP server (10 read + 4 create + 5 update)
- [ ] Bearer-token auth, 401 on bad/missing token, in-memory only
- [ ] `vault.get_current_note` returns active note from named window or `null` for external clients
- [ ] All write tools return `PERMISSION_DENIED` until P3 supplies a gate
- [ ] Settings panel shows URL + token with copy and rotate
- [ ] External Cursor/Claude Desktop config can hit `tools/list` and read tools (manual verification documented)
- [ ] Server starts on app boot, stops on `before-quit`
- [ ] `pnpm test`, `pnpm test:e2e -- agent-mcp`, `pnpm lint`, `pnpm typecheck:node`, `pnpm typecheck:web` all green
- [ ] Docs updated

P1 ships as a useful artifact even before chat UI exists — the read tools work via any MCP client today.

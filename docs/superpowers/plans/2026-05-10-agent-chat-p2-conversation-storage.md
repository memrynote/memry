# Agent Chat — P2: Conversation Storage + Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist agent chat conversations and messages locally with encryption-at-rest, sync them across devices for paid users via two new sync item types (`agent_conversation`, `agent_message`), and gate sync enqueue on entitlement so free users keep the feature local-only.

**Architecture:** Two new tables in the data DB modeled on the existing sync-item shape (vector clock + soft-delete + timestamps). `agent_conversations` uses field-level merge (Phase-8 pattern) so title/pinned/trust_list mutate independently. `agent_messages` is append-only after terminal status. Body fields are encrypted with the existing libsodium primitives (`encrypt`/`decrypt`) wrapped in a small `encryptAgentJsonForVault`/`decryptAgentJsonForVault` helper that uses purpose-specific associated data. Two new handlers follow the established `SyncItemHandler` pattern. Entitlement check guards `enqueue()`; on upgrade a one-time backfill drains existing local rows.

**Tech Stack:** Drizzle ORM (already installed), better-sqlite3 (already installed), libsodium (already installed), Zod v4 (already installed), Vitest (already installed).

**Spec reference:** [`docs/superpowers/specs/2026-05-10-agent-chat-design.md`](../specs/2026-05-10-agent-chat-design.md) — Phase 2 section.

**Dependencies on prior phases:** None. Can land before P3 — this plan stops at handler-registry registration and verification tests; the chat UI wires actual mutations in P3.

---

## File Structure

**New files (this plan creates):**

| Path                                                                                    | Responsibility                                                                    |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/db-schema/src/schema/vault-metadata.ts`                                       | Singleton row holding stable vault UUID                                           |
| `packages/db-schema/src/schema/agent-conversations.ts`                                  | Drizzle schema for chat conversations                                             |
| `packages/db-schema/src/schema/agent-messages.ts`                                       | Drizzle schema for chat messages                                                  |
| `apps/desktop/src/main/database/drizzle-data/0029_agent_chat.sql`                       | Hand-written migration (post-0020 pattern)                                        |
| `apps/desktop/src/main/agent/storage/encryption.ts`                                     | `encryptAgentJsonForVault` / `decryptAgentJsonForVault`                           |
| `apps/desktop/src/main/agent/storage/vault-id.ts`                                       | Get-or-create stable vault UUID                                                   |
| `apps/desktop/src/main/agent/storage/conversation-store.ts`                             | CRUD on `agent_conversations` (encryption + field clocks)                         |
| `apps/desktop/src/main/agent/storage/message-store.ts`                                  | CRUD on `agent_messages` (encryption + append-only after terminal)                |
| `apps/desktop/src/main/agent/storage/types.ts`                                          | Shared TS types: `Conversation`, `Message`, `MessageContent`, `MessageAttachment` |
| `apps/desktop/src/main/sync/item-handlers/agent-conversation-handler.ts`                | Handler implementing field-level merge                                            |
| `apps/desktop/src/main/sync/item-handlers/agent-message-handler.ts`                     | Handler implementing append-only conflict resolution                              |
| `apps/desktop/src/main/sync/agent-conversation-fields.ts`                               | `AGENT_CONVERSATION_SYNCABLE_FIELDS` + merge helper                               |
| `apps/desktop/src/main/agent/sync/entitlement-gate.ts`                                  | Free vs paid check before `enqueue()`                                             |
| `apps/desktop/src/main/agent/sync/backfill.ts`                                          | One-shot backfill on entitlement upgrade                                          |
| `apps/desktop/src/main/agent/storage/__tests__/encryption.test.ts`                      | Round-trip + tamper detection                                                     |
| `apps/desktop/src/main/agent/storage/__tests__/conversation-store.test.ts`              | CRUD + field-clock advancement                                                    |
| `apps/desktop/src/main/agent/storage/__tests__/message-store.test.ts`                   | Append-only + terminal-status enforcement                                         |
| `apps/desktop/src/main/agent/storage/__tests__/vault-id.test.ts`                        | Get-or-create stability                                                           |
| `apps/desktop/src/main/sync/item-handlers/__tests__/agent-conversation-handler.test.ts` | Apply/merge/clock branches                                                        |
| `apps/desktop/src/main/sync/item-handlers/__tests__/agent-message-handler.test.ts`      | Idempotency + duplicate id behavior                                               |
| `apps/desktop/src/main/agent/sync/__tests__/entitlement-gate.test.ts`                   | Gate behavior                                                                     |
| `apps/desktop/src/main/agent/sync/__tests__/backfill.test.ts`                           | Backfill on upgrade                                                               |
| `apps/desktop/src/main/agent/storage/__tests__/at-rest-no-plaintext.test.ts`            | Disk forensic test                                                                |

**Files to modify:**

| Path                                                             | Why                                                                          |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/db-schema/src/data-schema.ts`                          | Re-export the three new schema files                                         |
| `apps/desktop/src/main/database/drizzle-data/meta/_journal.json` | Append entry for migration 0029                                              |
| `packages/contracts/src/sync-api.ts`                             | Add `agent_conversation` and `agent_message` to all relevant constant arrays |
| `apps/desktop/src/main/sync/item-handlers/index.ts`              | Register two new handlers in the registry map                                |

---

## Conventions

- **Logging:** `createLogger('AgentStorage')`, `createLogger('AgentConversationHandler')`, etc.
- **Field naming:** Drizzle camelCase TS / snake_case SQL (matches existing schema convention).
- **Encryption boundary:** every persisted JSON column is encrypted; `id`, `vaultId`, `backend`, `pinned`, `trustList` (tool-name list, no PII), and timestamps stay plaintext for indexing.
- **Migration:** hand-written SQL + journal entry (project switched away from generator after 0020 per project memory; current latest is 0028 so we add 0029).
- **Tests:** every task is TDD. DB-touching tests use a fresh in-memory `better-sqlite3` instance with migrations applied via the existing test-DB factory.

---

## Task 1: Vault metadata table for stable UUID

The desktop's vault identity is currently path-based. P2 needs a stable UUID so `agent_conversations.vault_id` survives folder moves and maps cleanly to the cloud `vaults.id`.

**Files:**

- Create: `packages/db-schema/src/schema/vault-metadata.ts`

- [ ] **Step 1: Add the schema**

```ts
// packages/db-schema/src/schema/vault-metadata.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const vaultMetadata = sqliteTable('vault_metadata', {
  // Singleton row: id is always 'singleton'.
  id: text('id').primaryKey(),
  // Stable vault UUID generated at first boot.
  vaultUuid: text('vault_uuid').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

export type VaultMetadata = typeof vaultMetadata.$inferSelect
```

- [ ] **Step 2: Re-export**

Edit `packages/db-schema/src/data-schema.ts` to add `export * from './schema/vault-metadata'`.

- [ ] **Step 3: Commit**

```bash
git add packages/db-schema/src/schema/vault-metadata.ts packages/db-schema/src/data-schema.ts
git commit -m "feat(db-schema): add vault_metadata singleton for stable vault UUID"
```

---

## Task 2: Drizzle schema for agent_conversations and agent_messages

**Files:**

- Create: `packages/db-schema/src/schema/agent-conversations.ts`
- Create: `packages/db-schema/src/schema/agent-messages.ts`

- [ ] **Step 1: Add agent_conversations**

```ts
// packages/db-schema/src/schema/agent-conversations.ts
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

export const agentConversations = sqliteTable(
  'agent_conversations',
  {
    id: text('id').primaryKey(),
    vaultId: text('vault_id').notNull(),

    // Encrypted: title may contain PII (first user message echoed). Stored as JSON envelope.
    titleCiphertext: text('title_ciphertext').notNull(),

    backend: text('backend').notNull(),
    // Plaintext list of tool names trusted for this conversation. No user data.
    trustList: text('trust_list').notNull().default('[]'),
    pinned: integer('pinned').notNull().default(0),

    vectorClock: text('vector_clock').notNull(),
    fieldClocks: text('field_clocks').notNull(),

    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
    lastSyncedAt: integer('last_synced_at')
  },
  (t) => ({
    byVault: index('agent_conversations_by_vault').on(t.vaultId),
    byUpdated: index('agent_conversations_by_updated').on(t.vaultId, t.updatedAt)
  })
)

export type AgentConversationRow = typeof agentConversations.$inferSelect
export type NewAgentConversationRow = typeof agentConversations.$inferInsert
```

- [ ] **Step 2: Add agent_messages**

```ts
// packages/db-schema/src/schema/agent-messages.ts
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

export const agentMessages = sqliteTable(
  'agent_messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    role: text('role').notNull(),

    // Encrypted JSON envelope: stringified MessageContent.
    contentCiphertext: text('content_ciphertext').notNull(),
    // Encrypted JSON envelope: stringified MessageAttachment[].
    attachmentsCiphertext: text('attachments_ciphertext').notNull(),

    toolCallId: text('tool_call_id'),
    status: text('status').notNull(),

    vectorClock: text('vector_clock').notNull(),

    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at')
  },
  (t) => ({
    byConversation: index('agent_messages_by_conversation').on(t.conversationId, t.createdAt)
  })
)

export type AgentMessageRow = typeof agentMessages.$inferSelect
export type NewAgentMessageRow = typeof agentMessages.$inferInsert
```

- [ ] **Step 3: Re-export from data-schema**

Edit `packages/db-schema/src/data-schema.ts`:

```ts
export * from './schema/agent-conversations'
export * from './schema/agent-messages'
```

- [ ] **Step 4: Commit**

```bash
git add packages/db-schema/src/schema/agent-conversations.ts \
  packages/db-schema/src/schema/agent-messages.ts \
  packages/db-schema/src/data-schema.ts
git commit -m "feat(db-schema): add agent_conversations and agent_messages tables"
```

---

## Task 3: Hand-written migration 0029

**Files:**

- Create: `apps/desktop/src/main/database/drizzle-data/0029_agent_chat.sql`
- Modify: `apps/desktop/src/main/database/drizzle-data/meta/_journal.json`

- [ ] **Step 1: Write the SQL**

```sql
-- 0029_agent_chat.sql
-- Adds vault metadata singleton + agent chat tables.
-- Hand-written (project switched off Drizzle generator after 0020).

CREATE TABLE IF NOT EXISTS `vault_metadata` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `vault_uuid` TEXT NOT NULL,
  `created_at` INTEGER NOT NULL,
  `updated_at` INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS `agent_conversations` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `vault_id` TEXT NOT NULL,
  `title_ciphertext` TEXT NOT NULL,
  `backend` TEXT NOT NULL,
  `trust_list` TEXT NOT NULL DEFAULT '[]',
  `pinned` INTEGER NOT NULL DEFAULT 0,
  `vector_clock` TEXT NOT NULL,
  `field_clocks` TEXT NOT NULL,
  `created_at` INTEGER NOT NULL,
  `updated_at` INTEGER NOT NULL,
  `deleted_at` INTEGER,
  `last_synced_at` INTEGER
);
CREATE INDEX IF NOT EXISTS `agent_conversations_by_vault`
  ON `agent_conversations` (`vault_id`);
CREATE INDEX IF NOT EXISTS `agent_conversations_by_updated`
  ON `agent_conversations` (`vault_id`, `updated_at`);

CREATE TABLE IF NOT EXISTS `agent_messages` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `conversation_id` TEXT NOT NULL,
  `role` TEXT NOT NULL,
  `content_ciphertext` TEXT NOT NULL,
  `attachments_ciphertext` TEXT NOT NULL,
  `tool_call_id` TEXT,
  `status` TEXT NOT NULL,
  `vector_clock` TEXT NOT NULL,
  `created_at` INTEGER NOT NULL,
  `updated_at` INTEGER NOT NULL,
  `deleted_at` INTEGER
);
CREATE INDEX IF NOT EXISTS `agent_messages_by_conversation`
  ON `agent_messages` (`conversation_id`, `created_at`);
```

- [ ] **Step 2: Append journal entry**

Open `apps/desktop/src/main/database/drizzle-data/meta/_journal.json`. Find the last `entries[]` element (currently `0028_calendar_source_last_error`); append after it:

```json
{
  "idx": 29,
  "version": "6",
  "when": <epoch ms at the time of the migration>,
  "tag": "0029_agent_chat",
  "breakpoints": true
}
```

Use `node -e "console.log(Date.now())"` to get the timestamp. Save the file.

- [ ] **Step 3: Apply migration to a fresh DB**

```bash
pnpm --filter @memry/desktop db:push
```

Expected: migration runs cleanly. New tables visible:

```bash
pnpm --filter @memry/desktop exec drizzle-kit studio --config config/drizzle-data.config.ts
# Browse to vault_metadata, agent_conversations, agent_messages
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/database/drizzle-data/0029_agent_chat.sql \
  apps/desktop/src/main/database/drizzle-data/meta/_journal.json
git commit -m "feat(db): migration 0029 for vault metadata + agent chat tables"
```

---

## Task 4: Vault UUID get-or-create

**Files:**

- Create: `apps/desktop/src/main/agent/storage/vault-id.ts`
- Create: `apps/desktop/src/main/agent/storage/__tests__/vault-id.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/desktop/src/main/agent/storage/__tests__/vault-id.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import Database from 'better-sqlite3'

import { getOrCreateVaultUuid } from '../vault-id'
import * as schema from '@memry/db-schema/data-schema'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE vault_metadata (
      id TEXT PRIMARY KEY,
      vault_uuid TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return drizzle(sqlite, { schema })
}

describe('getOrCreateVaultUuid', () => {
  let db: ReturnType<typeof freshDb>

  beforeEach(() => {
    db = freshDb()
  })

  it('creates a UUID on first call', async () => {
    const uuid = await getOrCreateVaultUuid(db)
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('returns the same UUID on subsequent calls', async () => {
    const a = await getOrCreateVaultUuid(db)
    const b = await getOrCreateVaultUuid(db)
    const c = await getOrCreateVaultUuid(db)
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it('only writes one row', async () => {
    await getOrCreateVaultUuid(db)
    await getOrCreateVaultUuid(db)
    const rows = db.select().from(schema.vaultMetadata).all()
    expect(rows).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/storage/__tests__/vault-id.test.ts`
Expected: FAIL — `../vault-id` missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/agent/storage/vault-id.ts
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'

const SINGLETON_ID = 'singleton'

export async function getOrCreateVaultUuid(
  db: BetterSQLite3Database<typeof schema>
): Promise<string> {
  const existing = db
    .select()
    .from(schema.vaultMetadata)
    .where(eq(schema.vaultMetadata.id, SINGLETON_ID))
    .get()
  if (existing) return existing.vaultUuid

  const uuid = randomUUID()
  const now = Date.now()
  db.insert(schema.vaultMetadata)
    .values({ id: SINGLETON_ID, vaultUuid: uuid, createdAt: now, updatedAt: now })
    .run()
  return uuid
}
```

- [ ] **Step 4: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/storage/__tests__/vault-id.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/storage/vault-id.ts apps/desktop/src/main/agent/storage/__tests__/vault-id.test.ts
git commit -m "feat(agent-storage): get-or-create stable vault UUID singleton"
```

---

## Task 5: Encryption helpers for at-rest JSON

**Files:**

- Create: `apps/desktop/src/main/agent/storage/encryption.ts`
- Create: `apps/desktop/src/main/agent/storage/__tests__/encryption.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/desktop/src/main/agent/storage/__tests__/encryption.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import sodium from 'libsodium-wrappers'

import {
  encryptAgentJsonForVault,
  decryptAgentJsonForVault,
  AGENT_AT_REST_VERSION
} from '../encryption'

describe('Agent at-rest encryption', () => {
  let vaultKey: Uint8Array

  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  it('round-trips a string', () => {
    const env = encryptAgentJsonForVault('hello world', vaultKey, 'agent_message_content')
    expect(env.version).toBe(AGENT_AT_REST_VERSION)
    expect(env.nonce).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(env.ciphertext).not.toContain('hello world')

    const back = decryptAgentJsonForVault(env, vaultKey, 'agent_message_content')
    expect(back).toBe('hello world')
  })

  it('rejects decryption with wrong associated data', () => {
    const env = encryptAgentJsonForVault('secret', vaultKey, 'agent_message_content')
    expect(() => decryptAgentJsonForVault(env, vaultKey, 'agent_attachments')).toThrow()
  })

  it('rejects decryption with tampered ciphertext', () => {
    const env = encryptAgentJsonForVault('secret', vaultKey, 'agent_message_content')
    const tampered = { ...env, ciphertext: env.ciphertext.replace(/[A-Z]/, 'A') }
    expect(() => decryptAgentJsonForVault(tampered, vaultKey, 'agent_message_content')).toThrow()
  })

  it('produces different ciphertexts for the same input (random nonce)', () => {
    const a = encryptAgentJsonForVault('x', vaultKey, 'agent_message_content')
    const b = encryptAgentJsonForVault('x', vaultKey, 'agent_message_content')
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(a.nonce).not.toBe(b.nonce)
  })

  it('serializes to a JSON-safe envelope', () => {
    const env = encryptAgentJsonForVault('x', vaultKey, 'agent_message_content')
    const serialized = JSON.stringify(env)
    const reparsed = JSON.parse(serialized)
    expect(decryptAgentJsonForVault(reparsed, vaultKey, 'agent_message_content')).toBe('x')
  })
})
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/storage/__tests__/encryption.test.ts`
Expected: FAIL — `../encryption` missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/agent/storage/encryption.ts
import sodium from 'libsodium-wrappers'

export const AGENT_AT_REST_VERSION = 1 as const

export type AgentAtRestPurpose =
  | 'agent_conversation_title'
  | 'agent_message_content'
  | 'agent_attachments'

export interface AgentEnvelope {
  version: typeof AGENT_AT_REST_VERSION
  nonce: string
  ciphertext: string
}

function ensureReady(): void {
  if (!sodium.ready) {
    // libsodium-wrappers initializes synchronously after the first await sodium.ready;
    // throwing here forces callers to call await sodium.ready upstream.
    throw new Error('libsodium not initialised; call await sodium.ready before encrypt/decrypt')
  }
}

function purposeAd(purpose: AgentAtRestPurpose): Uint8Array {
  return new TextEncoder().encode(`memry/${AGENT_AT_REST_VERSION}/${purpose}`)
}

export function encryptAgentJsonForVault(
  plaintext: string,
  vaultKey: Uint8Array,
  purpose: AgentAtRestPurpose
): AgentEnvelope {
  ensureReady()
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const ad = purposeAd(purpose)
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    sodium.from_string(plaintext),
    ad,
    null,
    nonce,
    vaultKey
  )
  return {
    version: AGENT_AT_REST_VERSION,
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL)
  }
}

export function decryptAgentJsonForVault(
  envelope: AgentEnvelope,
  vaultKey: Uint8Array,
  purpose: AgentAtRestPurpose
): string {
  ensureReady()
  if (envelope.version !== AGENT_AT_REST_VERSION) {
    throw new Error(`Unsupported agent envelope version: ${envelope.version}`)
  }
  const nonce = sodium.from_base64(envelope.nonce, sodium.base64_variants.ORIGINAL)
  const ciphertext = sodium.from_base64(envelope.ciphertext, sodium.base64_variants.ORIGINAL)
  const ad = purposeAd(purpose)
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    ad,
    nonce,
    vaultKey
  )
  return sodium.to_string(plaintext)
}
```

- [ ] **Step 4: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/storage/__tests__/encryption.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/storage/encryption.ts apps/desktop/src/main/agent/storage/__tests__/encryption.test.ts
git commit -m "feat(agent-storage): at-rest JSON envelope encryption with purpose-bound AD"
```

---

## Task 6: Shared types — Conversation, Message, Content, Attachment

**Files:**

- Create: `apps/desktop/src/main/agent/storage/types.ts`

- [ ] **Step 1: Implement**

```ts
// apps/desktop/src/main/agent/storage/types.ts
import { z } from 'zod'

export const MessageRoleSchema = z.enum(['user', 'assistant', 'tool_call', 'tool_result', 'system'])
export type MessageRole = z.infer<typeof MessageRoleSchema>

export const MessageStatusSchema = z.enum([
  'pending',
  'streaming',
  'completed',
  'cancelled',
  'error'
])
export type MessageStatus = z.infer<typeof MessageStatusSchema>
export const TERMINAL_STATUSES: ReadonlySet<MessageStatus> = new Set([
  'completed',
  'cancelled',
  'error'
])

export const UserContent = z.object({ text: z.string() })
export const AssistantContent = z.object({ text: z.string() })
export const ToolCallContent = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  status: z.enum(['pending', 'approved', 'denied', 'completed', 'failed']),
  approved_args: z.record(z.string(), z.unknown()).optional()
})
export const ToolResultContent = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional()
})
export const SystemContent = z.object({
  kind: z.enum(['context_attached', 'compacted', 'backend_changed']),
  payload: z.record(z.string(), z.unknown())
})

export const MessageContentSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), data: UserContent }),
  z.object({ role: z.literal('assistant'), data: AssistantContent }),
  z.object({ role: z.literal('tool_call'), data: ToolCallContent }),
  z.object({ role: z.literal('tool_result'), data: ToolResultContent }),
  z.object({ role: z.literal('system'), data: SystemContent })
])
export type MessageContent = z.infer<typeof MessageContentSchema>

export const AttachmentSnapshotSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('inline_note'),
    title: z.string(),
    content_markdown: z.string(),
    truncated: z.boolean()
  }),
  z.object({
    mode: z.literal('inline_journal'),
    date: z.string(),
    content_markdown: z.string(),
    truncated: z.boolean()
  }),
  z.object({
    mode: z.literal('inline_task'),
    title: z.string(),
    status: z.string(),
    due: z.string().optional(),
    project: z.string().optional(),
    notes: z.string().optional()
  }),
  z.object({
    mode: z.literal('inline_project'),
    name: z.string(),
    status: z.string().optional(),
    task_count: z.number().optional()
  }),
  z.object({
    mode: z.literal('reference_only'),
    path: z.string().optional(),
    id: z.string().optional()
  })
])

export const MessageAttachmentSchema = z.object({
  kind: z.enum(['note', 'folder', 'task', 'project', 'journal', 'current_note']),
  ref_id: z.string(),
  label: z.string(),
  snapshot_at: z.number(),
  snapshot: AttachmentSnapshotSchema
})
export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>

export const VectorClockSchema = z.record(z.string(), z.number())
export type VectorClock = z.infer<typeof VectorClockSchema>
export type FieldClocks = Record<string, VectorClock>

export interface Conversation {
  id: string
  vaultId: string
  title: string
  backend: string
  trustList: string[]
  pinned: boolean
  vectorClock: VectorClock
  fieldClocks: FieldClocks
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  lastSyncedAt: number | null
}

export interface Message {
  id: string
  conversationId: string
  role: MessageRole
  content: MessageContent
  toolCallId: string | null
  attachments: MessageAttachment[]
  status: MessageStatus
  vectorClock: VectorClock
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm --filter @memry/desktop exec tsc --noEmit -p tsconfig.node.json`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/agent/storage/types.ts
git commit -m "feat(agent-storage): conversation/message/attachment shared types"
```

---

## Task 7: Conversation store — encrypted CRUD with field clocks

**Files:**

- Create: `apps/desktop/src/main/sync/agent-conversation-fields.ts`
- Create: `apps/desktop/src/main/agent/storage/conversation-store.ts`
- Create: `apps/desktop/src/main/agent/storage/__tests__/conversation-store.test.ts`

- [ ] **Step 1: Define syncable fields**

```ts
// apps/desktop/src/main/sync/agent-conversation-fields.ts
export const AGENT_CONVERSATION_SYNCABLE_FIELDS = [
  'title',
  'backend',
  'trustList',
  'pinned'
] as const
export type AgentConversationField = (typeof AGENT_CONVERSATION_SYNCABLE_FIELDS)[number]
```

- [ ] **Step 2: Write failing test**

```ts
// apps/desktop/src/main/agent/storage/__tests__/conversation-store.test.ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import sodium from 'libsodium-wrappers'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'
import { createConversationStore } from '../conversation-store'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE agent_conversations (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      title_ciphertext TEXT NOT NULL,
      backend TEXT NOT NULL,
      trust_list TEXT NOT NULL DEFAULT '[]',
      pinned INTEGER NOT NULL DEFAULT 0,
      vector_clock TEXT NOT NULL,
      field_clocks TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      last_synced_at INTEGER
    );
  `)
  return drizzle(sqlite, { schema })
}

describe('Conversation store', () => {
  let vaultKey: Uint8Array
  let db: ReturnType<typeof freshDb>
  let store: ReturnType<typeof createConversationStore>

  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  beforeEach(() => {
    db = freshDb()
    store = createConversationStore({ db, vaultKey, deviceId: 'device-1' })
  })

  it('creates a conversation with encrypted title', async () => {
    const conv = await store.create({
      vaultId: 'vault-uuid',
      title: 'My new chat',
      backend: 'claude_cli'
    })
    expect(conv.id).toBeDefined()
    expect(conv.title).toBe('My new chat')
    expect(conv.backend).toBe('claude_cli')
    expect(conv.trustList).toEqual([])
    expect(conv.pinned).toBe(false)

    const raw = db
      .select({ titleCiphertext: schema.agentConversations.titleCiphertext })
      .from(schema.agentConversations)
      .all()[0]
    expect(raw.titleCiphertext).not.toContain('My new chat')
  })

  it('reads back a conversation by id and decrypts the title', async () => {
    const created = await store.create({
      vaultId: 'vault-uuid',
      title: 'Hello',
      backend: 'claude_cli'
    })
    const fetched = await store.getById(created.id)
    expect(fetched?.title).toBe('Hello')
  })

  it('lists conversations by vault, newest first', async () => {
    await store.create({ vaultId: 'v', title: 'Old', backend: 'claude_cli' })
    await new Promise((r) => setTimeout(r, 5))
    await store.create({ vaultId: 'v', title: 'New', backend: 'claude_cli' })
    const list = await store.listByVault('v')
    expect(list.map((c) => c.title)).toEqual(['New', 'Old'])
  })

  it('updates pinned status and bumps the field clock for pinned only', async () => {
    const c = await store.create({ vaultId: 'v', title: 'X', backend: 'claude_cli' })
    const before = c.fieldClocks
    const updated = await store.update(c.id, { pinned: true }, ['pinned'])
    expect(updated.pinned).toBe(true)
    expect(updated.fieldClocks.pinned['device-1']).toBe((before.pinned['device-1'] ?? 0) + 1)
    expect(updated.fieldClocks.title['device-1']).toBe(before.title['device-1'])
  })

  it('updates title and re-encrypts', async () => {
    const c = await store.create({ vaultId: 'v', title: 'A', backend: 'claude_cli' })
    const updated = await store.update(c.id, { title: 'B' }, ['title'])
    expect(updated.title).toBe('B')
    const refetched = await store.getById(c.id)
    expect(refetched?.title).toBe('B')
  })

  it('soft-deletes a conversation', async () => {
    const c = await store.create({ vaultId: 'v', title: 'X', backend: 'claude_cli' })
    await store.softDelete(c.id)
    const fetched = await store.getById(c.id)
    expect(fetched?.deletedAt).not.toBeNull()
  })

  it('addToTrustList is idempotent', async () => {
    const c = await store.create({ vaultId: 'v', title: 'X', backend: 'claude_cli' })
    await store.addToTrustList(c.id, 'vault_create_note')
    await store.addToTrustList(c.id, 'vault_create_note')
    const fetched = await store.getById(c.id)
    expect(fetched?.trustList).toEqual(['vault_create_note'])
  })
})
```

- [ ] **Step 3: Run, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/storage/__tests__/conversation-store.test.ts`
Expected: FAIL — `../conversation-store` missing.

- [ ] **Step 4: Implement**

```ts
// apps/desktop/src/main/agent/storage/conversation-store.ts
import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'

import { encryptAgentJsonForVault, decryptAgentJsonForVault } from './encryption'
import type { Conversation, FieldClocks, VectorClock } from './types'
import {
  AGENT_CONVERSATION_SYNCABLE_FIELDS,
  type AgentConversationField
} from '../../sync/agent-conversation-fields'

interface StoreDeps {
  db: BetterSQLite3Database<typeof schema>
  vaultKey: Uint8Array
  deviceId: string
}

export interface ConversationStore {
  create(input: { vaultId: string; title: string; backend: string }): Promise<Conversation>
  getById(id: string): Promise<Conversation | null>
  listByVault(vaultId: string, opts?: { includeDeleted?: boolean }): Promise<Conversation[]>
  update(
    id: string,
    patch: Partial<Pick<Conversation, 'title' | 'pinned' | 'backend' | 'trustList'>>,
    changedFields: AgentConversationField[]
  ): Promise<Conversation>
  softDelete(id: string): Promise<void>
  addToTrustList(id: string, toolName: string): Promise<void>
  removeFromTrustList(id: string, toolName: string): Promise<void>
}

function tickClock(clock: VectorClock, deviceId: string): VectorClock {
  return { ...clock, [deviceId]: (clock[deviceId] ?? 0) + 1 }
}

function tickFieldClocks(
  fieldClocks: FieldClocks,
  deviceId: string,
  fields: readonly AgentConversationField[]
): FieldClocks {
  const next = { ...fieldClocks }
  for (const field of fields) next[field] = tickClock(fieldClocks[field] ?? {}, deviceId)
  return next
}

function initFieldClocks(deviceId: string): FieldClocks {
  return Object.fromEntries(
    AGENT_CONVERSATION_SYNCABLE_FIELDS.map((field) => [field, { [deviceId]: 1 }])
  )
}

export function createConversationStore(deps: StoreDeps): ConversationStore {
  const { db, vaultKey, deviceId } = deps

  function rowToConversation(row: schema.AgentConversationRow): Conversation {
    const titleEnvelope = JSON.parse(row.titleCiphertext)
    return {
      id: row.id,
      vaultId: row.vaultId,
      title: decryptAgentJsonForVault(titleEnvelope, vaultKey, 'agent_conversation_title'),
      backend: row.backend,
      trustList: JSON.parse(row.trustList),
      pinned: row.pinned === 1,
      vectorClock: JSON.parse(row.vectorClock),
      fieldClocks: JSON.parse(row.fieldClocks),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
      lastSyncedAt: row.lastSyncedAt
    }
  }

  return {
    async create({ vaultId, title, backend }) {
      const id = randomUUID()
      const now = Date.now()
      const vectorClock = { [deviceId]: 1 }
      const fieldClocks = initFieldClocks(deviceId)
      const titleCiphertext = JSON.stringify(
        encryptAgentJsonForVault(title, vaultKey, 'agent_conversation_title')
      )

      db.insert(schema.agentConversations)
        .values({
          id,
          vaultId,
          titleCiphertext,
          backend,
          trustList: '[]',
          pinned: 0,
          vectorClock: JSON.stringify(vectorClock),
          fieldClocks: JSON.stringify(fieldClocks),
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          lastSyncedAt: null
        })
        .run()

      return {
        id,
        vaultId,
        title,
        backend,
        trustList: [],
        pinned: false,
        vectorClock,
        fieldClocks,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        lastSyncedAt: null
      }
    },

    async getById(id) {
      const row = db
        .select()
        .from(schema.agentConversations)
        .where(eq(schema.agentConversations.id, id))
        .get()
      return row ? rowToConversation(row) : null
    },

    async listByVault(vaultId, opts) {
      const where = opts?.includeDeleted
        ? eq(schema.agentConversations.vaultId, vaultId)
        : and(
            eq(schema.agentConversations.vaultId, vaultId),
            isNull(schema.agentConversations.deletedAt)
          )
      const rows = db
        .select()
        .from(schema.agentConversations)
        .where(where)
        .orderBy(desc(schema.agentConversations.updatedAt))
        .all()
      return rows.map(rowToConversation)
    },

    async update(id, patch, changedFields) {
      const existing = db
        .select()
        .from(schema.agentConversations)
        .where(eq(schema.agentConversations.id, id))
        .get()
      if (!existing) throw new Error(`Conversation ${id} not found`)

      const current = rowToConversation(existing)
      const next: Conversation = {
        ...current,
        ...patch,
        vectorClock: tickClock(current.vectorClock, deviceId),
        fieldClocks: tickFieldClocks(current.fieldClocks, deviceId, changedFields),
        updatedAt: Date.now()
      }

      const titleCiphertext =
        patch.title !== undefined
          ? JSON.stringify(
              encryptAgentJsonForVault(patch.title, vaultKey, 'agent_conversation_title')
            )
          : existing.titleCiphertext

      db.update(schema.agentConversations)
        .set({
          titleCiphertext,
          backend: next.backend,
          trustList: JSON.stringify(next.trustList),
          pinned: next.pinned ? 1 : 0,
          vectorClock: JSON.stringify(next.vectorClock),
          fieldClocks: JSON.stringify(next.fieldClocks),
          updatedAt: next.updatedAt
        })
        .where(eq(schema.agentConversations.id, id))
        .run()

      return next
    },

    async softDelete(id) {
      db.update(schema.agentConversations)
        .set({ deletedAt: Date.now(), updatedAt: Date.now() })
        .where(eq(schema.agentConversations.id, id))
        .run()
    },

    async addToTrustList(id, toolName) {
      const conv = await this.getById(id)
      if (!conv) throw new Error(`Conversation ${id} not found`)
      if (conv.trustList.includes(toolName)) return
      await this.update(id, { trustList: [...conv.trustList, toolName] }, ['trustList'])
    },

    async removeFromTrustList(id, toolName) {
      const conv = await this.getById(id)
      if (!conv) throw new Error(`Conversation ${id} not found`)
      if (!conv.trustList.includes(toolName)) return
      await this.update(id, { trustList: conv.trustList.filter((t) => t !== toolName) }, [
        'trustList'
      ])
    }
  }
}
```

- [ ] **Step 5: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/storage/__tests__/conversation-store.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/sync/agent-conversation-fields.ts \
  apps/desktop/src/main/agent/storage/conversation-store.ts \
  apps/desktop/src/main/agent/storage/__tests__/conversation-store.test.ts
git commit -m "feat(agent-storage): conversation CRUD with encrypted title + field clocks"
```

---

## Task 8: Message store — append-only with terminal-status enforcement

**Files:**

- Create: `apps/desktop/src/main/agent/storage/message-store.ts`
- Create: `apps/desktop/src/main/agent/storage/__tests__/message-store.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/desktop/src/main/agent/storage/__tests__/message-store.test.ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import sodium from 'libsodium-wrappers'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'
import { createMessageStore } from '../message-store'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_ciphertext TEXT NOT NULL,
      attachments_ciphertext TEXT NOT NULL,
      tool_call_id TEXT,
      status TEXT NOT NULL,
      vector_clock TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
  `)
  return drizzle(sqlite, { schema })
}

describe('Message store', () => {
  let vaultKey: Uint8Array
  let db: ReturnType<typeof freshDb>
  let store: ReturnType<typeof createMessageStore>

  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  beforeEach(() => {
    db = freshDb()
    store = createMessageStore({ db, vaultKey, deviceId: 'device-1' })
  })

  it('appends a user message', async () => {
    const m = await store.append({
      conversationId: 'conv-1',
      role: 'user',
      content: { role: 'user', data: { text: 'hi' } },
      attachments: [],
      status: 'completed'
    })
    expect(m.id).toBeDefined()
    expect(m.status).toBe('completed')

    const back = await store.getById(m.id)
    expect(back?.content).toEqual({ role: 'user', data: { text: 'hi' } })
  })

  it('encrypts the body on disk', async () => {
    await store.append({
      conversationId: 'c',
      role: 'user',
      content: { role: 'user', data: { text: 'PLAINTEXT' } },
      attachments: [],
      status: 'completed'
    })
    const raw = db.select().from(schema.agentMessages).all()[0]
    expect(raw.contentCiphertext).not.toContain('PLAINTEXT')
    expect(raw.attachmentsCiphertext).not.toContain('PLAINTEXT')
  })

  it('lists messages oldest → newest by createdAt', async () => {
    const a = await store.append({
      conversationId: 'c',
      role: 'user',
      content: { role: 'user', data: { text: 'first' } },
      attachments: [],
      status: 'completed'
    })
    await new Promise((r) => setTimeout(r, 5))
    const b = await store.append({
      conversationId: 'c',
      role: 'assistant',
      content: { role: 'assistant', data: { text: 'second' } },
      attachments: [],
      status: 'completed'
    })
    const list = await store.listByConversation('c')
    expect(list.map((m) => m.id)).toEqual([a.id, b.id])
  })

  it('streaming → completed updates allowed; double-terminal throws', async () => {
    const m = await store.append({
      conversationId: 'c',
      role: 'assistant',
      content: { role: 'assistant', data: { text: 'partial' } },
      attachments: [],
      status: 'streaming'
    })
    await store.updateStreaming(m.id, {
      content: { role: 'assistant', data: { text: 'partial+' } }
    })
    await store.markTerminal(m.id, 'completed', {
      content: { role: 'assistant', data: { text: 'final' } }
    })
    await expect(
      store.markTerminal(m.id, 'completed', {
        content: { role: 'assistant', data: { text: 'again' } }
      })
    ).rejects.toThrow(/already terminal/i)
  })

  it('updateStreaming on a terminal message throws', async () => {
    const m = await store.append({
      conversationId: 'c',
      role: 'assistant',
      content: { role: 'assistant', data: { text: 'final' } },
      attachments: [],
      status: 'completed'
    })
    await expect(
      store.updateStreaming(m.id, {
        content: { role: 'assistant', data: { text: 'tampered' } }
      })
    ).rejects.toThrow(/terminal/i)
  })
})
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/storage/__tests__/message-store.test.ts`
Expected: FAIL — `../message-store` missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/agent/storage/message-store.ts
import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'

import { encryptAgentJsonForVault, decryptAgentJsonForVault } from './encryption'
import {
  MessageContentSchema,
  MessageAttachmentSchema,
  TERMINAL_STATUSES,
  type Message,
  type MessageAttachment,
  type MessageContent,
  type MessageRole,
  type MessageStatus,
  type VectorClock
} from './types'

interface StoreDeps {
  db: BetterSQLite3Database<typeof schema>
  vaultKey: Uint8Array
  deviceId: string
}

export interface MessageStore {
  append(input: {
    conversationId: string
    role: MessageRole
    content: MessageContent
    attachments: MessageAttachment[]
    status: MessageStatus
    toolCallId?: string | null
    id?: string
  }): Promise<Message>
  getById(id: string): Promise<Message | null>
  listByConversation(conversationId: string): Promise<Message[]>
  updateStreaming(
    id: string,
    patch: { content?: MessageContent; attachments?: MessageAttachment[] }
  ): Promise<Message>
  markTerminal(
    id: string,
    status: Extract<MessageStatus, 'completed' | 'cancelled' | 'error'>,
    patch?: { content?: MessageContent; attachments?: MessageAttachment[] }
  ): Promise<Message>
}

function tickClock(clock: VectorClock, deviceId: string): VectorClock {
  return { ...clock, [deviceId]: (clock[deviceId] ?? 0) + 1 }
}

export function createMessageStore(deps: StoreDeps): MessageStore {
  const { db, vaultKey, deviceId } = deps

  function rowToMessage(row: schema.AgentMessageRow): Message {
    const contentEnv = JSON.parse(row.contentCiphertext)
    const attEnv = JSON.parse(row.attachmentsCiphertext)
    const contentJson = decryptAgentJsonForVault(contentEnv, vaultKey, 'agent_message_content')
    const attJson = decryptAgentJsonForVault(attEnv, vaultKey, 'agent_attachments')
    return {
      id: row.id,
      conversationId: row.conversationId,
      role: row.role as MessageRole,
      content: MessageContentSchema.parse(JSON.parse(contentJson)),
      toolCallId: row.toolCallId,
      attachments: MessageAttachmentSchema.array().parse(JSON.parse(attJson)),
      status: row.status as MessageStatus,
      vectorClock: JSON.parse(row.vectorClock),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt
    }
  }

  return {
    async append(input) {
      const id = input.id ?? randomUUID()
      const now = Date.now()
      const vectorClock = { [deviceId]: 1 }
      const contentCiphertext = JSON.stringify(
        encryptAgentJsonForVault(JSON.stringify(input.content), vaultKey, 'agent_message_content')
      )
      const attachmentsCiphertext = JSON.stringify(
        encryptAgentJsonForVault(JSON.stringify(input.attachments), vaultKey, 'agent_attachments')
      )

      db.insert(schema.agentMessages)
        .values({
          id,
          conversationId: input.conversationId,
          role: input.role,
          contentCiphertext,
          attachmentsCiphertext,
          toolCallId: input.toolCallId ?? null,
          status: input.status,
          vectorClock: JSON.stringify(vectorClock),
          createdAt: now,
          updatedAt: now,
          deletedAt: null
        })
        .run()

      return {
        id,
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        toolCallId: input.toolCallId ?? null,
        attachments: input.attachments,
        status: input.status,
        vectorClock,
        createdAt: now,
        updatedAt: now,
        deletedAt: null
      }
    },

    async getById(id) {
      const row = db
        .select()
        .from(schema.agentMessages)
        .where(eq(schema.agentMessages.id, id))
        .get()
      return row ? rowToMessage(row) : null
    },

    async listByConversation(conversationId) {
      const rows = db
        .select()
        .from(schema.agentMessages)
        .where(eq(schema.agentMessages.conversationId, conversationId))
        .orderBy(asc(schema.agentMessages.createdAt))
        .all()
      return rows.map(rowToMessage)
    },

    async updateStreaming(id, patch) {
      const existing = await this.getById(id)
      if (!existing) throw new Error(`Message ${id} not found`)
      if (TERMINAL_STATUSES.has(existing.status)) {
        throw new Error(`Cannot update terminal message ${id}`)
      }
      const next: Message = {
        ...existing,
        content: patch.content ?? existing.content,
        attachments: patch.attachments ?? existing.attachments,
        vectorClock: tickClock(existing.vectorClock, deviceId),
        updatedAt: Date.now()
      }
      writeRow(db, vaultKey, next)
      return next
    },

    async markTerminal(id, status, patch) {
      const existing = await this.getById(id)
      if (!existing) throw new Error(`Message ${id} not found`)
      if (TERMINAL_STATUSES.has(existing.status)) {
        throw new Error(`Message ${id} already terminal`)
      }
      const next: Message = {
        ...existing,
        content: patch?.content ?? existing.content,
        attachments: patch?.attachments ?? existing.attachments,
        status,
        vectorClock: tickClock(existing.vectorClock, deviceId),
        updatedAt: Date.now()
      }
      writeRow(db, vaultKey, next)
      return next
    }
  }
}

function writeRow(
  db: BetterSQLite3Database<typeof schema>,
  vaultKey: Uint8Array,
  m: Message
): void {
  const contentCiphertext = JSON.stringify(
    encryptAgentJsonForVault(JSON.stringify(m.content), vaultKey, 'agent_message_content')
  )
  const attachmentsCiphertext = JSON.stringify(
    encryptAgentJsonForVault(JSON.stringify(m.attachments), vaultKey, 'agent_attachments')
  )
  db.update(schema.agentMessages)
    .set({
      contentCiphertext,
      attachmentsCiphertext,
      status: m.status,
      vectorClock: JSON.stringify(m.vectorClock),
      updatedAt: m.updatedAt
    })
    .where(eq(schema.agentMessages.id, m.id))
    .run()
}
```

- [ ] **Step 4: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/storage/__tests__/message-store.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/storage/message-store.ts apps/desktop/src/main/agent/storage/__tests__/message-store.test.ts
git commit -m "feat(agent-storage): append-only message store with terminal-status guard"
```

---

## Task 9: Add agent types to sync-api constants

**Files:**

- Modify: `packages/contracts/src/sync-api.ts`

- [ ] **Step 1: Edit constant arrays**

Edit `packages/contracts/src/sync-api.ts`. Add `'agent_conversation'` and `'agent_message'` to:

- `SYNC_ITEM_TYPES`
- `RECORD_SYNC_ITEM_TYPES`
- `RECORD_CLOCK_REQUIRED_ITEM_TYPES` (both — agent_conversation and agent_message both have vector clocks)
- `ENCRYPTABLE_ITEM_TYPES`

Do **not** add to `CRDT_SYNC_ITEM_TYPES` (chat is not CRDT).

- [ ] **Step 2: Smoke test types**

Run: `pnpm --filter @memry/contracts test 2>&1 | head -30`
Run: `pnpm typecheck:node 2>&1 | tail -20`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/sync-api.ts
git commit -m "feat(contracts): register agent_conversation/agent_message sync item types"
```

---

## Task 10: AgentConversationHandler — field-level merge

**Files:**

- Create: `apps/desktop/src/main/sync/item-handlers/agent-conversation-handler.ts`
- Create: `apps/desktop/src/main/sync/item-handlers/__tests__/agent-conversation-handler.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/desktop/src/main/sync/item-handlers/__tests__/agent-conversation-handler.test.ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import sodium from 'libsodium-wrappers'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'
import { AgentConversationHandler } from '../agent-conversation-handler'
import { createConversationStore } from '../../../agent/storage/conversation-store'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE agent_conversations (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      title_ciphertext TEXT NOT NULL,
      backend TEXT NOT NULL,
      trust_list TEXT NOT NULL DEFAULT '[]',
      pinned INTEGER NOT NULL DEFAULT 0,
      vector_clock TEXT NOT NULL,
      field_clocks TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      last_synced_at INTEGER
    );
  `)
  return drizzle(sqlite, { schema })
}

describe('AgentConversationHandler', () => {
  let vaultKey: Uint8Array

  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  it('applies upsert when no local row exists', async () => {
    const db = freshDb()
    const handler = new AgentConversationHandler({ vaultKey })
    const ctx = { db, deviceId: 'device-2' }
    const remote = {
      id: 'c1',
      vaultId: 'v',
      title: 'Hello from remote',
      backend: 'claude_cli',
      trustList: [],
      pinned: false,
      fieldClocks: {
        title: { 'device-1': 1 },
        backend: { 'device-1': 1 },
        trustList: { 'device-1': 1 },
        pinned: { 'device-1': 1 }
      },
      createdAt: 1000,
      updatedAt: 1000
    }
    const result = await handler.applyUpsert(ctx, 'c1', remote, { 'device-1': 1 })
    expect(result).toBe('applied')

    const store = createConversationStore({ db, vaultKey, deviceId: 'device-2' })
    const back = await store.getById('c1')
    expect(back?.title).toBe('Hello from remote')
  })

  it('merges concurrent title and pinned edits', async () => {
    const db = freshDb()
    const handler = new AgentConversationHandler({ vaultKey })
    const store = createConversationStore({ db, vaultKey, deviceId: 'device-2' })

    // device-2 creates and edits pinned locally
    const local = await store.create({ vaultId: 'v', title: 'OldTitle', backend: 'claude_cli' })
    await store.update(local.id, { pinned: true }, ['pinned'])

    // device-1's parallel edit: title only
    const remote = {
      id: local.id,
      vaultId: 'v',
      title: 'NewTitleFromDevice1',
      backend: 'claude_cli',
      trustList: [],
      pinned: false,
      fieldClocks: {
        title: { 'device-1': 5 },
        backend: { 'device-1': 1 },
        trustList: { 'device-1': 1 },
        pinned: { 'device-1': 1 }
      },
      createdAt: local.createdAt,
      updatedAt: Date.now()
    }
    const result = await handler.applyUpsert({ db, deviceId: 'device-2' }, local.id, remote, {
      'device-1': 5
    })
    expect(result).toBe('applied')

    const merged = await store.getById(local.id)
    expect(merged?.title).toBe('NewTitleFromDevice1') // remote wins on title (higher tick)
    expect(merged?.pinned).toBe(true) // local wins on pinned (remote ticked from 1, local ticked to 2)
  })

  it('skips stale upserts', async () => {
    const db = freshDb()
    const handler = new AgentConversationHandler({ vaultKey })
    const store = createConversationStore({ db, vaultKey, deviceId: 'device-2' })

    const local = await store.create({ vaultId: 'v', title: 'Local', backend: 'claude_cli' })
    // bump local clock
    await store.update(local.id, { title: 'Local-v2' }, ['title'])
    await store.update(local.id, { title: 'Local-v3' }, ['title'])

    const stale = {
      id: local.id,
      vaultId: 'v',
      title: 'Stale',
      backend: 'claude_cli',
      trustList: [],
      pinned: false,
      fieldClocks: {
        title: { 'device-1': 1 },
        backend: { 'device-1': 1 },
        trustList: { 'device-1': 1 },
        pinned: { 'device-1': 1 }
      },
      createdAt: local.createdAt,
      updatedAt: 0
    }
    const result = await handler.applyUpsert({ db, deviceId: 'device-2' }, local.id, stale, {
      'device-1': 1
    })
    // Local clock dominates remote → skip
    expect(result).toBe('skipped')
  })

  it('applies delete (soft)', async () => {
    const db = freshDb()
    const handler = new AgentConversationHandler({ vaultKey })
    const store = createConversationStore({ db, vaultKey, deviceId: 'device-2' })

    const c = await store.create({ vaultId: 'v', title: 'X', backend: 'claude_cli' })
    const result = await handler.applyDelete({ db, deviceId: 'device-2' }, c.id, { 'device-1': 99 })
    expect(result).toBe('applied')

    const back = await store.getById(c.id)
    expect(back?.deletedAt).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/sync/item-handlers/__tests__/agent-conversation-handler.test.ts`
Expected: FAIL — `../agent-conversation-handler` missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/sync/item-handlers/agent-conversation-handler.ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'

import { encryptAgentJsonForVault, decryptAgentJsonForVault } from '../../agent/storage/encryption'
import type { Conversation, FieldClocks, VectorClock } from '../../agent/storage/types'
import {
  AGENT_CONVERSATION_SYNCABLE_FIELDS,
  type AgentConversationField
} from '../agent-conversation-fields'
import { resolveClockConflict } from './types'

export interface AgentConversationRemotePayload {
  id: string
  vaultId: string
  title: string
  backend: string
  trustList: string[]
  pinned: boolean
  fieldClocks: FieldClocks
  createdAt: number
  updatedAt: number
}

interface ApplyContext {
  db: BetterSQLite3Database<typeof schema>
  deviceId: string
}

interface HandlerDeps {
  vaultKey: Uint8Array
}

function tickSum(clock: VectorClock): number {
  let total = 0
  for (const v of Object.values(clock)) total += v
  return total
}

function pickFieldValue<T>(
  field: AgentConversationField,
  local: { value: T; clock: VectorClock },
  remote: { value: T; clock: VectorClock }
): { value: T; clock: VectorClock } {
  const cmp = resolveClockConflict(local.clock, remote.clock)
  if (cmp.action === 'skip') return local
  if (cmp.action === 'apply') return remote
  // merge: tie-break by higher total ticks; ties go to remote
  return tickSum(remote.clock) >= tickSum(local.clock) ? remote : local
}

export class AgentConversationHandler {
  constructor(private deps: HandlerDeps) {}

  async applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    remote: AgentConversationRemotePayload,
    remoteClock: VectorClock
  ): Promise<'applied' | 'skipped' | 'conflict' | 'parse_error'> {
    return ctx.db.transaction(() => {
      const existing = ctx.db
        .select()
        .from(schema.agentConversations)
        .where(eq(schema.agentConversations.id, itemId))
        .get()

      if (!existing) {
        const titleCiphertext = JSON.stringify(
          encryptAgentJsonForVault(remote.title, this.deps.vaultKey, 'agent_conversation_title')
        )
        ctx.db
          .insert(schema.agentConversations)
          .values({
            id: itemId,
            vaultId: remote.vaultId,
            titleCiphertext,
            backend: remote.backend,
            trustList: JSON.stringify(remote.trustList),
            pinned: remote.pinned ? 1 : 0,
            vectorClock: JSON.stringify(remoteClock),
            fieldClocks: JSON.stringify(remote.fieldClocks),
            createdAt: remote.createdAt,
            updatedAt: remote.updatedAt,
            deletedAt: null,
            lastSyncedAt: Date.now()
          })
          .run()
        return 'applied'
      }

      const localClock: VectorClock = JSON.parse(existing.vectorClock)
      const cmp = resolveClockConflict(localClock, remoteClock)
      if (cmp.action === 'skip') return 'skipped'

      const localFieldClocks: FieldClocks = JSON.parse(existing.fieldClocks)
      const localTitle = decryptAgentJsonForVault(
        JSON.parse(existing.titleCiphertext),
        this.deps.vaultKey,
        'agent_conversation_title'
      )
      const localPicks = {
        title: { value: localTitle, clock: localFieldClocks.title ?? {} },
        backend: { value: existing.backend, clock: localFieldClocks.backend ?? {} },
        trustList: {
          value: JSON.parse(existing.trustList) as string[],
          clock: localFieldClocks.trustList ?? {}
        },
        pinned: { value: existing.pinned === 1, clock: localFieldClocks.pinned ?? {} }
      }
      const remotePicks = {
        title: { value: remote.title, clock: remote.fieldClocks.title ?? {} },
        backend: { value: remote.backend, clock: remote.fieldClocks.backend ?? {} },
        trustList: { value: remote.trustList, clock: remote.fieldClocks.trustList ?? {} },
        pinned: { value: remote.pinned, clock: remote.fieldClocks.pinned ?? {} }
      }

      const merged = {
        title: pickFieldValue('title', localPicks.title, remotePicks.title),
        backend: pickFieldValue('backend', localPicks.backend, remotePicks.backend),
        trustList: pickFieldValue('trustList', localPicks.trustList, remotePicks.trustList),
        pinned: pickFieldValue('pinned', localPicks.pinned, remotePicks.pinned)
      }

      const mergedFieldClocks: FieldClocks = {
        title: merged.title.clock,
        backend: merged.backend.clock,
        trustList: merged.trustList.clock,
        pinned: merged.pinned.clock
      }
      void AGENT_CONVERSATION_SYNCABLE_FIELDS // exhaustiveness anchor

      const titleCiphertext = JSON.stringify(
        encryptAgentJsonForVault(merged.title.value, this.deps.vaultKey, 'agent_conversation_title')
      )

      ctx.db
        .update(schema.agentConversations)
        .set({
          titleCiphertext,
          backend: merged.backend.value,
          trustList: JSON.stringify(merged.trustList.value),
          pinned: merged.pinned.value ? 1 : 0,
          vectorClock: JSON.stringify(cmp.mergedClock),
          fieldClocks: JSON.stringify(mergedFieldClocks),
          updatedAt: Math.max(existing.updatedAt, remote.updatedAt),
          lastSyncedAt: Date.now()
        })
        .where(eq(schema.agentConversations.id, itemId))
        .run()
      return 'applied'
    })
  }

  async applyDelete(
    ctx: ApplyContext,
    itemId: string,
    _remoteClock: VectorClock
  ): Promise<'applied' | 'skipped'> {
    const existing = ctx.db
      .select()
      .from(schema.agentConversations)
      .where(eq(schema.agentConversations.id, itemId))
      .get()
    if (!existing) return 'skipped'
    if (existing.deletedAt !== null) return 'skipped'
    ctx.db
      .update(schema.agentConversations)
      .set({ deletedAt: Date.now(), updatedAt: Date.now() })
      .where(eq(schema.agentConversations.id, itemId))
      .run()
    return 'applied'
  }
}
```

> **Note for the implementer:** the imports `resolveClockConflict` from `./types` and the field-merge helpers should match the existing handler convention discovered in the codebase exploration (`apps/desktop/src/main/sync/item-handlers/types.ts`). If the registry interface differs (e.g. expects a method named `fetchLocal` or `seedUnclocked`), add stubs that match the contract — this plan's signatures cover the actual `applyUpsert` / `applyDelete` semantics.

- [ ] **Step 4: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/sync/item-handlers/__tests__/agent-conversation-handler.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/sync/item-handlers/agent-conversation-handler.ts apps/desktop/src/main/sync/item-handlers/__tests__/agent-conversation-handler.test.ts
git commit -m "feat(sync): AgentConversationHandler with field-level merge"
```

---

## Task 11: AgentMessageHandler — append-only with idempotent dupes

**Files:**

- Create: `apps/desktop/src/main/sync/item-handlers/agent-message-handler.ts`
- Create: `apps/desktop/src/main/sync/item-handlers/__tests__/agent-message-handler.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/desktop/src/main/sync/item-handlers/__tests__/agent-message-handler.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import sodium from 'libsodium-wrappers'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'
import { AgentMessageHandler } from '../agent-message-handler'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_ciphertext TEXT NOT NULL,
      attachments_ciphertext TEXT NOT NULL,
      tool_call_id TEXT,
      status TEXT NOT NULL,
      vector_clock TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
  `)
  return drizzle(sqlite, { schema })
}

describe('AgentMessageHandler', () => {
  let vaultKey: Uint8Array
  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  it('inserts an unseen message', async () => {
    const db = freshDb()
    const handler = new AgentMessageHandler({ vaultKey })
    const result = await handler.applyUpsert(
      { db, deviceId: 'd2' },
      'm1',
      {
        id: 'm1',
        conversationId: 'c1',
        role: 'user',
        content: { role: 'user', data: { text: 'hi' } },
        attachments: [],
        status: 'completed',
        toolCallId: null,
        createdAt: 1000,
        updatedAt: 1000
      },
      { d1: 1 }
    )
    expect(result).toBe('applied')
    const rows = db.select().from(schema.agentMessages).all()
    expect(rows).toHaveLength(1)
  })

  it('is idempotent on duplicate id with same payload', async () => {
    const db = freshDb()
    const handler = new AgentMessageHandler({ vaultKey })
    const payload = {
      id: 'm1',
      conversationId: 'c1',
      role: 'user' as const,
      content: { role: 'user' as const, data: { text: 'hi' } },
      attachments: [],
      status: 'completed' as const,
      toolCallId: null,
      createdAt: 1000,
      updatedAt: 1000
    }
    await handler.applyUpsert({ db, deviceId: 'd2' }, 'm1', payload, { d1: 1 })
    const result = await handler.applyUpsert({ db, deviceId: 'd2' }, 'm1', payload, { d1: 1 })
    expect(result).toBe('skipped')
  })

  it('returns conflict when same id but different content', async () => {
    const db = freshDb()
    const handler = new AgentMessageHandler({ vaultKey })
    await handler.applyUpsert(
      { db, deviceId: 'd2' },
      'm1',
      {
        id: 'm1',
        conversationId: 'c1',
        role: 'user',
        content: { role: 'user', data: { text: 'first' } },
        attachments: [],
        status: 'completed',
        toolCallId: null,
        createdAt: 1000,
        updatedAt: 1000
      },
      { d1: 1 }
    )
    const result = await handler.applyUpsert(
      { db, deviceId: 'd2' },
      'm1',
      {
        id: 'm1',
        conversationId: 'c1',
        role: 'user',
        content: { role: 'user', data: { text: 'DIFFERENT' } },
        attachments: [],
        status: 'completed',
        toolCallId: null,
        createdAt: 1000,
        updatedAt: 2000
      },
      { d1: 2 }
    )
    expect(result).toBe('conflict')
  })

  it('soft-deletes', async () => {
    const db = freshDb()
    const handler = new AgentMessageHandler({ vaultKey })
    await handler.applyUpsert(
      { db, deviceId: 'd2' },
      'm1',
      {
        id: 'm1',
        conversationId: 'c1',
        role: 'user',
        content: { role: 'user', data: { text: 'x' } },
        attachments: [],
        status: 'completed',
        toolCallId: null,
        createdAt: 1000,
        updatedAt: 1000
      },
      { d1: 1 }
    )
    const r = await handler.applyDelete({ db, deviceId: 'd2' }, 'm1', { d1: 99 })
    expect(r).toBe('applied')
  })
})
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/sync/item-handlers/__tests__/agent-message-handler.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/sync/item-handlers/agent-message-handler.ts
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'

import { encryptAgentJsonForVault, decryptAgentJsonForVault } from '../../agent/storage/encryption'
import { createLogger } from '../../lib/logger'
import type {
  MessageAttachment,
  MessageContent,
  MessageRole,
  MessageStatus,
  VectorClock
} from '../../agent/storage/types'

const logger = createLogger('AgentMessageHandler')

export interface AgentMessageRemotePayload {
  id: string
  conversationId: string
  role: MessageRole
  content: MessageContent
  attachments: MessageAttachment[]
  status: MessageStatus
  toolCallId: string | null
  createdAt: number
  updatedAt: number
}

interface ApplyContext {
  db: BetterSQLite3Database<typeof schema>
  deviceId: string
}

interface HandlerDeps {
  vaultKey: Uint8Array
}

function payloadHash(p: AgentMessageRemotePayload): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: p.id,
        conversationId: p.conversationId,
        role: p.role,
        content: p.content,
        attachments: p.attachments,
        status: p.status,
        toolCallId: p.toolCallId
      })
    )
    .digest('hex')
}

export class AgentMessageHandler {
  constructor(private deps: HandlerDeps) {}

  async applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    remote: AgentMessageRemotePayload,
    remoteClock: VectorClock
  ): Promise<'applied' | 'skipped' | 'conflict' | 'parse_error'> {
    return ctx.db.transaction(() => {
      const existing = ctx.db
        .select()
        .from(schema.agentMessages)
        .where(eq(schema.agentMessages.id, itemId))
        .get()

      const contentCiphertext = JSON.stringify(
        encryptAgentJsonForVault(
          JSON.stringify(remote.content),
          this.deps.vaultKey,
          'agent_message_content'
        )
      )
      const attachmentsCiphertext = JSON.stringify(
        encryptAgentJsonForVault(
          JSON.stringify(remote.attachments),
          this.deps.vaultKey,
          'agent_attachments'
        )
      )

      if (!existing) {
        ctx.db
          .insert(schema.agentMessages)
          .values({
            id: itemId,
            conversationId: remote.conversationId,
            role: remote.role,
            contentCiphertext,
            attachmentsCiphertext,
            toolCallId: remote.toolCallId,
            status: remote.status,
            vectorClock: JSON.stringify(remoteClock),
            createdAt: remote.createdAt,
            updatedAt: remote.updatedAt,
            deletedAt: null
          })
          .run()
        return 'applied'
      }

      // Idempotent: identical payload → skip
      const existingContentEnv = JSON.parse(existing.contentCiphertext)
      const existingAttEnv = JSON.parse(existing.attachmentsCiphertext)
      const existingContent = JSON.parse(
        decryptAgentJsonForVault(existingContentEnv, this.deps.vaultKey, 'agent_message_content')
      )
      const existingAtt = JSON.parse(
        decryptAgentJsonForVault(existingAttEnv, this.deps.vaultKey, 'agent_attachments')
      )
      const existingPayload: AgentMessageRemotePayload = {
        id: existing.id,
        conversationId: existing.conversationId,
        role: existing.role as MessageRole,
        content: existingContent,
        attachments: existingAtt,
        status: existing.status as MessageStatus,
        toolCallId: existing.toolCallId,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt
      }
      if (payloadHash(existingPayload) === payloadHash(remote)) return 'skipped'

      // Different payload for same id → conflict, log + quarantine.
      logger.warn(`Message id ${itemId} already exists with different payload; quarantining`)
      return 'conflict'
    })
  }

  async applyDelete(
    ctx: ApplyContext,
    itemId: string,
    _remoteClock: VectorClock
  ): Promise<'applied' | 'skipped'> {
    const existing = ctx.db
      .select()
      .from(schema.agentMessages)
      .where(eq(schema.agentMessages.id, itemId))
      .get()
    if (!existing) return 'skipped'
    if (existing.deletedAt !== null) return 'skipped'
    ctx.db
      .update(schema.agentMessages)
      .set({ deletedAt: Date.now(), updatedAt: Date.now() })
      .where(eq(schema.agentMessages.id, itemId))
      .run()
    return 'applied'
  }
}
```

- [ ] **Step 4: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/sync/item-handlers/__tests__/agent-message-handler.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/sync/item-handlers/agent-message-handler.ts apps/desktop/src/main/sync/item-handlers/__tests__/agent-message-handler.test.ts
git commit -m "feat(sync): AgentMessageHandler append-only with conflict quarantine"
```

---

## Task 12: Register handlers in the registry

**Files:**

- Modify: `apps/desktop/src/main/sync/item-handlers/index.ts`

- [ ] **Step 1: Edit the registry**

Open `apps/desktop/src/main/sync/item-handlers/index.ts` and add to the handler map:

```ts
import { AgentConversationHandler } from './agent-conversation-handler'
import { AgentMessageHandler } from './agent-message-handler'
import { getVaultKey } from '../../crypto/vault-key' // existing helper; rename if codebase uses a different name

// ...inside the map construction (after other handler entries):
;(['agent_conversation', new AgentConversationHandler({ vaultKey: getVaultKey() })],
  ['agent_message', new AgentMessageHandler({ vaultKey: getVaultKey() })])
```

> **Note:** if `getVaultKey()` doesn't exist by that exact name, find the singleton accessor used by other crypto-aware code (e.g. `loadVaultKey()` or `keychain.current()`). All sync handlers in this project run inside the main process; the vault key is already loaded by the time handlers are constructed.

- [ ] **Step 2: Verify the registry test (if one exists) still passes**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/sync/item-handlers`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/sync/item-handlers/index.ts
git commit -m "feat(sync): register agent_conversation + agent_message handlers"
```

---

## Task 13: Entitlement gate before enqueue

**Files:**

- Create: `apps/desktop/src/main/agent/sync/entitlement-gate.ts`
- Create: `apps/desktop/src/main/agent/sync/__tests__/entitlement-gate.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/desktop/src/main/agent/sync/__tests__/entitlement-gate.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createAgentSyncEntitlementGate } from '../entitlement-gate'

describe('Agent sync entitlement gate', () => {
  it('does not enqueue for free users', async () => {
    const enqueue = vi.fn()
    const gate = createAgentSyncEntitlementGate({ isPaid: () => false, enqueue })
    await gate.maybeEnqueue({ type: 'agent_message', id: 'm1' })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('enqueues for paid users', async () => {
    const enqueue = vi.fn()
    const gate = createAgentSyncEntitlementGate({ isPaid: () => true, enqueue })
    await gate.maybeEnqueue({ type: 'agent_message', id: 'm1' })
    expect(enqueue).toHaveBeenCalledWith({ type: 'agent_message', id: 'm1' })
  })

  it('reads entitlement at the moment of enqueue (not at gate creation)', async () => {
    const enqueue = vi.fn()
    let isPaid = false
    const gate = createAgentSyncEntitlementGate({ isPaid: () => isPaid, enqueue })
    await gate.maybeEnqueue({ type: 'agent_message', id: 'm1' })
    expect(enqueue).not.toHaveBeenCalled()
    isPaid = true
    await gate.maybeEnqueue({ type: 'agent_message', id: 'm2' })
    expect(enqueue).toHaveBeenCalledWith({ type: 'agent_message', id: 'm2' })
  })
})
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/sync/__tests__/entitlement-gate.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/agent/sync/entitlement-gate.ts
export interface EnqueueRequest {
  type: 'agent_conversation' | 'agent_message'
  id: string
}

export interface EntitlementGate {
  maybeEnqueue(req: EnqueueRequest): Promise<void>
}

interface Deps {
  isPaid: () => boolean
  enqueue: (req: EnqueueRequest) => void | Promise<void>
}

export function createAgentSyncEntitlementGate(deps: Deps): EntitlementGate {
  return {
    async maybeEnqueue(req) {
      if (!deps.isPaid()) return
      await deps.enqueue(req)
    }
  }
}
```

- [ ] **Step 4: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/sync/__tests__/entitlement-gate.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/sync/entitlement-gate.ts apps/desktop/src/main/agent/sync/__tests__/entitlement-gate.test.ts
git commit -m "feat(agent-sync): entitlement gate gates chat enqueue on paid status"
```

---

## Task 14: Free → paid backfill helper

**Files:**

- Create: `apps/desktop/src/main/agent/sync/backfill.ts`
- Create: `apps/desktop/src/main/agent/sync/__tests__/backfill.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/desktop/src/main/agent/sync/__tests__/backfill.test.ts
import { describe, it, expect, beforeAll, vi } from 'vitest'
import sodium from 'libsodium-wrappers'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'
import { createConversationStore } from '../../storage/conversation-store'
import { createMessageStore } from '../../storage/message-store'
import { backfillAgentChatRows } from '../backfill'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE agent_conversations (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      title_ciphertext TEXT NOT NULL,
      backend TEXT NOT NULL,
      trust_list TEXT NOT NULL DEFAULT '[]',
      pinned INTEGER NOT NULL DEFAULT 0,
      vector_clock TEXT NOT NULL,
      field_clocks TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      last_synced_at INTEGER
    );
    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_ciphertext TEXT NOT NULL,
      attachments_ciphertext TEXT NOT NULL,
      tool_call_id TEXT,
      status TEXT NOT NULL,
      vector_clock TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
  `)
  return drizzle(sqlite, { schema })
}

describe('backfillAgentChatRows', () => {
  let vaultKey: Uint8Array
  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  it('enqueues every conversation and terminal message', async () => {
    const db = freshDb()
    const cStore = createConversationStore({ db, vaultKey, deviceId: 'd1' })
    const mStore = createMessageStore({ db, vaultKey, deviceId: 'd1' })

    const c1 = await cStore.create({ vaultId: 'v', title: 'A', backend: 'claude_cli' })
    const c2 = await cStore.create({ vaultId: 'v', title: 'B', backend: 'claude_cli' })
    await mStore.append({
      conversationId: c1.id,
      role: 'user',
      content: { role: 'user', data: { text: 'hi' } },
      attachments: [],
      status: 'completed'
    })
    await mStore.append({
      conversationId: c1.id,
      role: 'assistant',
      content: { role: 'assistant', data: { text: 'hello' } },
      attachments: [],
      status: 'streaming' // non-terminal — should NOT be backfilled
    })
    await mStore.append({
      conversationId: c2.id,
      role: 'user',
      content: { role: 'user', data: { text: 'x' } },
      attachments: [],
      status: 'completed'
    })

    const enqueue = vi.fn()
    const onProgress = vi.fn()
    await backfillAgentChatRows({
      db,
      vaultId: 'v',
      enqueue,
      onProgress
    })

    const calls = enqueue.mock.calls.map((c) => c[0])
    const convs = calls.filter((x) => x.type === 'agent_conversation').map((x) => x.id)
    const msgs = calls.filter((x) => x.type === 'agent_message').map((x) => x.id)
    expect(convs.sort()).toEqual([c1.id, c2.id].sort())
    expect(msgs).toHaveLength(2) // streaming excluded
    expect(onProgress).toHaveBeenCalled()
  })

  it('reports progress with done/total', async () => {
    const db = freshDb()
    const cStore = createConversationStore({ db, vaultKey, deviceId: 'd1' })
    await cStore.create({ vaultId: 'v', title: 'X', backend: 'claude_cli' })
    await cStore.create({ vaultId: 'v', title: 'Y', backend: 'claude_cli' })

    const onProgress = vi.fn()
    await backfillAgentChatRows({
      db,
      vaultId: 'v',
      enqueue: () => {},
      onProgress
    })

    const last = onProgress.mock.calls.at(-1)?.[0]
    expect(last).toMatchObject({ done: 2, total: 2 })
  })
})
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/sync/__tests__/backfill.test.ts`
Expected: FAIL — `../backfill` missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/agent/sync/backfill.ts
import { eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'
import { TERMINAL_STATUSES, type MessageStatus } from '../storage/types'

export interface BackfillProgress {
  done: number
  total: number
}

interface BackfillDeps {
  db: BetterSQLite3Database<typeof schema>
  vaultId: string
  enqueue: (req: { type: 'agent_conversation' | 'agent_message'; id: string }) => void
  onProgress?: (p: BackfillProgress) => void
}

export async function backfillAgentChatRows(deps: BackfillDeps): Promise<void> {
  const conversations = deps.db
    .select({ id: schema.agentConversations.id })
    .from(schema.agentConversations)
    .where(eq(schema.agentConversations.vaultId, deps.vaultId))
    .all()
  const convIds = conversations.map((c) => c.id)

  const messages =
    convIds.length > 0
      ? deps.db
          .select({ id: schema.agentMessages.id, status: schema.agentMessages.status })
          .from(schema.agentMessages)
          .where(inArray(schema.agentMessages.conversationId, convIds))
          .all()
      : []
  const terminalMessages = messages.filter((m) => TERMINAL_STATUSES.has(m.status as MessageStatus))

  const total = conversations.length + terminalMessages.length
  let done = 0
  const tick = () => {
    done++
    deps.onProgress?.({ done, total })
  }

  for (const c of conversations) {
    deps.enqueue({ type: 'agent_conversation', id: c.id })
    tick()
  }
  for (const m of terminalMessages) {
    deps.enqueue({ type: 'agent_message', id: m.id })
    tick()
  }
}
```

- [ ] **Step 4: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/sync/__tests__/backfill.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/sync/backfill.ts apps/desktop/src/main/agent/sync/__tests__/backfill.test.ts
git commit -m "feat(agent-sync): backfill chat rows on entitlement upgrade"
```

---

## Task 15: At-rest forensic test — no plaintext on disk

**Files:**

- Create: `apps/desktop/src/main/agent/storage/__tests__/at-rest-no-plaintext.test.ts`

- [ ] **Step 1: Write the test**

```ts
// apps/desktop/src/main/agent/storage/__tests__/at-rest-no-plaintext.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import sodium from 'libsodium-wrappers'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import * as schema from '@memry/db-schema/data-schema'
import { createConversationStore } from '../conversation-store'
import { createMessageStore } from '../message-store'

const SECRET = 'this-string-must-not-leak-to-disk-PLAINTEXT-MARKER'

describe('At-rest encryption forensics', () => {
  let vaultKey: Uint8Array
  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  it('never writes plaintext message body or conversation title to a real DB file', async () => {
    const tmp = path.join(os.tmpdir(), `memry-agent-${Date.now()}.sqlite`)
    const sqlite = new Database(tmp)
    try {
      sqlite.exec(`
        CREATE TABLE agent_conversations (
          id TEXT PRIMARY KEY,
          vault_id TEXT NOT NULL,
          title_ciphertext TEXT NOT NULL,
          backend TEXT NOT NULL,
          trust_list TEXT NOT NULL DEFAULT '[]',
          pinned INTEGER NOT NULL DEFAULT 0,
          vector_clock TEXT NOT NULL,
          field_clocks TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted_at INTEGER,
          last_synced_at INTEGER
        );
        CREATE TABLE agent_messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content_ciphertext TEXT NOT NULL,
          attachments_ciphertext TEXT NOT NULL,
          tool_call_id TEXT,
          status TEXT NOT NULL,
          vector_clock TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted_at INTEGER
        );
      `)
      const db = drizzle(sqlite, { schema })
      const cStore = createConversationStore({ db, vaultKey, deviceId: 'd1' })
      const mStore = createMessageStore({ db, vaultKey, deviceId: 'd1' })

      const conv = await cStore.create({
        vaultId: 'v',
        title: SECRET,
        backend: 'claude_cli'
      })
      await mStore.append({
        conversationId: conv.id,
        role: 'user',
        content: { role: 'user', data: { text: SECRET } },
        attachments: [],
        status: 'completed'
      })
      sqlite.close()

      const bytes = fs.readFileSync(tmp)
      const text = bytes.toString('utf8')
      expect(text).not.toContain(SECRET)
    } finally {
      try {
        fs.unlinkSync(tmp)
      } catch {}
    }
  })
})
```

- [ ] **Step 2: Run, see it pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/storage/__tests__/at-rest-no-plaintext.test.ts`
Expected: PASS.

> If this test fails, something is leaking. Don't move on — find which column / code path is writing the plaintext and fix it before continuing.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/agent/storage/__tests__/at-rest-no-plaintext.test.ts
git commit -m "test(agent-storage): forensic check that secrets never hit disk plaintext"
```

---

## Task 16: Run the full P2 verify suite

- [ ] **Step 1: Run targeted tests**

```bash
pnpm --filter @memry/desktop test -- agent
```

Expected: every test added in this plan green.

- [ ] **Step 2: Migration round-trip**

```bash
rm apps/desktop/data/dev.sqlite 2>/dev/null || true   # path may differ; check apps/desktop/.env for DB location
pnpm --filter @memry/desktop db:push
```

Expected: 0029 applies cleanly. Open Drizzle Studio and confirm tables exist.

- [ ] **Step 3: Lint + typecheck**

```bash
pnpm lint
pnpm typecheck:node
```

Expected: clean (modulo pre-existing failures listed in CLAUDE.md).

- [ ] **Step 4: Docs impact**

```bash
pnpm docs:impact
```

Expected: report flags new sync item types. Update docs (Agent chat sync model, encryption envelope, backfill UX) and re-run `pnpm docs:impact --strict`.

- [ ] **Step 5: Commit any docs**

```bash
git add apps/docs
git commit -m "docs: document agent chat storage + sync (P2)"
```

---

## Final P2 deliverable checklist

- [ ] `vault_metadata` singleton holds a stable UUID
- [ ] `agent_conversations` and `agent_messages` tables exist; migration 0029 applied
- [ ] Title and message bodies encrypted at rest with purpose-bound AD; forensic test passes
- [ ] `AgentConversationHandler` merges field-by-field (title, pinned, trustList, backend)
- [ ] `AgentMessageHandler` is append-only and idempotent on duplicate ids
- [ ] Both handlers registered in the registry
- [ ] Entitlement gate skips enqueue for free users; backfill helper drains on upgrade
- [ ] Streaming messages cannot be enqueued (only terminal status flows through)
- [ ] All P2 tests green, lint + typecheck pass, docs updated

P2 lands as a self-contained change. P3 will wire actual chat conversations into these stores via IPC.

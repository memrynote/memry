-- data.db, migration 0028: projection tables of the two agent record types
-- (Step 16, #3533; chapter 13 §13.7.26-27): `agent_conversation`
-- (`AgentConversationSyncPayloadSchema`) and `agent_message`
-- (`AgentMessageSyncPayloadSchema`), both in
-- `packages/contracts/src/sync-payloads.ts`.
--
-- Each table caches a parse of the record's payload in `sync_items`, which
-- stays the owner (§A.4): `rebuild_projections` refills them from it.
-- `agent_conversations.title`, `agent_messages.content` and
-- `agent_messages.attachments` hold the at-rest envelope text of chapter 04
-- §4.17, the column format Electron writes
-- (`apps/desktop/src/main/agent/storage/conversation-store.ts:53-55`,
-- `message-store.ts:51-65`), or '' while `sealed_pending` is 1: a record
-- pulled before the vault key was installed, sealed by
-- `Vault::set_at_rest_key`. Instants are the payload's epoch milliseconds.
-- No foreign key from a message to its conversation, as in Electron: a
-- message lands even when its conversation has not.
--
-- Additive only: two new tables and two indexes, no existing table or row
-- touched, no backfill. An older build never reads these tables (its
-- `user_version` guard leaves a newer file alone).
CREATE TABLE IF NOT EXISTS agent_conversations (
  id             TEXT PRIMARY KEY,
  vault_id       TEXT,
  title          TEXT NOT NULL DEFAULT '',
  backend        TEXT NOT NULL DEFAULT '',
  backend_model  TEXT,
  trust_list     TEXT NOT NULL DEFAULT '[]',
  pinned         INTEGER NOT NULL DEFAULT 0,
  sealed_pending INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER,
  updated_at     INTEGER,
  deleted_at     INTEGER,
  synced_at      INTEGER
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  attachments     TEXT NOT NULL DEFAULT '[]',
  tool_call_id    TEXT,
  status          TEXT NOT NULL,
  sealed_pending  INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER,
  updated_at      INTEGER,
  deleted_at      INTEGER,
  synced_at       INTEGER
);

CREATE INDEX IF NOT EXISTS agent_messages_conversation
  ON agent_messages (conversation_id, created_at);

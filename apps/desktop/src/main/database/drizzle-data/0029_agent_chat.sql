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

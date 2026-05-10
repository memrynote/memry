# Agent Chat — Design Spec

**Date:** 2026-05-10
**Status:** Approved (brainstorming phase complete; awaiting implementation plan)
**Owner:** Kaan Karaca
**Scope:** Phases P1 + P2 + P3 (Vault MCP server, Conversation storage + sync, Agent Chat UI with Claude CLI backend). Phases P4 (Codex CLI), P5 (cloud Anthropic / OpenAI / Ollama) acknowledged in _Future Phases_; designed-for, not designed-here.

## Summary

Add a co-pilot agent chat panel to memry. Users converse with an LLM agent that can read vault content broadly and can create/update a deliberately narrow write set — notes, tasks, journal entries, inbox items, tags, and note moves — through a single, audited tool surface. v1 ships with Claude CLI as the only backend, billed against the user's existing Claude Pro/Max subscription (no API key required). The chat panel lives in the existing right sidebar as a tab next to the Day panel.

The architectural commitment is **MCP-first**: memry's main process exposes vault operations as a localhost MCP server, and every backend (now Claude CLI; later Codex CLI, cloud Anthropic, cloud OpenAI, Ollama) consumes the same tool surface. The vault MCP server is itself a useful standalone artifact — Cursor, Claude Desktop, Zed, and other MCP clients can connect to memry directly. In v1, external clients are read-only by default; write calls require an active Memry Agent conversation so the app can show the approval UI.

Conversation history is owned by memry, not the CLI: each user turn assembles the full conversation and spawns `claude` stateless. This makes the system backend-agnostic, lets memry control compaction, and lets history follow the user across devices via the existing E2E sync pipeline. Free users get full chat with local-only persistence; sync is gated to paid tiers.

Important privacy boundary: Claude CLI still sends the assembled prompt, selected vault excerpts, tool results, and the user's message to Anthropic under the user's Claude account. Memry encrypts local/synced conversation history at rest, but it cannot make remote model inference local or zero-knowledge. The Agent tab must show a first-use disclosure and require explicit enablement before any prompt is sent.

## Goals

- Ship a useful agent chat that solves both stated example flows: "create tasks from `@project` folder" and "draft a landing-page pitch from the current note"
- Zero API key required for v1 — Claude Pro/Max subscription via local `claude` CLI is sufficient
- Single tool surface (MCP) reusable across every future backend and across third-party MCP clients
- Free-tier parity for the chat experience itself; sync is the paid differentiator
- Memry stays the sole gatekeeper of vault writes — agent never touches raw `.md` files via the CLI's built-in tools
- Encrypted-at-rest conversation history, consistent with memry's "your data, your encryption" promise
- Clear provider disclosure: before first use, user sees exactly that Claude CLI sends prompt context to Anthropic; attached refs and tool results stay visible in the UI before/during the turn

## Non-Goals (out of scope for this spec)

- Codex CLI backend, cloud-API backends (Anthropic, OpenAI), local-LLM backend (Ollama, LM Studio) — Phase 4 / 5
- Plan-first / autonomous task-runner mode (background agents) — later
- Embedding / RAG pipeline for semantic context auto-injection — later
- Agent chat search across conversations
- Shareable transcripts / public agent runs
- Mobile chat surface (mobile apps don't exist yet)
- Multi-agent / agent-to-agent workflows
- Custom user-defined MCP tools
- Voice input / TTS output
- Project/folder write tools and destructive delete/archive tools

## Decisions Log (from brainstorming)

| #   | Decision                                                                                                                                                                             | Rationale                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Co-pilot panel (turn-by-turn), not background task runner                                                                                                                            | Both example flows are seconds-to-minutes, not multi-minute autonomous runs                                                                                                        |
| 2   | MCP-first: vault MCP server is the single tool layer for all backends                                                                                                                | Avoids per-backend tool reimplementation; usable as standalone integration; Claude CLI / Codex CLI both speak MCP natively                                                         |
| 3   | Tool tier C — broad reads + narrow create/update set                                                                                                                                 | "Create tasks from folder" needs create; "edit current note" needs update. Project/folder writes and delete/archive deferred to avoid building destructive-undo before v1          |
| 4   | Permission model B — reads never prompt; create tools can be trusted per conversation; update tools always show approval + diff/before-after                                         | Proven Cursor/Claude-Code pattern while preserving the explicit "review every mutation" safety bar for edits                                                                       |
| 5   | Context model B — manual `@` references + auto-attach current note; folder refs are reference-style (not inlined)                                                                    | Matches both example flows; avoids token explosion on large folders; agent uses `list_folder` + `read_note` MCP tools to drill in                                                  |
| 6   | Conversation persistence: local tables plus `agent_conversation` / `agent_message` sync items, paid-gated sync                                                                       | Free users get the full feature with local-only durability; paid tier is "your chats follow you across devices." Chat sync waits for entitlement checks before enqueueing rows     |
| 7   | MCP transport: localhost HTTP/SSE                                                                                                                                                    | Memry main process is long-lived; multiple backends + external clients (Cursor, Zed, etc.) need to share the same server; stdio doesn't fit                                        |
| 8   | Subprocess lifecycle: spawn `claude` per turn, stateless, conversation history serialized into prompt                                                                                | Backend-agnostic; memry controls compaction; ~200-400 ms cold start hidden by streaming; subscription billing makes re-prompt cost zero                                            |
| 9   | Claude CLI's built-in tools (`Read`, `Write`, `Edit`, `Bash`, etc.) disabled per-launch via `--tools ""`, exact MCP allowlist, `--strict-mcp-config`, and `--no-session-persistence` | Memry stays sole gatekeeper of vault writes; prevents agent from poking raw `.md` files/running shell, loading unrelated MCP servers, or persisting Claude-side transcript history |
| 10  | UI surface: right-sidebar tab next to existing Day panel; activity badge when chat is in background                                                                                  | Reuses existing layout slot; no new resize/collapse infra; co-located with the note user is editing for current-note attach                                                        |
| 11  | Backend choice: schema stores per-conversation backend now; visible picker waits until P4                                                                                            | v1 has one backend, so a dropdown is speculative UI. Storing the backend keeps the migration path clean without adding dead controls                                               |

## High-Level Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│                          Memry Desktop (Electron)                     │
│                                                                       │
│   Renderer (React)                          Main process (Node)       │
│   ┌──────────────────────┐                ┌─────────────────────────┐ │
│   │ Right sidebar        │     IPC        │  AgentRuntime           │ │
│   │ ┌──────┬──────────┐  │  ◄──────────►  │  - conversation store   │ │
│   │ │ Day  │ Agent ●  │  │                │  - turn orchestrator    │ │
│   │ ├──────┴──────────┤  │                │  - permission gate      │ │
│   │ │ Chat panel      │  │                │  - subprocess manager   │ │
│   │ │ - msgs / stream │  │                └────────────┬────────────┘ │
│   │ │ - @ ref picker  │  │                             │              │
│   │ │ - tool cards    │  │                ┌────────────▼────────────┐ │
│   │ │ - diff modals   │  │                │  Vault MCP server       │ │
│   │ │ - approve/deny  │  │                │  127.0.0.1:RANDOM_PORT  │ │
│   │ └─────────────────┘  │                │  Bearer-token auth      │ │
│   └──────────────────────┘                │  tools = read/create/   │ │
│                                           │          update         │ │
│                                           └────────────┬────────────┘ │
│                                                        │ in-process   │
│                                                        ▼              │
│                                           ┌─────────────────────────┐ │
│                                           │ Existing main services  │ │
│                                           │ notes / tasks / projects│ │
│                                           │ journal / inbox / folder│ │
│                                           └─────────────────────────┘ │
│                                                                       │
│       ┌──────────────────────────────────────────────────┐            │
│       │  Subprocess (per turn, killed on completion)     │            │
│       │  claude -p --input-format text                   │            │
│       │         --output-format stream-json              │            │
│       │         --include-partial-messages               │            │
│       │         --mcp-config <ephemeral.json>            │            │
│       │         --strict-mcp-config                      │            │
│       │         --no-session-persistence                 │            │
│       │         --tools ""                               │            │
│       │         --allowed-tools <exact memry MCP list>   │            │
│       └────────────────────────┬─────────────────────────┘            │
│                                │ HTTP/SSE                             │
│                                ▼                                      │
│                       (back to Vault MCP server above)                │
└───────────────────────────────────────────────────────────────────────┘
                          │
                          │ paid users only, when chat
                          │ row mutations enqueue
                          ▼
              ┌───────────────────────────────┐
              │ Sync server (Workers + D1+R2) │
              │ existing sync_item pipeline,  │
              │ new types = agent_conversation│
              │             + agent_message   │
              └───────────────────────────────┘
```

Three runtime layers:

1. **Renderer** — React. Right-sidebar tab, message list, input with `@` ref picker, tool-call cards, diff-preview modal, trust-list controls.
2. **AgentRuntime** (main process) — orchestrates a turn: assembles prompt from stored history, spawns subprocess, parses streaming JSON events, routes tool calls through the permission gate, persists messages.
3. **Vault MCP server** (main process, in-process with AgentRuntime) — exposes vault operations over localhost HTTP/SSE. Serves the spawned subprocess and any external MCP clients.

## Phase 1 — Vault MCP Server

### Tool surface (tier C)

Read tools (no confirmation):

| Tool                         | Inputs                                        | Returns                                                           |
| ---------------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| `vault.search_notes`         | query, limit?, folder_id?                     | `[{ id, title, snippet, folder_path }]`                           |
| `vault.read_note`            | id                                            | `{ id, title, content_markdown, tags, folder_path, frontmatter }` |
| `vault.list_folder`          | path or id, recursive?                        | `[{ kind: 'folder' \| 'note', id, name, path }]`                  |
| `vault.get_current_note`     | (none)                                        | currently active note in renderer; null if not on a note view     |
| `vault.list_tasks`           | filter (status, project_id, due_before, etc.) | `[{ id, title, status, due, project, tags }]`                     |
| `vault.list_projects`        | (none)                                        | `[{ id, name, status, task_count }]`                              |
| `vault.get_journal_entry`    | date (YYYY-MM-DD)                             | `{ id, date, content_markdown }` or null                          |
| `vault.list_journal_entries` | date_range                                    | `[{ id, date, title }]`                                           |
| `vault.list_inbox_items`     | unread_only?                                  | `[{ id, source, title, snippet, captured_at }]`                   |
| `vault.get_tags`             | (none)                                        | `[{ name, count }]`                                               |

Create tools (require confirmation; trust-listable per conversation):

| Tool                         | Inputs                                             | Returns  | Notes                                                                                  |
| ---------------------------- | -------------------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `vault.create_note`          | title, content_markdown, folder_path?, tags?       | `{ id }` | Fails if path doesn't exist (no auto-mkdir in v1)                                      |
| `vault.create_task`          | title, project_id?, due?, priority?, tags?, notes? | `{ id }` |                                                                                        |
| `vault.create_journal_entry` | date, content_markdown                             | `{ id }` | If entry for date exists, returns existing id and `created: false` instead of creating |
| `vault.add_to_inbox`         | source, title, content                             | `{ id }` |                                                                                        |

Update tools (always require confirmation + diff/before-after preview; not trust-listable):

| Tool                                 | Inputs                                                          | Returns  | Notes                                                                           |
| ------------------------------------ | --------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------- |
| `vault.update_note`                  | id, mode (`append` \| `prepend` \| `replace`), content_markdown | `{ id }` | Diff modal renders before/after, user can edit content_markdown before applying |
| `vault.update_task`                  | id, partial fields                                              | `{ id }` |                                                                                 |
| `vault.add_tag` / `vault.remove_tag` | id, kind (note/task), tag                                       | `{ id }` | Always show before/after; never trust-listable                                  |
| `vault.move_to_folder`               | id, folder_path                                                 | `{ id }` |                                                                                 |

Project writes, folder creation, folder deletion, inbox mutation beyond add, journal mutation beyond create-if-missing, and destructive deletes/archive are out of scope for v1.

Tool naming: the spec uses human-readable aliases like `vault.read_note`. The actual MCP tool names should be dot-free snake_case (`vault_read_note`, `vault_create_task`, etc.) because Claude Code's allowlist is checked against exact tool names such as `mcp__memry__vault_read_note`. AgentRuntime must generate the exact `--allowed-tools` list from the registered tool table at startup; do not rely on wildcards like `mcp__memry__*` or dotted patterns.

### Transport, auth, lifecycle

- **Bind:** `127.0.0.1` only, on a random port chosen at app start. Port persists for the app session.
- **Per-launch token:** 32-byte random hex generated on app start; held in process memory only, never written to disk. Required as `Authorization: Bearer <token>` on every request.
- **Per-conversation scope:** the MCP server reads `X-Memry-Conversation: <conversation-id>` on each request (set by the spawned subprocess via `--mcp-config` headers), and uses it to look up the right trust list when checking create-tool confirmation policy. Without that header, all writes are denied in v1 because there is no conversation surface to receive approval.
- **Per-window scope:** the spawned subprocess also sends `X-Memry-Window: <window-id>`. `vault.get_current_note` uses that window id to snapshot the active note from the correct renderer window. External clients or stale window ids return `null`.
- **Lifetime:** the MCP server runs for the app's lifetime. Same server endpoint is reused across all conversations and all backends.
- **Discovery:** memry writes the server URL + token + fresh per-turn headers into a temp `mcp-config.json`, hands it to the spawned subprocess via `--mcp-config`, deletes after exit. Claude turn config includes `Authorization`, `X-Memry-Conversation`, and `X-Memry-Window`; external-client config shown in settings includes only `Authorization`.
- **External clients:** v1 exposes read tools to Cursor / Claude Desktop / Zed via a settings/debug panel that shows the current session URL and bearer token, with copy and rotate-token actions. Tokens are per app launch and are not persisted, so external clients reconnect after every restart. External write calls return `PERMISSION_DENIED` unless they belong to an active Memry Agent conversation with a renderer approval flow; this keeps P1 useful without inventing a global approval center.

### Tool implementation

Each tool delegates to the existing main-process service for that domain (`notes`, `tasks`, `projects`, `journal`, `inbox`, `folders`). Tools never query the DB directly — they go through the same service-layer methods used by the renderer's IPC handlers, so all existing validation, vector-clock bookkeeping, sync queuing, and side effects (search index updates, projection invalidation, etc.) Just Work.

The renderer's "current note" state is held in the renderer; `vault.get_current_note` flows back through IPC to the renderer window named by `X-Memry-Window`, snapshots the active note id + title + markdown at that moment, then returns it. If the header is absent/stale, the window is gone, or the active tab is not a note, returns `null`.

### Errors

Tool errors return as MCP `tool_error` payloads with structured fields:

```json
{ "code": "NOT_FOUND" | "PERMISSION_DENIED" | "VALIDATION" | "INTERNAL",
  "message": "user-readable",
  "details": { ... } }
```

The agent sees these and can recover (retry, ask user). The renderer also gets a sibling event so the tool-call card shows the failure inline.

### Tests

- Unit tests per tool against in-memory main-process services
- Integration test: end-to-end MCP request → tool execution → DB mutation
- Auth test: requests without bearer token rejected with 401
- Auth test: requests with stale token (after app restart) rejected
- External-client smoke test: launch a manual Cursor / Claude Desktop config pointing at the dev server, verify read tools appear and roundtrip works; verify write tools return `PERMISSION_DENIED` without an active Memry Agent conversation

## Phase 2 — Conversation Storage + Sync Handler

### Schema

New tables in the data DB. Both follow the existing sync-item shape (vector clock, soft-delete, timestamps) so the Phase-7/8 handler pattern applies directly. Conversations use field clocks because title/trust/pin can merge independently; messages are sync-append-only once terminal and do not need field clocks.

Dependency: current desktop vault identity is path-based. Before adding chat rows, P2 must create or reuse a stable local vault UUID stored inside the vault's data DB (for example a singleton `vault_metadata` row or a reserved settings key). This UUID becomes `agent_conversations.vault_id` and later maps to the paid-sync server's `vaults.id`; do not use the mutable filesystem path as the sync identity.

```ts
// drizzle: agent_conversations
{
  id: text PRIMARY KEY,                  // UUID
  vault_id: text NOT NULL,               // stable local vault UUID; maps to paid-sync vaults.id
  title: text NOT NULL,                  // user-editable; auto-generated from first user message
  backend: text NOT NULL,                // 'claude_cli' (only one in v1)
  trust_list: text NOT NULL,             // JSON array of tool names trusted in this conv
  pinned: integer NOT NULL DEFAULT 0,
  vector_clock: text NOT NULL,           // JSON
  field_clocks: text NOT NULL,           // JSON
  created_at: integer NOT NULL,
  updated_at: integer NOT NULL,
  deleted_at: integer,
  last_synced_at: integer,
}

// drizzle: agent_messages
{
  id: text PRIMARY KEY,                  // UUID, sortable (ULID/UUIDv7)
  conversation_id: text NOT NULL,        // FK
  role: text NOT NULL,                   // 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system'
  content: text NOT NULL,                // JSON; structure depends on role (see below)
  tool_call_id: text,                    // present on tool_result rows; ties result to its call
  attachments: text NOT NULL,            // JSON array (snapshot of @ refs at send-time)
  status: text NOT NULL,                 // 'pending' | 'streaming' | 'completed' | 'cancelled' | 'error'
  vector_clock: text NOT NULL,           // for sync; messages are append-only
  created_at: integer NOT NULL,
  updated_at: integer NOT NULL,
  deleted_at: integer,
}
```

Streaming persistence rule: messages may be draft-mutated locally while a turn is in flight (`pending` / `streaming`). They are enqueued for sync only after reaching a terminal status (`completed` / `cancelled` / `error`). After terminal status, the row is immutable except soft-delete. This keeps remote merge append-only while still allowing local partial rendering.

`agent_messages.content` shapes per role:

```ts
// role = 'user'
{ text: string }

// role = 'assistant'
{ text: string }                         // can be partial during streaming

// role = 'tool_call'
{ tool: 'vault.create_note' | ..., args: object, status: 'pending' | 'approved' | 'denied' | 'completed' | 'failed', approved_args?: object }

// role = 'tool_result'
{ ok: boolean, data?: any, error?: { code, message } }

// role = 'system'
{ kind: 'context_attached' | 'compacted' | 'backend_changed', payload: object }
```

`attachments` shape:

```ts
[{ kind: 'note' | 'folder' | 'task' | 'project' | 'journal' | 'current_note',
   ref_id: string,
   label: string,
   snapshot_at: number,
   snapshot:
     | { mode: 'inline_note', title: string, content_markdown: string, truncated: boolean }
     | { mode: 'inline_journal', date: string, content_markdown: string, truncated: boolean }
     | { mode: 'inline_task', title: string, status: string, due?: string, project?: string, notes?: string }
     | { mode: 'inline_project', name: string, status?: string, task_count?: number }
     | { mode: 'reference_only', path?: string, id?: string } }]
```

Snapshot rules:

- `current_note`, explicit note refs, and journal refs inline markdown at send time, capped at 30k characters per attachment. If truncated, the prompt says so and gives the agent the live ref id so it can call `vault.read_note` / `vault.get_journal_entry`.
- Folder refs are always `reference_only`; the prompt includes path/id and tells the agent to use `vault.list_folder` and read tools to drill in.
- Task/project refs inline small structured fields only.
- Prompt assembly uses the stored attachment snapshot for the user's original context, not whatever the note changed into later.

### Encryption at rest (free + paid)

Conversation rows live in the data DB. Free users keep them locally; encryption-at-rest must still apply for two reasons: chat content can be sensitive (private prompts, vault excerpts pulled into context); and we want consistency with the rest of memry's "your data, your keys" stance.

Use the existing vault key material. Add small agent-storage helpers, for example `encryptAgentJsonForVault` / `decryptAgentJsonForVault`, implemented on top of the existing main-process crypto primitives (`encrypt` / `decrypt`) with a purpose-specific derived subkey or associated data. Store an envelope as text JSON (`{ version, nonce, ciphertext }`, base64 values) in encrypted columns. Do not refer to non-existent `encryptForVault` / `decryptForVault` helpers.

Encrypt `agent_messages.content` and `agent_messages.attachments` before insert. `agent_conversations.title` is also encrypted; `id`, `vault_id`, `backend`, `trust_list` (tool names only — no PII), and timestamps stay plaintext for local indexing and sync routing. Remote sync encryption still goes through the existing sync push/pull crypto path (`encryptItemForPush` / decrypt pull flow); local column encryption is an extra at-rest layer before the row is packed for sync.

### Sync handler

Add two sync item types to `packages/contracts/src/sync-api.ts`, the desktop handler registry, and tests:

- `agent_conversation` — one item per conversation row. Field-level merge. Title, pinned, backend, and trust_list mutate independently.
- `agent_message` — one item per terminal message row. Append-only after terminal status; conflict resolution is idempotent "same id wins if payload hash matches, otherwise quarantine/log because message ids should be unique."

New handlers `AgentConversationHandler` and `AgentMessageHandler` follow the strategy pattern from `src/main/sync/item-handlers/`. When a message reaches terminal status, enqueue the message row as `agent_message` and enqueue the parent conversation as an `agent_conversation` update for `updated_at` / last-activity ordering.

### Paid gating

The sync engine queries entitlement before enqueueing. Free users' rows simply never enter `sync_queue` — they stay local. If this phase lands before the paid-sync entitlement work, chat sync remains disabled/local-only until entitlement checks exist; do not enqueue chat rows based only on "sync account exists." On upgrade, all existing chat rows for that vault get marked dirty and drained to the cloud in one backfill (visible to user as a one-time progress indicator: "Syncing chat history… 423 / 891"). On downgrade, future mutations stop enqueueing; cloud copy stays per the paid-sync grace-period policy.

### Tests

- Unit tests for the handler's merge logic (concurrent title edits, message union)
- Migration tests: tables come up clean, encrypted columns roundtrip
- Sync integration test: free user's mutations don't enqueue; flipping entitlement enqueues backfill
- Encryption test: rows on disk don't contain plaintext message bodies

## Phase 3 — Agent Chat UI (Claude CLI)

### Right-sidebar tab

The existing right sidebar gets a tabbed header:

```
┌──────────────────┐
│ ◑ Day | ✦ Agent  │  ← segmented control, ✦ shows • badge when activity in background
├──────────────────┤
│ (selected pane)  │
└──────────────────┘
```

Tab state persists per window. Switching to Agent for the first time on a fresh install shows an enablement screen, not the composer. It says Claude CLI sends the user's message, attached refs, prior chat context, and tool results to Anthropic under the user's Claude account; local/synced chat history is encrypted by Memry. User must click **Enable Claude CLI chat** before any `claude` subprocess can run. After enablement, empty state shows "Start chatting with your vault" + a Claude-CLI-status line ("`claude` detected and ready" / "`claude` not found — install instructions"). Once a chat exists, default view is the most recently active conversation.

### Conversation list

Collapsible header dropdown above the message stream — clicking the conversation title opens a list of recent conversations + "New conversation" button. No second permanent sidebar; the list is transient.

### Message stream

Bottom-anchored, scrollable. Renders five message kinds:

1. **User message** — bubble. Shows `@` refs as chips.
2. **Assistant text** — markdown, streamed. Code blocks have copy buttons. Same rendering as elsewhere in memry where possible (reuse the BlockNote markdown renderer or a minimal subset of it).
3. **Tool-call card** — collapsed by default, shows tool name + summary args. Expand to see full args. Status badge: pending / approved / denied / completed / failed.
4. **Tool-result card** — sibling of the tool-call card; shows return value or error. Auto-collapsed for read tools, expanded for create/update on success or failure.
5. **System note** — small dim row: "Context: current note attached", "Older messages summarized to fit context window", "Backend changed to X".

### Input box

Bottom-pinned. Multiline textarea. Above it: a horizontal strip of **attached refs** as chips, each with an `×` to remove. The current note is auto-attached as `[current note]` chip if the user is viewing one; user can dismiss the chip to detach (sticky for the conversation — won't re-auto-attach until a new conversation).

`@` typed in the input opens a popover ref picker:

```
@proj
─────
  Folder  /Projects                  [↵ to attach]
  Folder  /Projects/2026-Q2
  Note    Project notes (in Inbox)
  Project ProjectKickoff
```

Picker drives off the existing search infra (FTS over notes + folders + tasks + projects). Selecting an item attaches it as a chip; the `@` token is removed from input text. Multiple chips per message allowed.

Submit on `Cmd/Ctrl+Enter`. `Enter` is newline. (Many users prefer the inverse — make this a setting later.)

The conversation row stores `backend = 'claude_cli'`, but v1 does not show a backend dropdown because there is only one usable option. P4 can add the per-conversation / per-turn backend picker when a second backend exists.

### Permission flow (trust-list, conversation-scoped)

When a turn produces a tool call:

1. Tool-call card appears in the stream, status = `pending`.
2. AgentRuntime's permission gate inspects the call:
   - Read tool? → auto-approve, execute, return result. Card flips to `completed` once result arrives.
   - Create tool, in trust list? → execute, return result.
   - Create tool, not in trust list? → modal opens.
   - Update tool? → modal always opens; trust list never skips update review.
3. The modal shows the tool, the args (editable for create-tool args; for update-tool args the args are non-editable but the _outcome_ is shown as an editable diff/before-after — see below). Buttons for create tools: **Allow once** / **Allow & always** / **Edit & allow** / **Deny**. Buttons for update tools: **Apply once** / **Edit & apply** / **Deny**.
4. **Allow once** → execute with original args.
5. **Allow & always** → add create-tool name to `agent_conversations.trust_list`, execute. Future calls of that create-tool name in this conversation skip the modal.
6. **Edit & allow/apply** → user mutates args (or the candidate output for updates), execute with edited args/candidate.
7. **Deny** → MCP returns a structured `PERMISSION_DENIED` error. Tool-call card flips to `denied`. Agent sees the error and can ask the user what to do.

Trust-list entry is one of the create tools only: `vault.create_note`, `vault.create_task`, `vault.create_journal_entry`, `vault.add_to_inbox`. Granularity = tool name only; no per-target trust ("trust create task for project X" — overkill for v1). Update tools are never trust-listable.

### Diff preview (update tools only)

When the modal is opened for `vault.update_note`:

- Fetch the current `content_markdown` from the existing note.
- Apply the proposed mode (`append` / `prepend` / `replace`) with the proposed `content_markdown` to produce the candidate state.
- Render side-by-side or unified diff (use existing memry diff component if there is one; otherwise [`react-diff-view`] or hand-rolled).
- Editable: user can scroll into the candidate side and tweak before clicking Apply.

For `vault.update_task` / `vault.move_to_folder` / `vault.add_tag` / `vault.remove_tag`: a structured "before / after" panel rather than a textual diff.

### Streaming, cancellation

User clicks **Stop** or hits `Esc`:

- AgentRuntime kills the spawned `claude` child (`SIGTERM`, then `SIGKILL` if it doesn't exit in 500 ms).
- Any in-flight tool calls left as `pending` get marked `cancelled`.
- The partial assistant message stays in the stream as `cancelled` status (visible italics, "stopped").
- User can retry the turn (resends the previous turn input, agent gets a fresh start).

### Activity badge

When the chat is in the Agent tab is _not_ visible (Day tab selected, or sidebar collapsed entirely), and a turn is streaming or a tool-call modal is pending, show:

- Day-tab Agent badge: small dot + count if there are pending approvals (`✦ Agent ●`)
- Tooltip on hover: "1 pending approval" / "Streaming response…"

Clicking the Agent tab dismisses the dot. Auto-switching the tab is _not_ done — would yank user out of their current task.

### IPC contract

New channel set in `packages/contracts/src/ipc-agent.ts`:

| Channel                    | Direction                   | Payload                                                                                                                                                                                  |
| -------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent:listConversations`  | renderer → main → renderer  | `{ vaultId }` → `Conversation[]`                                                                                                                                                         |
| `agent:createConversation` | renderer → main → renderer  | `{ vaultId, backend? }` → `Conversation`                                                                                                                                                 |
| `agent:loadConversation`   | renderer → main → renderer  | `{ id }` → `{ conversation, messages }`                                                                                                                                                  |
| `agent:sendTurn`           | renderer → main             | `{ conversationId, sourceWindowId, text, attachments[] }`                                                                                                                                |
| `agent:cancelTurn`         | renderer → main             | `{ conversationId }`                                                                                                                                                                     |
| `agent:approveTool`        | renderer → main             | `{ conversationId, toolCallId, decision: 'allow' \| 'allow_always' \| 'edit_allow' \| 'deny', editedArgs? }`                                                                             |
| `agent:editTrustList`      | renderer → main → renderer  | `{ conversationId, add?: string[], remove?: string[] }`                                                                                                                                  |
| `agent:event`              | main → renderer (broadcast) | streaming events: `assistant_text_delta`, `tool_call_started`, `tool_call_pending_approval`, `tool_call_completed`, `tool_call_failed`, `turn_completed`, `turn_cancelled`, `turn_error` |

Run `pnpm ipc:check` after editing contracts; `pnpm ipc:generate` if invoke map changes.

### Tests

- Unit tests for permission gate (trust-list lookup, decision branches)
- Unit tests for conversation prompt assembly (message ordering, attachment serialization, compaction trigger)
- Integration tests for AgentRuntime turn orchestrator: stub `claude` subprocess with a fake stream-json producer, verify event routing and DB writes
- E2E (Playwright): "create a task from current note" flow, exercising trust-list approval and tool execution end-to-end against a stubbed Claude binary

## Cross-cutting Concerns

### Token budget / compaction (v1)

Conversation prompt assembled per turn:

```
[system prompt]                        // static, ~500 tokens
[provider disclosure reminder + tool rules]
[attached refs (current note + @ refs, send-time snapshots)]
[prior messages, oldest → newest]
[new user message]
```

Prompt attachment rendering:

- Inline note/current-note/journal snapshots under clear labels: `Attached note: <title> (<id>)`, then markdown. If truncated, append `... [truncated; use vault.read_note/vault.get_journal_entry for full content]`.
- Folder refs render only as `Attached folder reference: <path or id>` plus instruction to use `vault.list_folder`; folder contents are not inlined.
- Task/project refs render compact structured fields.
- Before sending, the UI shows the attached chips; during the turn, the message bubble keeps those chips so the user can see what was sent.

Compaction policy v1 (deliberately simple):

- Hard cap at 100k tokens of prompt input.
- When over cap, summarize the oldest 50% of message history into a single synthetic system note (`role=system`, `kind=compacted`, body = "Earlier in this conversation: ..."). Newer 50% kept verbatim.
- Summary generated by another `claude -p` call with a fixed compaction prompt.
- Compacted state is persisted as a new system message; original messages stay in the DB (display intact, prompt rebuild uses summary).

Smarter strategies (sliding windows, semantic relevance picking, prompt-cache awareness) deferred.

### Errors and degraded states

| Failure mode                              | Behavior                                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Agent disclosure not accepted             | Composer disabled; no subprocess can start.                                                                      |
| `claude` binary not on PATH               | Empty-state shows install instructions. Send button disabled.                                                    |
| `claude login` not done                   | First send attempt detects this from CLI exit code/stderr; shows "Sign in to Claude" hint with link to docs.     |
| Subprocess crashes mid-turn               | Turn marked `error`, partial assistant text saved, user can retry.                                               |
| MCP tool throws                           | Surfaces as structured `tool_error` (see Phase 1).                                                               |
| User offline (free user)                  | Local chat still works fully; CLI handles its own auth caching.                                                  |
| User offline (paid user, sync)            | Mutations buffer in local sync queue; drain when online.                                                         |
| Trust-list create-tool race (two windows) | Single-writer in main process; renderer re-reads after every mutation. Vector clocks resolve cross-device.       |
| External client attempts write            | Deny with `PERMISSION_DENIED` unless the request has an active Memry Agent conversation/window approval context. |

### Security

- MCP server bound to `127.0.0.1`; never accepts external connections.
- Per-launch random bearer token, never persisted.
- Claude CLI launch uses `--tools ""` plus an exact generated `--allowed-tools` list containing only Memry MCP tools, `--strict-mcp-config`, and `--no-session-persistence`. `--disallowed-tools "*"` can remain as a belt-and-suspenders denylist only if it does not block the exact MCP allowlist in the tested Claude version.
- Do not use `--bare` for v1: local help says it disables OAuth/keychain auth, which breaks the "Claude Pro/Max subscription via local login" requirement. Use a temp cwd + strict MCP + no session persistence instead.
- Subprocess working directory is a sandbox temp dir, _not_ the vault directory — even if a CLI built-in tool slipped through the disable, it'd be reading an empty dir.
- Tool args are validated server-side by Zod schemas before mutation; agent can't smuggle SQL or path traversal.
- Trust list lives in the conversation row only; never honored cross-conversation, never persists in claude CLI's own session files.
- All renderer↔main payloads go through the existing IPC contract validators.
- First-use Agent enablement is required before remote model calls. The disclosure states that prompts and selected context go to Anthropic through Claude CLI; Memry's encryption covers local/synced storage, not remote inference.

### Logging and telemetry

- Use `createLogger('AgentRuntime')`, `createLogger('AgentMcpServer')`, etc. Never raw `console.*`.
- Each turn logs: turn id, conversation id, prompt token estimate, subprocess pid, duration, exit code, tool calls (count by tool, count by approval decision), final status.
- Errors use `extractErrorMessage(err, fallback)` for UI strings.
- Telemetry counters: `agent.turns_started`, `agent.turns_completed`, `agent.tool_calls{name, decision}`, `agent.compactions`. PII-free.

### Performance budgets

| Path                                     | Budget      |
| ---------------------------------------- | ----------- |
| First token from `claude -p` to renderer | < 2 s p95   |
| Tool call latency (read tools)           | < 50 ms p95 |
| Diff preview render (long note)          | < 200 ms    |
| Conversation list load (50 chats)        | < 100 ms    |

## Future Phases (acknowledged, not designed here)

**P4 — Codex CLI backend.** Generalize `AgentRuntime`'s subprocess manager into a backend trait (`spawn`, `parseStream`, `assemblePrompt`). Add Codex as a second implementation. Per-conversation backend pin in the UI starts being a real choice. Codex's MCP support and stream-json output format will need a parallel of the Claude integration but should reuse the entire Vault MCP server unchanged.

**P5 — Cloud Anthropic / OpenAI / Ollama backends.** Add AI SDK driven backends. They consume the same Vault MCP server via `experimental_createMCPClient`. Adds API-key settings UI for cloud paths (encrypted at rest in the existing settings store) and base-URL config for Ollama. Tool-calling discipline and small-LLM fallback ("if model can't reliably tool-call, drop tool offering and keep chat-only") are real concerns at this phase but not before.

**Later.** Plan-first / autonomous mode (Q4 option D). Background long-running tasks (Q1 option B). Agent chat search across conversations. RAG / embeddings for auto-context. Custom user-defined MCP tools. Voice input/output. Mobile app surface.

## Open Questions / Risks

- **Claude CLI flag stability.** Local verification on Claude Code `2.1.138` shows `--input-format`, `--output-format`, `--include-partial-messages`, `--mcp-config`, `--strict-mcp-config`, `--no-session-persistence`, `--tools`, `--allowed-tools`, and `--disallowed-tools`. They are moving targets. Implementation should pin a minimum CLI version on app start (`claude --version`) and surface a clear "your `claude` is too old / too new" message rather than failing opaquely. Decision: lock to a tested minimum at impl time; document upgrade-detection in CHANGELOG.
- **Streaming JSON parser robustness.** `stream-json` events may chunk mid-line; needs a simple line-buffered parser. Risk if Claude emits malformed events on edge cases — fall back to "treat as raw text, log warning, continue."
- **Concurrent turns in the same conversation.** v1: forbidden. The send button is disabled while a turn is in flight. (Multi-window edge case: lock at conversation level via main-process map, second sender gets "another window is mid-turn" error.)
- **Subprocess process tree on app quit.** Need to ensure spawned `claude` processes are cleaned up on `app.before-quit` — Electron child processes don't always die with the parent on macOS.
- **Cross-conversation trust list spillover risk.** Designed against (per-conversation only). Audit during code review that no path persists trust-list entries to user-level settings.
- **Encryption-at-rest performance.** Encrypting every message body adds CPU per insert. Probably negligible (libsodium is fast) but worth measuring at the end of P2.
- **Diff component reuse.** Audit memry for an existing diff renderer; if none, picking [`react-diff-view`] vs hand-rolled is a P3 call.
- **Free → paid backfill UX.** Big history could be tens of MB to upload. Need a non-blocking progress indicator and a "do this later" affordance.
- **MCP server external exposure.** Server binds to localhost; useful for the user's local Cursor / Claude Desktop. v1 external clients are read-only unless attached to an active Memry Agent approval context. Documenting this as a feature is a P1 marketing/docs decision. Externalizing beyond localhost (LAN, remote) is explicitly out of scope.
- **P1/P3 write approval dependency.** P1 can ship the MCP server and read-tool external smoke test, but write tools need the P3 approval surface before they are practically usable. P1 tests should assert unaffiliated external writes are denied, not blocked on a missing modal.

## Phase Implementation Order

1. **P1 first** — MCP server, all tool schemas, read tool execution, auth, and external read-only MCP-client smoke test. Write tools validate args and deny without active approval context. Lands a useful artifact even before any chat UI exists.
2. **P2 second** — local vault UUID, schema, encryption-at-rest, `agent_conversation` + `agent_message` sync handlers. Unit-level only; no UI yet. If paid-sync entitlement is not available, chat rows remain local-only.
3. **P3 third** — chat UI, ties P1 + P2 together. Ship to alpha users on Claude CLI only.
4. P4, P5, Later — separate specs.

Each phase = its own implementation plan + PR series. Don't wedge them into one giant branch.

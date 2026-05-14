# Agent Chat & MCP Server

Memry can run an in-app Agent Chat backed by a provider-neutral agent backend. Claude CLI is the
first full backend, local OpenAI-compatible servers can be used for BYO local models, and the Codex
CLI backend uses the same contract when enabled. After a vault opens, the desktop app starts a local
MCP endpoint on `127.0.0.1` with a random port, then gives the selected backend only the vault tools
for the current conversation.

The Agent runtime and MCP endpoint are scoped to the open vault. Closing or switching vaults stops
active turns, clears pending tool approvals, and restarts the Agent services for the next vault.

The same MCP endpoint can also be copied into other desktop AI clients for vault read tools.

Open [Settings -> AI Assistant -> Agent MCP](/user-guide/settings#agent-mcp) to copy the current
endpoint and bearer token.

## Agent Chat

Open the right sidebar, choose **Agent**, and pick a provider. The compact Day/Agent switch keeps
the active view highlighted at the top of the right sidebar. The Agent header includes a
new-conversation button, a history menu for switching back to recent conversations, and a pop-out
button for moving the current conversation into a workspace tab. Popped-out conversations keep the
generated conversation title as the tab name, use the same centered reading column as notes, and
leave the right sidebar ready for a new chat. The popped-out tab keeps the scroll bar at the window
edge while the chat content stays centered, and the tab name is the only conversation title shown in
that workspace view. Assistant responses render as full-width text in both the sidebar and popped-out
tabs instead of bordered bubbles, with text aligned to the prompt input. For Claude CLI, Memry checks
that `claude` is available on `PATH`, that it reports version `2.1.0` or newer, and that the Agent
disclosure has been accepted. For local models, configure a compatible server in
[Settings -> AI Assistant -> Agent Providers](/user-guide/settings#agent-providers) first.
If the global AI switch is off in [Settings -> AI](/user-guide/settings#ai), the Agent tab and Agent
MCP current-note bridge are hidden and inactive.

Agent Chat can:

- keep local conversation history in the vault database
- attach the active note as context for a turn
- mention notes, tasks, journals, inbox items, and calendar events inline in a prompt with `@`
- stream assistant text back into the sidebar
- link returned or created Memry items directly in assistant replies, with a collapsible Sources
  section for the same items
- show collapsed tool calls, tool results, and optional approvals inline in the chat stream
- stop an in-flight turn
- compact older conversation history when a prompt grows too large

When a tool result includes a real Memry reference, Agent Chat renders that item as a clickable
mention instead of plain text. Lists link each returned note, task, inbox item, journal entry,
calendar event, project, or folder that has a navigable reference. Create and update confirmations
also link the affected item when the tool returns its ID or journal date. The reply footer shows a
collapsible Sources section only when the assistant message contains those Memry item links.
Inbox snooze confirmations use the same explicit inbox item reference as other inbox writes.

Memry only links explicit tool-provided references. Plain titles without an ID or date stay as
normal text. Clickable item mentions use Memry's standard link color, show a dotted underline on
hover, and display the matching item icon before the title. Notes use their custom note icon when
one exists, inbox items use their capture-type icon, and journal, calendar, and task links use the
same visual language as the main app surfaces.

Press <kbd>Enter</kbd> to send the prompt. Press <kbd>Shift</kbd>+<kbd>Enter</kbd> to insert a
new line in the prompt box.

Type `@` in the prompt to open the mention picker. Notes, tasks, journals, inbox items, and calendar
events appear with their item icons, and calendar events are read from the local calendar with
archived events hidden. Choosing a result replaces the active `@` query with one inline tag, so a
prompt such as `summarize @Star Wars Movies` keeps the referenced item visibly attached inside the
prompt. Mention tags submit as readable `@Title` text plus an encrypted structured attachment
reference.

The prompt box uses the operating-system text editing menu, so Cut, Copy, Paste, Select All, and
native right-click editing work like other text fields.

Stop requests are scoped to the active conversation across Claude, Codex, and local providers.
Automatic title generation and conversation summaries run through the selected backend without
exposing Memry MCP tools.

The prompt bar shows the selected agent provider. The provider is pinned per conversation; changing
it after messages exist updates the conversation and records the switch in the chat history. Claude
and Codex expose prompt-time reasoning effort settings, with provider-specific settings shown only
for the active provider.

Claude and Codex conversations also have a per-conversation model selector. Memry starts Claude on
`opus` and Codex on the highest suggested GPT version, then passes the selected model through to the
CLI for each turn. The built-in model list is only a shortcut for common CLI aliases; type a custom
model ID when you want to pin another CLI-supported model.

Local model support uses OpenAI-compatible HTTP APIs. Memry ships presets for Ollama, LM Studio, and
llama.cpp server, plus a Custom endpoint. Local tool access is gated by a capability probe. If the
model can emit tool calls and continue after a tool result, Memry enables the full vault tool set. If
the probe fails, local chat can still answer from attached context, but vault tool calls stay
disabled.

When no conversation is selected yet, the prompt box stays available. Sending the first prompt
creates a new Agent Chat conversation, attaches the active note when one is open, and streams the
reply into the sidebar.

New conversations start with a temporary title. When you send the first prompt, the selected chat
backend also generates a short conversation title. Memry stores that title on the encrypted
conversation row and refreshes the sidebar title without giving the title-generation subprocess
access to Memry MCP tools.

Conversation rows, message bodies, and message attachments are encrypted at rest before they are
written to SQLite. Free accounts keep agent chat history local-only. Paid accounts can sync finalized
conversations and terminal messages through Memry Sync; in-progress streaming messages are not
enqueued until the turn finishes.

If Memry cannot verify the local vault key for the current database, Agent Chat stays unavailable
instead of opening unreadable conversation history. A fresh local vault can initialize a new local key
without sign-in; an existing vault with a mismatched or missing keychain key must be recovered through
the normal vault recovery flow.

## Connection

The endpoint is:

```text
http://127.0.0.1:<port>/mcp
```

External MCP clients must send:

```text
Authorization: Bearer <token>
```

The token is generated in memory for the current app launch. It is not saved to disk, changes when
Memry restarts, and can be rotated manually from settings. Missing or stale tokens receive `401`.

Client-specific config keys vary. Use the copied URL as the MCP server URL and the copied token as a
Bearer authorization header. Plain external clients can use read tools, but they do not get the
in-app conversation/window context that approved writes require.

## Tools

Read tools are available to Agent Chat and external MCP clients:

- `vault_search_notes`
- `vault_read_note`
- `vault_list_folder`
- `vault_get_current_note`
- `vault_list_tasks`
- `vault_get_task`
- `vault_list_projects`
- `vault_get_project`
- `vault_list_statuses`
- `vault_get_journal_entry`
- `vault_list_journal_entries`
- `vault_list_inbox_items`
- `vault_get_inbox_item`
- `vault_get_tags`
- `vault_desktop_read`

Create, update, delete, archive, move, and reorder tools require Agent Chat context and explicit
approval:

- `vault_create_note`
- `vault_rename_note`
- `vault_delete_note`
- `vault_create_folder`
- `vault_rename_folder`
- `vault_delete_folder`
- `vault_create_task`
- `vault_delete_task`
- `vault_complete_task`
- `vault_uncomplete_task`
- `vault_archive_task`
- `vault_unarchive_task`
- `vault_move_task`
- `vault_reorder_tasks`
- `vault_duplicate_task`
- `vault_convert_task_to_subtask`
- `vault_convert_subtask_to_task`
- `vault_create_project`
- `vault_update_project`
- `vault_delete_project`
- `vault_archive_project`
- `vault_reorder_projects`
- `vault_create_status`
- `vault_update_status`
- `vault_delete_status`
- `vault_reorder_statuses`
- `vault_create_journal_entry`
- `vault_update_journal_entry`
- `vault_delete_journal_entry`
- `vault_add_to_inbox`
- `vault_update_inbox_item`
- `vault_snooze_inbox_item`
- `vault_archive_inbox_item`
- `vault_unarchive_inbox_item`
- `vault_delete_inbox_item`
- `vault_add_inbox_tag`
- `vault_remove_inbox_tag`
- `vault_update_note`
- `vault_update_task`
- `vault_add_tag`
- `vault_remove_tag`
- `vault_move_to_folder`
- `vault_desktop_write`

`vault_desktop_read` and `vault_desktop_write` cover the remaining desktop CRUD surface through an
allowlisted desktop API operation name plus an `args` array. They are used for desktop domains such
as templates, saved filters, bookmarks, reminders, calendar events, folder views, properties, tags,
search reasons, and settings. The write bridge uses the same in-app approval flow as named write
tools. Security-sensitive and system operations stay outside the allowlist, including account/auth
flows, provider connect/disconnect/refresh actions, app updater actions, external open/reveal
actions, and raw secret writes. Unsupported or unavailable desktop API operations return a structured
MCP error instead of falling back to an arbitrary desktop call.

Calendar desktop reads accept the same single-object shape as the renderer bridge. For example:
`calendar.getProviderStatus` with no args or `args: [{}]` checks Google provider status,
`calendar.listEvents` accepts `args: [{}]`, and `calendar.getRange` accepts either
`args: ["2026-05-14", "2026-06-14"]` or
`args: [{"startAt": "2026-05-14T00:00:00.000Z", "endAt": "2026-06-15T00:00:00.000Z"}]`.

By default, Agent Chat accepts these tool calls automatically. The chat still shows each requested
tool in a collapsed tool row, including running, completed, error, and denied states, so you can open
the row to inspect parameters and results.

If you switch tool confirmations to **Ask first** in settings, Memry pauses the turn and shows inline
approval controls inside the tool row. You can allow the request once, allow create tools always for
that conversation, deny it, or edit the arguments before allowing. Note updates load a before/after
diff before the write is applied. Unauthenticated or context-free write requests continue to be
denied.

## Current Note

`vault_get_current_note` can snapshot the active note when the request is associated with a Memry
window. Plain external clients do not have that window context, so the tool returns `null` instead
of guessing.

## Privacy

The MCP server binds only to localhost. Read tools still expose the content they return to the
client you configure, so only paste the token into clients you trust on this machine. Write tools
still require an active Agent Chat conversation context, and the in-app tool confirmation setting
decides whether that conversation pauses for approval or accepts the call automatically.

Provider privacy depends on the selected backend:

- Claude and Codex providers may send prompts, attachments, and tool results through that provider.
- Local loopback providers keep model prompts on this machine, except for the actual tool effects
  Memry applies inside the vault after approval.
- Custom non-loopback endpoints send data to the configured endpoint and must be explicitly enabled
  with the not-fully-local warning.

# Agent Chat & MCP Server

memrynote can run an in-app Agent Chat backed by a provider-neutral agent backend. Claude CLI is the
first full backend, local OpenAI-compatible servers can be used for BYO local models, and the Codex
CLI backend uses the same contract when enabled. After a vault opens, the desktop app keeps the
Agent runtime idle until Agent Chat or Agent MCP is opened. At that point it starts a local MCP
endpoint on `127.0.0.1` with a random port, then gives the selected backend only the vault tools for
the current conversation.

Opening the Agent MCP settings uses the same lazy start path as opening Agent Chat. If the runtime is
still starting, memrynote retries the status check until the vault-scoped endpoint, bearer token, and
tool list are ready to copy.

The Agent runtime and MCP endpoint are scoped to the open vault. Closing or switching vaults stops
active turns, clears pending tool approvals, and restarts the Agent services for the next vault.

The same MCP endpoint can also be copied into other desktop AI clients for vault read tools.

Open [Settings -> AI Assistant -> Agent MCP](/user-guide/settings#agent-mcp) to copy the current
endpoint and bearer token. Open
[Settings -> AI Assistant -> Agent Permissions](/user-guide/settings#agent-permissions) to set the
default Agent Chat access mode and action-confirmation behavior.

## Agent Chat

Open the right sidebar, choose **Agent**, and pick a provider. The compact Day/Agent switch keeps
the active view highlighted at the top of the right sidebar, and switching to Agent takes effect on
the first click even when the sidebar opened on the Day view. The assistant backend still starts up
on first use rather than at launch, so the panel can show a brief loading state while providers and
conversation history are detected. The Agent header includes a
new-conversation button, a history menu for switching back to recent conversations, and a pop-out
button for moving the current conversation into a workspace tab. Popped-out conversations keep the
generated conversation title as the tab name, use the same centered reading column as notes, and
leave the right sidebar ready for a new chat. The popped-out tab keeps the scroll bar at the window
edge while the chat content stays centered, and the tab name is the only conversation title shown in
that workspace view. Assistant responses render as full-width text in both the sidebar and popped-out
tabs instead of bordered bubbles, with text aligned to the prompt input. For Claude CLI, memrynote checks
that `claude` is available on `PATH`, that it reports version `2.1.0` or newer, and that the Agent
disclosure has been accepted; the Codex CLI is detected the same way. On macOS and Linux, memrynote
resolves your login shell's `PATH` at startup, so CLIs installed in shell-managed locations
(`~/.local/bin`, Homebrew, nvm, volta) are still found when the app is launched from the Dock or
Finder rather than from a terminal. For local models, configure a compatible server in
[Settings -> AI Assistant -> Agent Permissions](/user-guide/settings#agent-permissions) first.
If the global AI switch is off in [Settings -> AI](/user-guide/settings#ai), the Agent tab and Agent
MCP current-note bridge are hidden and inactive.

Agent Chat can:

- keep local conversation history in the vault database
- attach the active note as context for a turn
- mention notes, tasks, journals, inbox items, and calendar events inline in a prompt with `@`
- stream assistant text back into the sidebar
- link returned or created memrynote items directly in assistant replies, with a collapsible Sources
  section for the same items
- show collapsed tool calls, tool results, and optional approvals inline in the chat stream
- stop an in-flight turn
- compact older conversation history when a prompt grows too large

When a tool result includes a real memrynote reference, Agent Chat renders that item as a clickable
mention instead of plain text. Lists link each returned note, task, inbox item, journal entry,
calendar event, project, or folder that has a navigable reference. Create and update confirmations
also link the affected item when the tool returns its ID or journal date. The reply footer shows a
collapsible Sources section only when the assistant message contains those memrynote item links.
Inbox snooze confirmations use the same explicit inbox item reference as other inbox writes.

memrynote only links explicit tool-provided references. Plain titles without an ID or date stay as
normal text. Clickable item mentions use memrynote's standard link color, show a dotted underline on
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
exposing memrynote MCP tools.

The prompt bar shows the selected agent provider. The provider is pinned per conversation; changing
it after messages exist updates the conversation and records the switch in the chat history. Claude
and Codex expose prompt-time reasoning effort settings, with provider-specific settings shown only
for the active provider. The same compact prompt bar has a per-turn permissions menu. It starts from
your default Agent Permissions setting, then lets you send a single turn as **Vault only** or
**Computer access**, and optionally allow web search for that turn.

**Vault only** keeps the CLI backend constrained to memrynote vault tools. **Computer access** gives the
backend broader local CLI access for that turn. Web search is passed through only when the selected
backend supports it.

Claude and Codex conversations also have a per-conversation model selector. memrynote starts Claude on
`opus` and Codex on the highest suggested GPT version, then passes the selected model through to the
CLI for each turn. The built-in model list is only a shortcut for common CLI aliases; type a custom
model ID when you want to pin another CLI-supported model.

Local model support uses OpenAI-compatible HTTP APIs. memrynote ships presets for Ollama, LM Studio, and
llama.cpp server, plus a Custom endpoint. Local tool access is gated by a capability probe. If the
model can emit tool calls and continue after a tool result, memrynote enables the full vault tool set. If
the probe fails, local chat can still answer from attached context, but vault tool calls stay
disabled.

If the configured local provider is not running, the model picker returns no discovered models
instead of treating the settings page as an Agent runtime error. Start the provider, then load models
or test the connection again.

When no conversation is selected yet, the prompt box stays available. Sending the first prompt
creates a new Agent Chat conversation, attaches the active note when one is open, and streams the
reply into the sidebar.

New conversations start with a temporary title. When you send the first prompt, the selected chat
backend also generates a short conversation title. memrynote stores that title on the encrypted
conversation row and refreshes the sidebar title without giving the title-generation subprocess
access to memrynote MCP tools.

Conversation rows, message bodies, and message attachments are encrypted at rest before they are
written to SQLite. Free accounts keep agent chat history local-only. Paid accounts can sync finalized
conversations and terminal messages through memrynote Sync; in-progress streaming messages are not
enqueued until the turn finishes.

If memrynote cannot verify the local vault key for the current database, Agent Chat stays unavailable
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
memrynote restarts, and can be rotated manually from settings. Missing or stale tokens receive `401`.

The localhost MCP endpoint can serve overlapping Agent Chat turns and external read requests. memrynote
keeps the URL/token stable for the app session, but handles each MCP request with an isolated
transport so one client connection does not block another.

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
- `vault_list_canvases`
- `vault_read_canvas`
- `vault_desktop_read`

### Notes and filed files

Filing a PDF, image, audio file, or video into the vault indexes it alongside your markdown notes,
so it can turn up in `vault_search_notes`. Every search hit therefore carries a `file_type`:

- `markdown` — a real note. `vault_read_note` returns its content.
- `pdf`, `image`, `audio`, `video` — a filed file. There is no markdown to read, so
  `vault_read_note` refuses it with a `VALIDATION` error naming the file type instead of returning
  bytes for the client to treat as text. `vault_update_note` refuses it the same way, so an agent
  cannot overwrite a filed document with markdown.

Pass `file_types` to narrow the search up front — `["markdown"]` for notes only, or
`["pdf", "image"]` to look for filed documents. The filter runs inside the search query, so `limit`
counts only matching rows. Omit `file_types` to search every file type.

Notes indexed by older memrynote versions have no recorded file type; those are always treated as
markdown, so upgrading never hides existing notes.

Create, update, delete, archive, move, and reorder tools require Agent Chat context. They can be
auto-accepted or shown for inline approval depending on the Agent Permissions setting:

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
- `vault_add_canvas_item`
- `vault_remove_canvas_item`
- `vault_desktop_write`

### Canvas

| Tool                       | What it does                                                                      |
| -------------------------- | --------------------------------------------------------------------------------- |
| `vault_list_canvases`      | Every canvas, with how many items sit on each                                     |
| `vault_read_canvas`        | One canvas: the notes/tasks/events on it (with titles) and any text written on it |
| `vault_add_canvas_item`    | Put existing notes/tasks/events on a canvas as cards                              |
| `vault_remove_canvas_item` | Take a card off a canvas                                                          |

Canvas tools need the **Spatial Canvas** feature turned on (Settings → Features). With it off they
return a message saying so rather than failing silently.

Reading a canvas never returns the drawing itself. An agent gets what is _on_ the canvas, not the
geometry that draws it — a scene is mostly coordinates and style properties, and dumping it into an
agent's context crowds out everything useful. Long canvases cap the amount of text returned and say
so with `texts_truncated`.

Adding an item applies to the open editor when you have that canvas open, so the card appears while
you watch instead of being overwritten by the next autosave. A canvas nobody has open is updated
directly, and the write is rejected if it changed in the meantime. If the result is too large to
sync, the tool response says so.

Some canvas operations are deliberately unavailable through `vault_desktop_read` /
`vault_desktop_write`:

- `canvas.get` — returns the whole scene; use `vault_read_canvas`
- `canvas.update` — replaces the entire scene with no version check, which would overwrite whatever
  you have open; use the item tools
- `canvas.librarySave` — saves the shape library as one whole list, so a partial one deletes shapes
- `canvas.uploadAsset` — binary image upload, no agent path yet

Agents cannot draw arrows between cards. An arrow on a canvas is a picture, not a stored
relationship, so an agent drawing one would look like it created a link when it did not. Use wiki
links between notes when you want a real connection.

`vault_desktop_read` and `vault_desktop_write` cover the remaining desktop CRUD surface through an
allowlisted desktop API operation name plus an `args` array. They are used for desktop domains such
as templates, saved filters, bookmarks, reminders, calendar events, folder views, properties, tags,
search reasons, inbox conversions, project links, and settings. The write bridge uses the same in-app
approval flow as named write tools. Security-sensitive and system operations stay outside the
allowlist, including account/auth flows, provider connect/disconnect/refresh actions, app updater
actions, external open/reveal actions, import dialogs, OS settings panes, telemetry, feedback and
diagnostics reporting, and raw secret writes. Unsupported or unavailable desktop API operations
return a structured MCP error instead of falling back to an arbitrary desktop call.

Inbox items convert through the bridge into any of the four targets the app itself offers:
`inbox.convertToNote`, `inbox.convertToTask`, `inbox.convertToEvent`, and
`inbox.convertToReminder`. `notes.applyTemplate` applies a template the agent can already read
through `templates.get` to an existing note.

`settings.getFeaturesSettings` reports which surfaces are turned on — home, inbox, journal, tasks,
calendar, graph, and spatial canvas — so an agent can tell whether an action is even available
before suggesting it, and `settings.setFeaturesSettings` toggles them. `settings.getInboxSettings`
and `settings.setInboxSettings` cover the daily inbox review reminder.

Tag categories are reachable through the same bridge. `tags.listCategories` is a read operation that
returns `{"success": true, "categories": [...]}`, where each entry carries its id, name, sort order,
and tag count. `tags.createCategory`, `tags.renameCategory`, `tags.deleteCategory`, and
`tags.reorder` are write operations behind the usual approval flow; `tags.createCategory` returns
`{"success": true, "category": {...}}` and the other three return `{"success": true}`. Like the rest
of the desktop bridge, these operations report their own failures as `{"success": false, "error":
"..."}` rather than raising an MCP error, so check `success` before reading the payload.
`tags.reorder` applies a drag result — tag-to-category assignments, category ordering, or both in one
transaction — and is the only way to move a tag into a category. Deleting a category keeps its tags
and makes them uncategorized.

`vault_get_tags` returns each tag with its `color`, `icon`, `sort_order`, `category_id`, and
`category_name`. Both category fields are `null` for an uncategorized tag.

Calendar desktop reads accept the same single-object shape as the renderer bridge. For example:
`calendar.listEvents` accepts `args: [{}]`, and `calendar.getRange` accepts either
`args: ["2026-05-14", "2026-06-14"]` or
`args: [{"startAt": "2026-05-14T00:00:00.000Z", "endAt": "2026-06-15T00:00:00.000Z"}]`.

Google-integration operations — calendar sources, provider status, Google calendar lists, promoting
external events, and Google calendar settings — are excluded from the agent allowlists outright.

Google-synced events themselves are gated on explicit user consent. `calendar.getRange` resolves
`includeExternal` from the stored answer to the **Let AI read Google Calendar events** setting, never
from the caller: an agent that passes `includeExternal: true` still gets native-only results unless
the user granted access. Not asked yet, declined, or a settings read that failed all resolve to
native-only. See [Calendar → Google Data and AI Features](/user-guide/calendar#google-data-and-ai-features).

Google user data is never used to train or improve AI models, in line with the Google API Services
User Data Policy (Limited Use).

By default, Agent Chat accepts these tool calls automatically. The chat still shows each requested
tool as compact, subdued text with a readable label such as `Reading note` or `Creating task`.
Click the label to open or close the details area with the raw MCP tool name, parameters, and
results.

If you switch tool confirmations to **Ask first** in settings, memrynote pauses the turn and shows inline
approval controls inside the tool row. You can allow the request once, allow create tools always for
that conversation, deny it, or edit the arguments before allowing. Note updates load a before/after
diff before the write is applied. Unauthenticated or context-free write requests continue to be
denied.

## Project Links

`vault_list_projects` returns each project's `icon`, `home_note_id`, and `linked_counts` (notes,
files, events) alongside `task_count`. Nonzero `linked_counts` are the signal that a project has a
hub link layer worth reading; `task_count` alone says nothing about it.

The hub's link layer is reachable through the desktop bridge. Reads, via `vault_desktop_read`:

| Operation                   | Args                 | Answers                                          |
| --------------------------- | -------------------- | ------------------------------------------------ |
| `tasks.listProjectContents` | `[projectId]`        | Which notes, files, and events a project holds    |
| `tasks.listProjectLinks`    | `[projectId]`        | The raw link rows, including pin state            |
| `tasks.listForItem`         | `[itemType, itemId]` | Which projects a note, file, or event belongs to  |

`itemType` is one of `note`, `file`, or `calendar_event`.

Writes, via `vault_desktop_write`, behind the same approval flow as other writes:

| Operation                    | Args                                |
| ---------------------------- | ----------------------------------- |
| `tasks.linkProjectItem`      | `[{ projectId, itemType, itemId }]` |
| `tasks.unlinkProjectItem`    | `[{ projectId, itemType, itemId }]` |
| `tasks.setProjectLinkPinned` | `[{ projectId, itemId, pinned }]`   |
| `tasks.setProjectHomeNote`   | `[{ projectId, noteId }]`           |
| `tasks.captureUrlToProject`  | `[{ projectId, url }]`              |
| `tasks.importFilesToProject` | `[{ projectId, sourcePaths }]`      |

`setProjectHomeNote` takes `noteId: null` to clear the project's home note, the same way the hub's
own overview rail does.

`captureUrlToProject` fetches the page title over the network, and `importFilesToProject` copies
files from paths you supply into the vault — both on caller-supplied input, like the already
available `inbox.captureLink` and `notes.importFiles`. Operations that open native UI or hand an
item to the OS stay out of the allowlist.

`importFilesToProject` waits for the indexer to assign an id to each imported file, so importing
several large files at once can exceed the bridge's ten-second window. The import still completes;
the tool call reports a timeout. Import in smaller batches to see the result.

## Current Note

`vault_get_current_note` can snapshot the active note when the request is associated with a memrynote
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
  memrynote applies inside the vault after approval.
- Custom non-loopback endpoints send data to the configured endpoint and must be explicitly enabled
  with the not-fully-local warning.

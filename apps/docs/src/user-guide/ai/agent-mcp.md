# Agent Chat & MCP Server

Memry can run an in-app Agent Chat backed by the Claude Code CLI. The desktop app starts a local
MCP endpoint on `127.0.0.1` with a random port, then launches Claude with a strict MCP config for the
current conversation.

The same MCP endpoint can also be copied into other desktop AI clients for vault read tools.

Open [Settings -> Agent MCP](/user-guide/settings#agent-mcp) to copy the current endpoint and
bearer token.

## Agent Chat

Open the right sidebar, choose **Agent**, and enable Claude CLI chat. Memry checks that `claude` is
available on `PATH`, that it reports version `2.1.0` or newer, and that the Agent disclosure has been
accepted.

Agent Chat can:

- keep local conversation history in the vault database
- attach the active note as context for a turn
- stream assistant text back into the sidebar
- stop an in-flight turn
- compact older conversation history when a prompt grows too large

Conversation rows, message bodies, and message attachments are encrypted at rest before they are
written to SQLite. Free accounts keep agent chat history local-only. Paid accounts can sync finalized
conversations and terminal messages through Memry Sync; in-progress streaming messages are not
enqueued until the turn finishes.

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
- `vault_list_projects`
- `vault_get_journal_entry`
- `vault_list_journal_entries`
- `vault_list_inbox_items`
- `vault_get_tags`

Create and update tools require Agent Chat context and explicit approval:

- `vault_create_note`
- `vault_create_task`
- `vault_create_journal_entry`
- `vault_add_to_inbox`
- `vault_update_note`
- `vault_update_task`
- `vault_add_tag`
- `vault_remove_tag`
- `vault_move_to_folder`

When Claude requests one of these tools from Agent Chat, Memry pauses the turn and shows an approval
modal. You can allow the request once, allow the tool always for that conversation, deny it, or edit
the arguments before allowing. Note updates show a before/after diff before the write is applied.
Unauthenticated or context-free write requests continue to be denied.

## Current Note

`vault_get_current_note` can snapshot the active note when the request is associated with a Memry
window. Plain external clients do not have that window context, so the tool returns `null` instead
of guessing.

## Privacy

The MCP server binds only to localhost. Read tools still expose the content they return to the
client you configure, so only paste the token into clients you trust on this machine. Write tools are
only applied after the in-app approval gate resolves for the active Agent Chat conversation.

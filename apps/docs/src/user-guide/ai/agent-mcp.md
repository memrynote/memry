# Agent MCP Server

Memry can expose a local MCP endpoint so desktop AI clients can read your vault through
approved tools. The server runs inside the desktop app on `127.0.0.1` with a random port.

Open [Settings -> Agent MCP](/user-guide/settings#agent-mcp) to copy the current endpoint and
bearer token.

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
Bearer authorization header.

## Tools

Read tools are active:

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

Create and update tools are registered so clients can see the full planned surface, but they return
`PERMISSION_DENIED` until the in-app approval flow ships:

- `vault_create_note`
- `vault_create_task`
- `vault_create_journal_entry`
- `vault_add_to_inbox`
- `vault_update_note`
- `vault_update_task`
- `vault_add_tag`
- `vault_remove_tag`
- `vault_move_to_folder`

Plain external clients cannot enable these write tools by themselves. When Memry Agent conversations
provide an in-app approval gate, the same running MCP server can route approved writes for that
conversation while unauthenticated or context-free write requests continue to be denied.

## Current Note

`vault_get_current_note` can snapshot the active note when the request is associated with a Memry
window. Plain external clients do not have that window context, so the tool returns `null` instead
of guessing.

## Privacy

The MCP server binds only to localhost. Read tools still expose the content they return to the
client you configure, so only paste the token into clients you trust on this machine. Write tools are
not active until Memry can show an approval prompt for each create or update request.

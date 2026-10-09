# Agent Backends

Agent Chat can run on four backends. They differ in what the agent can reach outside your vault.
Here is an example. You ask the agent to read a log in your Downloads folder. Claude Code with
**Computer access** reads the file. The built-in model connection cannot: it has the memrynote vault
tools and nothing else.

This page lists what each backend can reach, how long a turn can run, and how its reasoning shows.
For setup, see [Agent Chat & MCP Server](/user-guide/ai/agent-mcp) and
[Provider Setup](/user-guide/ai/provider-setup#agent-chat-built-in-model).

## What each backend can reach

The model menu in the prompt bar has an **Access** setting and a **Web search** switch:

- **Vault only**: the agent gets the memrynote vault tools. It reads and writes notes, tasks,
  journal entries and the rest of your vault, and every change asks you first unless you turned
  that off.
- **Computer access**: the agent also gets the backend's own tools, such as a shell and files
  outside the vault.
- **Web search**: the agent can search and fetch web pages for that turn.

| Backend                                                                           | Vault only | Computer access | Web search | Step limit set by memrynote | Reasoning control         | Reasoning shown                |
| --------------------------------------------------------------------------------- | ---------- | --------------- | ---------- | --------------------------- | ------------------------- | ------------------------------ |
| Claude Code (`claude`)                                                            | Yes        | Yes             | Yes        | None                        | Effort: low to max        | Yes, in a "Thinking" block     |
| Codex (`codex`)                                                                   | Yes        | Yes             | Yes        | None                        | Effort: low to extra high | Yes, reasoning summaries       |
| Antigravity (`agy`)                                                               | Yes        | Yes             | Yes        | None                        | Part of the model id      | No                             |
| Built-in model connection                                                         | Yes        | No              | No         | 24 model calls              | Default, High, Max        | Yes, when the model streams it |
| External MCP clients (see [below](#driving-memrynote-from-an-external-cli-agent)) | Read only  | Their own       | Their own  | Their own                   | Their own                 | In their own window            |

### Claude Code, Codex and Antigravity

These three run the CLI installed on your computer. memrynote starts it for each turn and connects
it to the vault tools.

- **Vault only** turns get no shell and no file access outside the vault. Web search is added only
  when you turn it on.
- **Computer access** turns give the CLI its own tools, such as a shell and file edits, with access
  to your whole disk. Codex and Antigravity run them without asking. Claude Code runs without
  prompts too, so a tool its own permission settings do not allow is refused rather than asked
  about.
- memrynote sets no step limit. A turn runs until the CLI finishes or you press Stop.
- Claude Code and Codex take a reasoning effort from the prompt bar. Antigravity model ids carry
  their own tier, such as `gemini-3.1-pro-high`.

### Built-in model connection

The built-in model connection talks to any OpenAI-compatible server: Ollama, LM Studio, llama.cpp
server, or a hosted API such as DeepSeek through the Custom preset.

- It has the memrynote vault tools only: no shell, no files outside the vault, and no web search.
  With this backend selected, **Computer access** and **Web search** show as unavailable with the
  reason "Vault tools only with this model", and the turn runs vault-only. Your saved default does
  not change.
- Vault tools turn on only after a capability check passes for the model. If the check fails, the
  model answers from the attached context and the reply says that tools are off and why.
- A turn with tools can make up to 24 model calls. The last call runs without tools and asks the
  model to hand off what is done and what is left. The reply then ends with **Stopped at the step
  limit** and a **Continue** button, which sends "Continue" as a new message in the same
  conversation.
- **Effort** in the prompt bar sends `reasoning_effort` for **High** and **Max**; **Default** sends
  nothing. **Thinking: Off** in the connection settings sends `thinking: {"type": "disabled"}`.
  Both controls are hidden for the Ollama preset.
- Reasoning that the server returns as `reasoning_content` shows in a "Thinking" block above the
  answer.

There are no plans to give the built-in backend a shell, file or web tools. If you need a command
line, files outside the vault or web search, use Claude Code, Codex or Antigravity with
**Computer access**.

## Driving memrynote from an external CLI agent

You can also run a CLI agent in your own terminal and point it at your vault. memrynote supports
two setups.

### Read through the MCP server

memrynote starts a local MCP server the first time you open Agent Chat, or the **Agents** or
**Connect** tab of the AI Assistant settings, after a vault opens. Copy its URL and bearer token from [Settings → AI Assistant → Agent MCP](/user-guide/settings#agent-mcp), then
add them to your agent as an HTTP MCP server. For example, with Claude Code:

```bash
claude mcp add --transport http memrynote http://127.0.0.1:<port>/mcp \
  --header "Authorization: Bearer <token>"
```

With Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.memrynote]
url = "http://127.0.0.1:<port>/mcp"
bearer_token_env_var = "MEMRYNOTE_MCP_TOKEN"
```

Then set `MEMRYNOTE_MCP_TOKEN` to the token in the shell that runs `codex`.

Limits of this setup:

- External clients are read-only. The write tools are listed, but a call fails with
  `PERMISSION_DENIED`, because writes need a turn that memrynote itself is running.
- The port and token change each time memrynote starts or switches vault, and when you rotate the
  token. Update your agent's configuration after that.
- `vault_get_current_note` returns `null`, because an external client has no memrynote window.

### Write through the `memrynote` command

For changes, have the agent run the [`memrynote` command line](/user-guide/cli) with `--json`, for
example `memrynote --json notes update <id> --append "..."`. The command writes to the vault
directly. It does not go through Agent Chat's approval prompts, so give it only to an agent you
trust with your vault.

### Use Agent Chat instead

When you want both writes with approval and a shell, run Claude Code, Codex or Antigravity as the
Agent Chat backend with **Computer access**. memrynote starts the CLI, hands it a write capability
for that turn only, and shows each change for approval.

# Settings Reference

Every panel in the Memry settings modal, in one searchable page. Open with <kbd>Cmd</kbd>+<kbd>,</kbd> or from the sidebar menu.

Settings are organized into four groups:

- **Workspace** — how Memry behaves day-to-day (Account, General, Templates, Editor, Journal, Tasks, Calendar)
- **Preferences** — your personal taste (Appearance, Keyboard Shortcuts)
- **Services** — external integrations and AI (AI Assistant, Integrations)
- **Data** — what's on disk and metadata (Vault, Tags, Properties)

<!-- screenshot: settings modal with sidebar of sections -->

---

## Account

### Identity

The signed-in email and current subscription plan. Read-only — sign in or out from the security group below.

### Sync

A toggle to enable or pause cloud sync, plus a status indicator and the time of the last successful sync.

### Storage

A breakdown of vault size by category — notes, attachments, CRDT data, and other. The refresh button recomputes totals on demand. Visible only when signed in.

### Devices

A list of devices that have been linked to your account. Rename or revoke from the device row menu.

### Security

- **Recovery Key** — re-display the recovery phrase after passphrase confirmation
- **Rotate Keys** — re-encrypt the vault key with a new master key and reseal it for each linked device
- **Sign Out** — clears the session (with a confirmation dialog)

---

## General

### Startup

**Launch at Login** auto-starts Memry when you log in.

### Updates

Shows the installed version. If a newer version is available, a button lets you check, download, and install.

### Language & Region

- **Language** — UI locale dropdown
- **Clock Format** — 12-hour or 24-hour

### Tab Behavior

- **Preview Mode** — open single-clicked items in a reused preview tab
- **Restore Session** — reopen the previous session's tabs on launch
- **Tab Close Button** — always visible, hover only, or active tab only

### File Creation

**Create in Selected Folder** routes new notes into whichever folder is currently selected in the sidebar.

### Privacy

**Telemetry** opts in or out of anonymous usage analytics. Off by default. Only enums and surface names are sent — never note content.

---

## Templates

### Built-in Templates

Memry-provided templates. Read-only; duplicate to make an editable copy.

### My Templates

Custom templates you've made. Edit, duplicate, or delete from each row.

A **Create Template** button opens the [template editor](/user-guide/templates).

---

## Editor

### Layout

**Width** sets the writing column — narrow, medium, or wide.

### Toolbar

**Sticky / Floating** controls whether the formatting toolbar stays pinned to the top or floats above selections.

### Writing

- **Spell Check** — toggle browser spellcheck
- **Auto-Save Delay** — slider 0–30 seconds (default ~1s); content flushes sooner on tab close, app quit, or sync
- **Show Word Count** — display word count in the editor footer

---

## Journal

### Default Template

Pick the template seeded into new journal entries.

### Sidebar Visibility

Show or hide journal sidebar panes:

- **Show Schedule** — calendar / events for the date
- **Show Tasks** — tasks due that day
- **Show AI Connections** — semantically related entries

### Footer

**Show Stats Footer** displays writing statistics (word, character, and entry counts).

---

## Tasks

### Defaults

- **Default Project** — which project new tasks are assigned to
- **Default Sort Order** — manual, due date, priority, or created date

### Calendar

**Week Start** — Sunday or Monday.

### Inbox

**Stale Inbox Days** — number of days a task can sit in the inbox before being flagged stale (1–90).

---

## Calendar

### Day Cell Click Behavior

- **Default Day Cell Click** — clicking a date opens the journal entry or the calendar view
- **Calendar Page Override** — same behavior, overridable for the calendar page specifically

---

## Appearance

### Theme

Light, White, Dark, or System (follow OS).

### Accent Color

Eight presets — indigo, amber, emerald, red, violet, cyan, pink, orange — plus a custom `#RRGGBB` input. Orange is the default accent.

### Typography

- **Font Size** — Small / Medium / Large
- **Font Family** — System, Sans-Serif, Serif, Monospace, Gelasio, Geist, Inter

---

## Keyboard Shortcuts

### Global Capture

Set a system-wide hotkey to focus the Memry window from anywhere. macOS requires Accessibility permission.

### Shortcut List

Searchable, grouped by category (Navigation, Tabs, Editor, View). Click any row to capture a new binding. Custom bindings show a badge.

### Reset All

Appears only if you've customized shortcuts. Restores defaults.

For the full default list see [Keyboard Shortcuts](/user-guide/keyboard-shortcuts).

---

## AI

### Enable

A master toggle for AI features. Off by default — Memry never reaches out to AI services until you turn this on.

### Voice Transcription

- **Provider** — local Whisper Small (private) or OpenAI Whisper API
- **Local Model** — status, download button
- **OpenAI API Key** — password field, only shown for the OpenAI provider

### Embedding Model

- Status: loaded, loading, or not downloaded
- Dimensions and current embedding count
- **Download / Load** button
- **Rebuild Index** — re-embed all notes; shows progress

### AI Inline

Inline editor AI menu (grammar, tone, length, custom prompt).

- **Enable** — toggle on/off
- **Provider** — Ollama (local), OpenAI, or Anthropic
- **Model** — presets per provider
- **API Key** — required for OpenAI / Anthropic
- **Base URL** — defaults to `http://localhost:11434/v1` for Ollama
- **Test Connection** — verifies URL + key

### Agent Providers

Agent Chat backend settings are now collapsed inside the AI Assistant page. These are machine-local
and are not synced between devices.

- **Preset** — Ollama, LM Studio, llama.cpp, or Custom
- **Base URL** — OpenAI-compatible endpoint, such as `http://localhost:11434/v1`
- **Model** — choose from `/v1/models` when available or type a model manually
- **Tool Confirmations** — always accept Agent Chat tool calls by default, or require inline approval first
- **API Key** — optional, stored in the OS keychain
- **Test Connection** — checks the endpoint and selected model
- **Probe Tools** — verifies tool-call emission and tool-result continuation before vault tools are enabled

Loopback endpoints are treated as local. Custom non-loopback endpoints require an explicit
not-fully-local acknowledgement because prompts and tool results are sent to that server.

### Agent MCP

Local MCP server controls are also collapsed inside AI Assistant for external desktop AI clients.

- **Server URL** — localhost endpoint copied into an MCP client
- **Bearer Token** — per-launch in-memory token copied as an authorization header
- **Rotate Token** — immediately invalidates the previous token
- **Registered Tools** — count of exposed vault tools

Agent Chat backends use this same server for vault tools. Read tools do not prompt. Create and
update tools require active Agent Chat context; by default they are accepted automatically and shown
as collapsed tool rows, or they can require inline approval when **Tool Confirmations** is set to
**Ask first**. Plain external clients can use read tools, but context-free writes are denied. See
[Agent MCP Server](/user-guide/ai/agent-mcp).

---

## Integrations

### Google Calendar

Link a Google account to show external events alongside vault events on the [Calendar](/user-guide/calendar). Status and source pickers appear here.

---

## Vault

### Storage Usage

Total usage vs. quota with a stacked bar by category (notes, attachments, CRDT, other). Refresh recomputes.

### Location

The vault path on disk. **Reveal** opens it in Finder / Explorer.

---

## Tags

A tag manager listing every tag with its usage count. Rename, recolor, or delete tags globally — changes propagate across all notes.

---

## Properties

A property manager for custom note fields. Supported types:

- Text
- Number (where applicable)
- Date
- Select (single-pick, with colored options)
- Multi-select
- Checkbox
- Status (for project workflows)

Create, rename, recolor, and reorder property options.

---

## Storage Keys & Contracts

Settings persist via Zod schemas in `packages/contracts/settings-schemas.ts`. Notable keys:

- General: `theme`, `fontSize`, `fontFamily`, `accentColor`, `startOnBoot`, `language`, `clockFormat`, `createInSelectedFolder`
- Editor: `width`, `spellCheck`, `autoSaveDelay`, `showWordCount`, `toolbarMode`
- Tasks: `defaultProjectId`, `defaultSortOrder`, `weekStartDay`, `staleInboxDays`
- Calendar: `dayCellClickBehavior`, `calendarPageClickOverride`
- AI: `enabled`, `provider`, `model`
- Voice Transcription: `provider`
- Keyboard Shortcuts: `overrides` (keybinding map), `globalCapture`

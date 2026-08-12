# Settings Reference

Every panel in the memrynote settings modal, in one searchable page. Open with <kbd>Cmd</kbd>+<kbd>,</kbd> or from the sidebar menu.

Settings are organized into six groups:

- **Account** — identity, sync, billing, devices, and security
- **Application** — app-wide behavior and personal taste (General, Appearance, Keyboard Shortcuts, Command Line)
- **Editing** — the writing surface (Editor, Templates)
- **Modules** — feature toggles and per-module settings (Features, Journal, Tasks, Inbox, Calendar)
- **Services** — external integrations and AI (AI Assistant, Integrations)
- **Data** — what's on disk and metadata (Vault, Tags, Properties, Import)

<!-- screenshot: settings modal with sidebar of sections -->

---

## Account

### Identity

The signed-in email and current subscription plan. Read-only — sign in or out from the security group below.

### Sync

A toggle to enable or pause cloud sync, plus a status indicator and the time of the last successful sync.

### Billing

Shows the current sync plan, activation state, storage limit, max file size, synced vault limit, and
version-history window. **Upgrade** opens the plan page in your browser, where you choose a plan
(Plus, Pro, or Believer) and billing frequency (monthly or yearly) before continuing to Paddle
checkout. **Refresh status** asks the sync server to reconcile the latest Paddle transaction, and
**Manage billing** opens Paddle's hosted customer portal when the account has a Paddle customer id.

If checkout succeeds before the webhook finishes, Billing shows **Activation pending**. Use
**Refresh status** after a moment, or contact the billing support email shown in the panel for
refunds, chargebacks, or manual help.

### Storage

A breakdown of vault size by category — notes, attachments, CRDT data, and other. The refresh button recomputes totals on demand. Visible only when signed in.

### Devices

A list of devices that have been linked to your account. Rename or revoke from the device row menu.

### Security

- **Recovery Key** — re-display the recovery phrase after passphrase confirmation
- **Rotate Keys** — re-encrypt the vault key with a new master key and reseal it for each linked device
- **Sign Out** — clears the session (with a confirmation dialog)

The Account page footer links to the memrynote GitHub repository and issue tracker for starring the
project or sending product feedback.

---

## General

### Startup

**Launch at Login** auto-starts memrynote when you log in.

### Updates

Shows the installed version. If a newer version is available, a button lets you check, download, and install.

When memrynote finds an update it opens an in-app **update prompt** showing the new version, what you have now, and the release notes. From there you can:

- **Download** — fetch the update; progress shows on the sidebar update button, and once ready the prompt returns to offer **Restart Now** (or **Later**).
- **Remind Me Later** — dismiss for now; the prompt reappears on the next launch or update check.
- **Skip This Version** — never prompt automatically for this version again. A manual check clears the skip so the version can surface again.
- **Automatically download & install updates** — when enabled, future updates download in the background and install on the next quit without prompting.

### Language & Region

- **Language** — UI locale dropdown, 32 languages
- **Clock Format** — 12-hour or 24-hour
- **Date Format** — how calendar dates display throughout the app (`MM/DD/YYYY`, `DD/MM/YYYY`, `YYYY-MM-DD`, or `DD.MM.YYYY`). This preference is per device and isn't synced.

On a brand-new install the app picks its starting language from your operating system, mapping
regional variants onto the closest supported locale (`de-AT` → German, `pt-BR` → Portuguese,
`zh-Hans` → Simplified Chinese) and falling back to English for anything unsupported. The detected
language is saved straight away, so it is a one-time guess you can override in this dropdown.
An existing install is never re-detected — if you already have a vault, your current language stays
put across updates.

Changing the language takes effect immediately, including the native application menu. A language
change made on another device applies as soon as it syncs, without a restart.

Dates, times, weekday and month names follow the selected language rather than the operating
system, so a Japanese interface shows Japanese weekdays even on an English system. Arabic and
Hebrew switch the interface to right-to-left.

The desktop app loads the active language bundle at startup and fetches another locale when the
language setting changes. English fallback messages remain available for errors before the selected
locale has finished loading.

### Tab Behavior

- **Restore Session** — reopen the previous session's tabs on launch
- **Tab Close Button** — always visible, hover only, or active tab only

### File Creation

**Create in Selected Folder** routes new notes into whichever folder is currently selected in the sidebar.

**Default Location for New Notes** names the folder an unplaced new note goes to — a note created
with no folder in mind, such as from a quick capture. Leave it empty to use the vault root.

It only affects where a new note is written. It is not a root:

- The sidebar keeps showing your whole vault. A folder named here appears as an ordinary folder
  alongside the others; nothing is hidden or re-parented.
- Creating a note inside a folder puts it in that folder, not inside the default one.
- Every folder stays browsable. Folder View, moves, drag-and-drop, and folder paths on the sync
  wire are all relative to the vault root regardless of this setting.

### Privacy

**Telemetry** opts in or out of anonymous usage analytics. Off by default. Only enum-like event
metadata is sent — never note content, search text, tag names, or file paths.

---

## Send Feedback

The speech-bubble button in the sidebar footer, next to Settings, opens a feedback dialog. The
message is required; everything else is optional. Submissions are emailed to the team, and the
dialog lists exactly what is sent so nothing is collected out of sight:

- **Your message**, exactly as written
- **Your email**, only if you add it — when you are signed in your account email is used
  automatically. It is set as the Reply-To on the email so the team can reply to you, and is used
  for nothing else. Leave it out and the feedback arrives anonymously.
- **App version and operating system**
- **Your plan** (free, Plus, Pro or Believer) when you are signed in. The plan is read from your
  account on the server rather than sent by the app; signed-out feedback carries no plan.

Note content, titles, tags and file paths are never included.

---

## Templates

### Built-in Templates

memrynote-provided templates. Read-only; duplicate to make an editable copy.

### My Templates

Custom templates you've made. Edit, duplicate, or delete from each row's ⋯ menu.

Clicking a row — built-in or custom — opens it in the [template editor](/user-guide/templates) tab and closes Settings. The **New Template** button in the header opens an empty one.

---

## Editor

### Layout

**Width** sets the default writing column for every note and journal page — **Normal** (a comfortable reading column) or **Full width** (edge to edge). Individual notes can override this from the note's ⋮ menu (**Full width**), and the Journal has its own **Full width** toggle in its ⋮ menu — both override the global default.

### Toolbar

**Sticky / Floating** controls whether the formatting toolbar stays pinned to the top or floats above selections.

### Spelling

**Check Spelling** underlines misspelled words in notes and journals. It is **off by default**; turn it on to see squiggles as you write.

---

## Journal

### Default Template

Pick the template seeded into new journal entries.

### Sidebar Visibility

Show or hide journal sidebar panes:

- **Show Schedule** — calendar / events for the date
- **Show Tasks** — tasks due that day

### Footer

**Show Stats Footer** displays writing statistics (word, character, and entry counts).

---

## Tasks

### Defaults

- **Default Project** — which project new tasks are assigned to
- **Default Sort Order** — manual, due date, priority, or created date
- **Default View** — which tab the Tasks page opens on (All or Today). Defaults to All.

### Inbox

**Stale Inbox Days** — number of days a task can sit in the inbox before being flagged stale (1–90).

---

## Calendar

### Week Start

**Week Start** — Sunday or Monday. Sets the first day of the week everywhere in memrynote: the Calendar month, year, and mini views, the sidebar mini-calendar, task date pickers, task week filters, and relative date labels.

### Day Cell Click Behavior

- **Default Day Cell Click** — clicking a date opens the journal entry or the calendar view
- **Calendar Page Override** — same behavior, overridable for the calendar page specifically

---

## Features

Simple on/off toggles for optional or in-progress surfaces, per device.

- **Canvas** — enables the spatial canvas surface and its sidebar section. On by default. See [Canvas Overview](./canvas/overview.md).

---

## Appearance

### Theme

Light, White, Dark, or System (follow OS).

### Accent Color

Eight presets — indigo, amber, emerald, red, violet, cyan, pink, orange — plus a custom `#RRGGBB` input. Orange is the default accent.

### Typography

- **Font Size** — Small (14px) / Medium (16px) / Large (20px). Sets the base interface size; the whole app and note editor text scale with it.
- **Font Family** — System, Sans-Serif, Serif, Monospace, Gelasio, Geist, Inter

---

## Keyboard Shortcuts

### Global Capture

Set a system-wide hotkey to focus the memrynote window from anywhere. macOS requires Accessibility permission.

If your chosen hotkey is already claimed by another app, memrynote keeps its built-in quick capture hotkey (`Cmd`/`Ctrl` + `Shift` + `Space`) registered as a fallback, so quick capture keeps working. Saving keyboard settings re-checks this, and releases the fallback once your own hotkey registers successfully.

### Shortcut List

Searchable, grouped by category (Navigation, Tabs, Editor, View). Click any row to capture a new binding. Custom bindings show a badge.

### Reset All

Appears only if you've customized shortcuts. Restores defaults.

For the full default list see [Keyboard Shortcuts](/user-guide/keyboard-shortcuts).

---

## AI

### Enable

A master toggle for AI features. Off by default — memrynote never reaches out to AI services until you turn this on.
When off, memrynote also hides AI entry points in the app: inline editor AI, Agent Chat in the right
sidebar, AI tag/folder/note suggestions, voice recording/transcription controls, and
quick-capture voice capture.

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

### Agent Permissions

Agent Chat backend and permission settings are now collapsed inside the AI Assistant page. These are
machine-local and are not synced between devices.

- **Default Access** — starts each new Agent turn in **Vault only** or **Computer access**
- **Confirm Actions** — always accept Agent Chat tool calls by default, or require inline approval first
- **Preset** — Ollama, LM Studio, llama.cpp, or Custom
- **Base URL** — OpenAI-compatible endpoint, such as `http://localhost:11434/v1`
- **Model** — choose from `/v1/models` when available or type a model manually
- **API Key** — optional, stored in the OS keychain
- **Test Connection** — checks the endpoint and selected model
- **Probe Tools** — verifies tool-call emission and tool-result continuation before vault tools are enabled, and forces a fresh check when the cached verdict is stale

The Agent Chat prompt bar can override access for one turn and can enable web search when the active
backend supports it. Vault-only turns keep the CLI backend constrained to memrynote tools; computer
access turns grant broader local CLI access for that turn.

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

**Add account** links a second (or third) Google account. Each account is listed with its own calendars and its own Disconnect. Tick the calendars you want in memrynote — unticking one [removes its events](/user-guide/calendar#multiple-accounts-and-calendars).

**Show memrynote events in Google Calendar** controls sync direction. Leave it on for two-way sync, or turn it off for [one-way (inbound only)](/user-guide/calendar#sync-direction) — Google events still appear in memrynote, but memrynote events are not pushed to Google.

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

- General: `theme`, `fontSize`, `fontFamily`, `accentColor`, `startOnBoot`, `language`, `clockFormat`, `dateFormat`, `createInSelectedFolder`
- Editor: `width`, `toolbarMode`, `spellCheck`
- Tasks: `defaultProjectId`, `defaultSortOrder`, `staleInboxDays`
- Calendar: `dayCellClickBehavior`, `calendarPageClickOverride`, `weekStartDay`
- AI: `enabled`, `provider`, `model`
- Voice Transcription: `provider`
- Keyboard Shortcuts: `overrides` (keybinding map), `globalCapture`

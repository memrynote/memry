# Command Line

The `memry` CLI ships with the desktop app. Enable it from **Settings → Command Line**
to install the terminal command for your operating system. The generated command launches
Memry in headless CLI mode and exits without opening the desktop window.

Every command takes an explicit vault path:

```bash
memry --vault ~/Memry --json vault status
```

Use `--json` when another script should consume the output. Without it, commands print a human-readable representation of the same result.

The desktop app installs a small `memry` launcher into a user-level PATH location. If your
terminal was already open, reopen it before running the command.

## Vault

```bash
memry --vault ~/Memry vault init
memry --vault ~/Memry vault status
memry --vault ~/Memry vault config
memry --vault ~/Memry vault update-config '{"excludePatterns":[".git","tmp"]}'
```

`vault init` creates the `.memry` folder, default note/journal/attachment folders, and the local SQLite databases if they do not already exist.

## Notes and Folders

```bash
memry --vault ~/Memry notes create "Draft" --content "First line" --folder Projects --tag writing --properties '{"status":"draft"}'
memry --vault ~/Memry notes list --folder Projects
memry --vault ~/Memry notes get note_abc123
memry --vault ~/Memry notes exists note_abc123
memry --vault ~/Memry notes preview "Draft"
memry --vault ~/Memry notes resolve "Draft"
memry --vault ~/Memry notes links note_abc123
memry --vault ~/Memry notes update note_abc123 --append "More text" --properties '{"status":"active"}'
memry --vault ~/Memry notes rename note_abc123 "Final Draft"
memry --vault ~/Memry notes move note_abc123 Archive
memry --vault ~/Memry notes set-local-only note_abc123 true
memry --vault ~/Memry notes local-only-count
memry --vault ~/Memry notes delete note_abc123 --yes
memry --vault ~/Memry notes snapshot note_abc123 --force
memry --vault ~/Memry notes versions note_abc123
memry --vault ~/Memry notes version snapshot_abc123
memry --vault ~/Memry notes restore-version snapshot_abc123
memry --vault ~/Memry notes delete-version snapshot_abc123 --yes
memry --vault ~/Memry notes attach note_abc123 ~/Downloads/mockup.png
memry --vault ~/Memry notes attachments note_abc123
memry --vault ~/Memry notes delete-attachment note_abc123 file_abc123-mockup.png --yes
memry --vault ~/Memry notes import-files ~/Downloads/spec.md ~/Downloads/diagram.pdf --folder Projects
memry --vault ~/Memry notes export-html note_abc123 ~/Desktop/note.html
memry --vault ~/Memry notes export-pdf note_abc123 ~/Desktop/note.pdf --page-size A4
memry --vault ~/Memry notes export-markdown note_abc123 ~/Desktop/note.md

memry --vault ~/Memry folders list
memry --vault ~/Memry folders create Projects
memry --vault ~/Memry folders rename Projects Archive/Projects
memry --vault ~/Memry folders delete Archive/Projects --yes
```

Destructive commands require `--yes`.
Note snapshots use the same version-history storage as the desktop app. Restoring a snapshot creates a backup snapshot of the current note first.
Attachment commands write into the vault attachment folder. `import-files` copies supported markdown, PDF, image, audio, and video files into the notes folder; imported markdown is indexed immediately for follow-up CLI commands.

## Properties and Folder Views

```bash
memry --vault ~/Memry properties get note_abc123
memry --vault ~/Memry properties set note_abc123 '{"status":"active","priority":3}'
memry --vault ~/Memry properties rename note_abc123 status state
memry --vault ~/Memry properties definitions
memry --vault ~/Memry properties define mood select --options '[{"value":"Focused","color":"emerald"}]' --default '"Focused"'
memry --vault ~/Memry properties update-definition mood --options '[{"value":"Calm","color":"sky"}]'
memry --vault ~/Memry properties delete-definition mood --yes

memry --vault ~/Memry folder-view config Projects
memry --vault ~/Memry folder-view set-config Projects '{"formulas":{"score":"priority * 2"}}'
memry --vault ~/Memry folder-view views Projects
memry --vault ~/Memry folder-view set-view Projects '{"name":"Table","type":"table","default":true,"columns":[{"id":"title"},{"id":"state"}]}'
memry --vault ~/Memry folder-view delete-view Projects Table
memry --vault ~/Memry folder-view list Projects
memry --vault ~/Memry folder-view properties Projects
memry --vault ~/Memry folder-view suggestions note_abc123
memry --vault ~/Memry folder-view exists Projects
```

Per-note properties are stored in note frontmatter. Property definitions are stored in the local database, and select-style definitions are also mirrored to `.memry/properties.md` for desktop compatibility. Folder view configuration is stored in the same `.folder.md` files used by the desktop Folder View.
Folder suggestions are deterministic local suggestions from existing vault folders; AI similarity suggestions still require the desktop runtime.

## Journal

```bash
memry --vault ~/Memry journal get 2026-05-13
memry --vault ~/Memry journal write 2026-05-13 "Today..."
memry --vault ~/Memry journal append 2026-05-13 "Follow-up line"
memry --vault ~/Memry journal month 2026 5
memry --vault ~/Memry journal heatmap 2026
memry --vault ~/Memry journal stats 2026
memry --vault ~/Memry journal context 2026-05-13
memry --vault ~/Memry journal tags
memry --vault ~/Memry journal streak
memry --vault ~/Memry journal delete 2026-05-13 --yes
```

Journal entries are stored in the vault's configured journal folder and use the same note metadata store as the desktop app. Journal context returns local due tasks plus overdue count; event context still requires the desktop calendar runtime. Journal tags are counted from journal-entry tags.

## Tasks and Projects

```bash
memry --vault ~/Memry tasks create "Follow up" --priority 2 --due 2026-05-20 --tag work --link-note note_abc123
memry --vault ~/Memry tasks create "Daily review" --repeat '{"frequency":"daily","interval":1,"endType":"never","createdAt":"2026-05-13T00:00:00.000Z"}' --repeat-from due
memry --vault ~/Memry tasks list --completed
memry --vault ~/Memry tasks list --project project_abc123 --status status_abc123 --tag work --search follow --sort-by dueDate
memry --vault ~/Memry tasks get task_abc123
memry --vault ~/Memry tasks update task_abc123 --title "Follow up with design" --source-note note_abc123
memry --vault ~/Memry tasks move task_abc123 --project project_abc123 --status status_abc123 --position 0
memry --vault ~/Memry tasks get-subtasks task_abc123
memry --vault ~/Memry tasks get-linked-tasks note_abc123
memry --vault ~/Memry tasks today
memry --vault ~/Memry tasks upcoming --days 14
memry --vault ~/Memry tasks overdue
memry --vault ~/Memry tasks stats
memry --vault ~/Memry tasks tags
memry --vault ~/Memry tasks convert-to-subtask task_abc123 parent_task_abc123
memry --vault ~/Memry tasks convert-to-task task_abc123
memry --vault ~/Memry tasks done task_abc123
memry --vault ~/Memry tasks reopen task_abc123
memry --vault ~/Memry tasks archive task_abc123
memry --vault ~/Memry tasks unarchive task_abc123
memry --vault ~/Memry tasks duplicate task_abc123
memry --vault ~/Memry tasks bulk-done task_abc123 task_def456
memry --vault ~/Memry tasks bulk-archive task_abc123 task_def456
memry --vault ~/Memry tasks bulk-move task_abc123 task_def456 --project project_abc123
memry --vault ~/Memry tasks bulk-delete task_abc123 task_def456 --yes
memry --vault ~/Memry tasks reorder task_abc123 task_def456 --position 0 --position 1
memry --vault ~/Memry tasks delete task_abc123 --yes

memry --vault ~/Memry projects list
memry --vault ~/Memry projects get project_abc123
memry --vault ~/Memry projects create "Launch" --color "#0ea5e9" --icon rocket
memry --vault ~/Memry projects update project_abc123 --name "Launch Plan"
memry --vault ~/Memry projects archive project_abc123
memry --vault ~/Memry projects unarchive project_abc123
memry --vault ~/Memry projects delete project_abc123 --yes
memry --vault ~/Memry projects reorder project_abc123 project_def456 --position 0 --position 1
memry --vault ~/Memry projects statuses project_abc123
memry --vault ~/Memry projects status-create project_abc123 Review --color "#0ea5e9"
memry --vault ~/Memry projects status-update status_abc123 --name Reviewed --done true
memry --vault ~/Memry projects status-delete status_abc123 --yes
memry --vault ~/Memry projects status-reorder status_abc123 status_def456 --position 0 --position 1
```

Tasks default to the Inbox project unless `--project <id>` is provided. Use repeated `--tag` and `--link-note` flags to set multiple tags or linked notes; pass `null` to `--repeat`, `--repeat-from`, `--source-note`, `--status`, or `--parent` to clear those fields.

## Inbox and Search

```bash
memry --vault ~/Memry inbox capture "Remember this" --title "Quick capture" --tag cli
memry --vault ~/Memry inbox capture-link https://example.com/articles/memry-cli --tag reading
memry --vault ~/Memry inbox capture-file ~/Downloads/brief.pdf --mime application/pdf --tag pdf
memry --vault ~/Memry inbox get inbox_abc123
memry --vault ~/Memry inbox list
memry --vault ~/Memry inbox list --include-snoozed
memry --vault ~/Memry inbox tags
memry --vault ~/Memry inbox stats
memry --vault ~/Memry inbox patterns
memry --vault ~/Memry inbox archived --limit 20
memry --vault ~/Memry inbox filing-history --limit 10
memry --vault ~/Memry inbox stale-threshold
memry --vault ~/Memry inbox set-stale-threshold 14
memry --vault ~/Memry inbox update inbox_abc123 --title "Updated"
memry --vault ~/Memry inbox add-tag inbox_abc123 follow-up
memry --vault ~/Memry inbox remove-tag inbox_abc123 follow-up
memry --vault ~/Memry inbox mark-viewed inbox_abc123
memry --vault ~/Memry inbox convert-note inbox_abc123
memry --vault ~/Memry inbox convert-task inbox_abc123
memry --vault ~/Memry inbox link-note inbox_abc123 note_abc123 --tag linked
memry --vault ~/Memry inbox snooze inbox_abc123 --until 2026-05-20T09:00:00.000Z --reason "Later"
memry --vault ~/Memry inbox snoozed
memry --vault ~/Memry inbox unsnooze inbox_abc123
memry --vault ~/Memry inbox bulk-tag inbox_a inbox_b --tag batch
memry --vault ~/Memry inbox bulk-snooze inbox_a inbox_b --until 2026-05-22T09:00:00.000Z
memry --vault ~/Memry inbox bulk-archive inbox_a inbox_b
memry --vault ~/Memry inbox archive inbox_abc123
memry --vault ~/Memry inbox unarchive inbox_abc123
memry --vault ~/Memry inbox delete inbox_abc123 --yes

memry --vault ~/Memry search "launch"
memry --vault ~/Memry search stats
memry --vault ~/Memry search tags
memry --vault ~/Memry search reasons
memry --vault ~/Memry search add-reason note_abc123 note "Launch note" "launch"
memry --vault ~/Memry search clear-reasons
memry --vault ~/Memry search rebuild-index
```

Search returns matching notes, journal entries, tasks, inbox items, reminders, templates, and calendar events.
Search utility commands expose the same search metadata surfaces the desktop app uses for indexed counts, recent search reasons, and all known tags.
Inbox list output hides archived and snoozed items by default, matching the desktop inbox. Use `--archived` to include archived items and `--include-snoozed` to include snoozed items. Capture, tag, archive, snooze, convert, and link commands update the same local inbox, note, and task tables/files as the desktop app. `inbox patterns` returns the desktop inbox-health capture heatmap, type distribution, top domains, and top tags from local data. File capture copies supported image, PDF, audio, and video files into `attachments/inbox/<item-id>/`. Link metadata scraping, thumbnail/OCR generation, transcription, metadata retry, link preview, filing suggestions, and calendar/source sync effects stay in the desktop runtime.

## Graph

```bash
memry --vault ~/Memry graph data
memry --vault ~/Memry graph local note_abc123 --depth 2
```

Graph commands return note, journal, task, project, and wikilink nodes/edges as JSON. Unresolved wikilinks are returned as ghost nodes.

## Tags

```bash
memry --vault ~/Memry tags list
memry --vault ~/Memry tags notes work
memry --vault ~/Memry tags color work --color "#123456"
memry --vault ~/Memry tags rename work projects
memry --vault ~/Memry tags remove-from-note note_abc123 projects
memry --vault ~/Memry tags merge old-tag projects
memry --vault ~/Memry tags delete projects --yes
```

Tag commands update the same note frontmatter, task tags, inbox tags, and tag definition colors used by the desktop app. `tags notes` resolves local note matches; desktop-only tag pin/unpin state is not changed by the CLI.

## Reminders

```bash
memry --vault ~/Memry reminders create note note_abc123 --at 2026-05-20T09:00:00.000Z --title "Review"
memry --vault ~/Memry reminders update reminder_abc123 --at 2026-05-21T09:00:00.000Z --title "Review again"
memry --vault ~/Memry reminders list --status pending --from 2026-05-20T00:00:00.000Z
memry --vault ~/Memry reminders for-target note note_abc123
memry --vault ~/Memry reminders due
memry --vault ~/Memry reminders upcoming --days 14
memry --vault ~/Memry reminders snooze reminder_abc123 --until 2026-05-21T09:00:00.000Z
memry --vault ~/Memry reminders dismiss reminder_abc123
memry --vault ~/Memry reminders count-pending
memry --vault ~/Memry reminders bulk-dismiss reminder_a reminder_b
memry --vault ~/Memry reminders delete reminder_abc123 --yes
```

Reminder targets can be `note`, `journal`, or `highlight`. Highlight reminders also accept `--highlight-text`, `--highlight-start`, and `--highlight-end`. Reminder update, target lookup, count, snooze, dismiss, and bulk-dismiss commands write to the same local reminders table used by the desktop scheduler; desktop notifications, triggered reminder inbox creation, and calendar sync side effects still require the Electron runtime.

## Settings

```bash
memry --vault ~/Memry settings list
memry --vault ~/Memry settings groups
memry --vault ~/Memry settings group general
memry --vault ~/Memry settings set-group general '{"theme":"dark","language":"tr"}'
memry --vault ~/Memry settings set-group journal '{"defaultTemplate":"Daily Review","showSchedule":false}'
memry --vault ~/Memry settings set-group tabs '{"previewMode":true,"tabCloseButton":"active"}'
memry --vault ~/Memry settings set-group noteEditor '{"toolbarMode":"sticky"}'
memry --vault ~/Memry settings group voiceTranscription
memry --vault ~/Memry settings set-group voiceTranscription '{"provider":"openai"}'
memry --vault ~/Memry settings ai
memry --vault ~/Memry settings set-ai false
memry --vault ~/Memry settings get editor.spellcheck
memry --vault ~/Memry settings set editor.spellcheck true
memry --vault ~/Memry settings delete editor.spellcheck --yes
```

Settings values are stored in the vault data database and parsed as JSON-compatible CLI values where possible. `settings group` reads the same settings groups used by the desktop app and merges stored values with app defaults. Supported groups are `general`, `editor`, `tasks`, `keyboard`, `sync`, `backup`, `graph`, `calendar`, `calendar.google`, `voiceTranscription`, `journal`, `tabs`, and `noteEditor`. AI settings currently mirror the desktop app's local embedding toggle stored at `ai.enabled`; model load, reindexing, voice model status/download, voice recording readiness, and OpenAI voice API key storage remain desktop-runtime or keychain operations.

## Locale

```bash
memry --vault ~/Memry locale list
memry --vault ~/Memry locale get
memry --vault ~/Memry locale set tr
```

Locale commands use the same supported language list as the desktop app. `locale set` validates the locale, updates `general.language`, and mirrors it into `.memry/config.json` preferences so the Electron app can pick it up on boot. Runtime language switching for open Electron windows still belongs to the desktop app.

## Sync Diagnostics

```bash
memry --vault ~/Memry sync status
memry --vault ~/Memry sync queue-size
memry --vault ~/Memry sync history --limit 20
memry --vault ~/Memry sync devices
memry --vault ~/Memry sync storage
memry --vault ~/Memry sync quarantine
memry --vault ~/Memry sync check-device
memry --vault ~/Memry sync pause
memry --vault ~/Memry sync resume
memry --vault ~/Memry sync settings
memry --vault ~/Memry sync update-setting sync.autoSync false
```

These commands inspect or update local sync metadata in the vault. Storage is local vault byte usage with `limit: 0`; remote quota requires authenticated desktop sync. Device-status checks return the local diagnostic shape, but server revocation checks, account setup, device linking, provider OAuth, and live push/pull still require the desktop runtime.

## Agent Diagnostics

```bash
memry --vault ~/Memry agent backends
memry --vault ~/Memry agent models --backend codex_cli
memry --vault ~/Memry agent local-settings
memry --vault ~/Memry agent set-local-settings --preset lm_studio --model qwen
memry --vault ~/Memry agent set-local-settings --preset custom --base-url http://localhost:9999/v1
```

Agent commands cover local diagnostics and settings that can run without Electron. `agent backends` probes local `claude` and `codex` binaries with `--version`, `agent models` returns the desktop Agent Chat model presets, and `agent local-settings` reads or updates local OpenAI-compatible provider settings in the vault. Chat turns, conversation storage, tool approvals, MCP server lifecycle, provider connection tests, and live local-model discovery still require the desktop Agent runtime.

## Templates

```bash
memry --vault ~/Memry templates list
memry --vault ~/Memry templates create "Meeting Notes" --content "## Agenda" --tag meeting
memry --vault ~/Memry templates get template_abc123
memry --vault ~/Memry templates update template_abc123 --name "Weekly Meeting" --content "## Notes"
memry --vault ~/Memry templates duplicate template_abc123 "Meeting Copy"
memry --vault ~/Memry templates delete template_abc123 --yes
```

Templates are stored as markdown files in `.memry/templates`, matching the desktop template storage model.

## Bookmarks

```bash
memry --vault ~/Memry bookmarks list
memry --vault ~/Memry bookmarks list --type note
memry --vault ~/Memry bookmarks list-by-type note
memry --vault ~/Memry bookmarks get bookmark_abc123
memry --vault ~/Memry bookmarks get-by-item note note_abc123
memry --vault ~/Memry bookmarks add note note_abc123
memry --vault ~/Memry bookmarks toggle note note_abc123
memry --vault ~/Memry bookmarks has note note_abc123
memry --vault ~/Memry bookmarks remove note note_abc123
memry --vault ~/Memry bookmarks delete bookmark_abc123 --yes
memry --vault ~/Memry bookmarks reorder bookmark_2 bookmark_1
memry --vault ~/Memry bookmarks bulk-create '[{"itemType":"note","itemId":"note_abc123"}]'
memry --vault ~/Memry bookmarks bulk-delete bookmark_abc123 bookmark_def456
```

Bookmarks use the same polymorphic item type and item id records as the desktop sidebar. Bulk create/delete commands operate on the local bookmark table; desktop bookmark list item title resolution still happens in the Electron renderer/main process.

## Saved Filters

```bash
memry --vault ~/Memry saved-filters list
memry --vault ~/Memry saved-filters create "Urgent" --config '{"priorities":[4]}'
memry --vault ~/Memry saved-filters get filter_abc123
memry --vault ~/Memry saved-filters update filter_abc123 --name "Urgent Work"
memry --vault ~/Memry saved-filters reorder filter_b filter_a --position 0 --position 1
memry --vault ~/Memry saved-filters delete filter_abc123 --yes
```

Filter config is parsed as JSON, so shell quoting matters for objects and arrays. Reorder writes the same saved-filter positions used by the desktop task sidebar.

## Calendar Events

```bash
memry --vault ~/Memry calendar events create "Customer call" --start 2026-05-20T09:00:00.000Z --end 2026-05-20T09:30:00.000Z
memry --vault ~/Memry calendar events list
memry --vault ~/Memry calendar events list --start 2026-05-20T00:00:00.000Z --end 2026-05-21T00:00:00.000Z
memry --vault ~/Memry calendar events get calendar_abc123
memry --vault ~/Memry calendar events update calendar_abc123 --location "Desk"
memry --vault ~/Memry calendar events delete calendar_abc123 --yes
memry --vault ~/Memry calendar range --start 2026-05-20T00:00:00.000Z --end 2026-05-21T00:00:00.000Z
memry --vault ~/Memry calendar sources --provider google
memry --vault ~/Memry calendar provider-status --provider google
memry --vault ~/Memry calendar google-settings
memry --vault ~/Memry calendar set-default-google-calendar work-calendar --mark-onboarding false
memry --vault ~/Memry calendar external list --source calendar_source_abc123
memry --vault ~/Memry calendar external get external_event_abc123
memry --vault ~/Memry calendar external promote external_event_abc123
memry --vault ~/Memry calendar bindings list --provider google
memry --vault ~/Memry calendar bindings get binding_abc123
```

Local calendar event commands write to the same `calendar_events` table used by the desktop calendar. `calendar range` returns the desktop calendar projection shape for local events, due tasks, reminders, snoozed inbox items, and selected external events. Calendar source, Google settings, external-event, and binding commands inspect or update local provider metadata created by desktop sync. `calendar external promote` converts a synced external event mirror into a local editable event and archives the mirror, matching the desktop promotion behavior. Provider connection, OAuth, remote calendar listing, refresh flows, retry sync, and push/pull execution stay in the desktop runtime.

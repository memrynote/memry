# Templates

Reusable starting content for notes and journal entries.

<!-- screenshot: template gallery -->

## Template Gallery

Open from the sidebar (or via [Settings → Templates](/user-guide/settings#templates)). The gallery groups:

- **Built-in** — Memry-provided, locked
- **My Templates** — your custom templates

Each template shows an icon, name, short description, and a usage count.

## Built-in Templates

Memry ships with starter templates for common patterns:

- Daily Reflection
- Weekly Review
- Meeting Notes
- Project Brief
- Standup
- Decision Log
- Reading Notes

Built-ins are **read-only**. Duplicate any built-in to make an editable copy you can tailor.

## Custom Templates

Two ways to create:

- **From scratch** — gallery → "Create template"
- **Duplicate** — open a built-in's menu and select "Duplicate"

## Template Editor

A full BlockNote editor for the template body, plus metadata:

- Name
- Description
- Icon (emoji or icon set)
- Default scope (note vs journal vs both)

Save with <kbd>⌘</kbd>+<kbd>S</kbd> or by closing the tab.

## Template Variables

Templates can include placeholders that resolve when applied:

<div v-pre>

- `{{date}}` — full date in your locale
- `{{date:YYYY-MM-DD}}` — formatted date
- `{{time}}` — time
- `{{title}}` — title of the new note
- `{{day-of-week}}` — long form (e.g. "Monday")

</div>

Variables are filled at apply time, not stored as text. Editing the resulting note doesn't mutate the template.

## Default Journal Template

[Settings → Journal → Default Template](/user-guide/settings#journal) picks a template that seeds new journal entries.

If you change the default mid-month, existing entries don't change — only new ones use the new template.

## Using a Template

When creating a note, the create dialog has a template picker. Choose a template; the note is seeded with its content. Variables resolve at that moment.

## Deleting a Template

Custom templates have a delete action in the gallery. The confirmation dialog warns if any default settings (e.g. Journal default) reference it; you can pick a replacement before confirming.

## Sync

Templates sync as standard sync items. Built-in templates are baked into the app version and not synced; they're identical across all your devices automatically.

## See Also

- [Journal Templates & Settings](/user-guide/journal/templates-settings)
- [Inbox](/user-guide/inbox/triage) — convert inbox items into notes using a template

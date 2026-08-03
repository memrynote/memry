# Templates

Reusable starting content for notes and journal entries.

<!-- screenshot: template gallery -->

## Template Gallery

Open from the sidebar (or via [Settings → Templates](/user-guide/settings#templates)). The gallery groups:

- **Built-in** — memrynote-provided, locked
- **My Templates** — your custom templates

Each template shows an icon, name, short description, and a usage count.

## Previewing a Template

Click any template in the gallery to open a **read-only preview** — its full content and properties, rendered inline without leaving Settings. Built-in templates show a lock badge. Use the back arrow to return to the list.

Creating a new template, or editing a custom one, opens it in its own editor tab; the Settings panel closes so the editor is in focus.

## Built-in Templates

memrynote ships with starter templates for common patterns:

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

## Applying a Template to an Existing Note

Templates aren't just for new notes — you can apply one to a note you already have.

Open the picker from either:

- The sidebar tree — right-click a note → **Apply Template**
- The note page's <kbd>⋯</kbd> menu → **Apply Template**

Pick a template and confirm with **Apply Template**.

- If the note is **empty**, the template's content is applied right away.
- If the note **already has content**, you're warned that applying will replace it, with two choices:
  - **Replace content & add template details** — replaces the body and merges in the template's tags and properties. Your existing tags and properties are kept; the template's are added on top. If a property key exists on both, the note's current value wins.
  - **Replace content only** — replaces the body and leaves your existing tags and properties untouched.

`{{title}}` resolves to the note's current title. If the note is open in the editor, the update shows up live.

## Deleting a Template

Custom templates have a delete action in the gallery. The confirmation dialog warns if any default settings (e.g. Journal default) reference it; you can pick a replacement before confirming.

## Sync

Custom templates sync as standard sync items, end-to-end encrypted like the rest of your vault. Create or edit a template on one device and it appears on the others after the next sync. When the same template is edited on two devices at once, the most recent edit wins for the whole template — templates are not merged field by field.

Built-in templates are baked into the app version and not synced; they're identical across all your devices automatically, so they never appear twice.

### Upgrading from an older version

Earlier versions stored custom templates as markdown files in `.memry/templates/` inside the vault, and those files never synced. The first time you open a vault with this version, each custom template is imported into the vault database and queued for sync — ids are preserved, so a vault you copied between machines converges instead of duplicating.

The original files are left on disk. They're no longer read after the import, but they stay as a safety net if you ever roll back to an older build. The one exception is deletion: deleting a template also removes its original file, so it cannot come back if the vault database is ever rebuilt.

## See Also

- [Journal Templates & Settings](/user-guide/journal/templates-settings)
- [Inbox](/user-guide/inbox/triage) — convert inbox items into notes using a template

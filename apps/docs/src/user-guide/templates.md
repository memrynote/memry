# Templates

Reusable starting content for notes and journal entries.

<!-- screenshot: templates list in settings -->

## Where Templates Live

[Settings → Templates](/user-guide/settings#templates) is the home for templates. The list groups:

- **Built-in** — memrynote-provided, locked
- **My Templates** — your custom templates

Each row shows the template's icon, name, and short description.

Clicking any row opens that template in its own editor tab and closes Settings, so the editor is in focus. Custom rows also have a <kbd>⋯</kbd> menu with **Edit**, **Duplicate**, and **Delete**; built-ins show a lock instead.

## Built-in Templates

memrynote ships with starter templates for common patterns:

- Daily Reflection
- Weekly Review
- Meeting Notes
- Project Brief
- Standup
- Decision Log
- Reading Notes

Built-ins are **read-only**. Opening one shows it in the editor with every field locked and a **Duplicate & Edit** button in the top right — that makes an editable copy and opens it in a new tab.

## Custom Templates

Two ways to create:

- **From scratch** — Settings → Templates → **New**
- **Duplicate** — a built-in's **Duplicate & Edit** button, or any custom row's <kbd>⋯</kbd> → **Duplicate**

## Template Editor

A template is written on the same surface as a note. The tab holds a title, tags, properties, and the full editor body — the title is the template's name, and everything else behaves exactly as it does on a note page. The icon next to the title opens the emoji/icon picker.

<div v-pre>

The body is what new notes start from, so `{{title}}` and the other variables below belong here.

</div>

### Saving

A brand-new template is a **draft**: nothing is written until you press **Create Template** in the top right. The button stays disabled until the name is filled in.

Once created, the button becomes **Update** and saving turns continuous — edits are written about a second after you stop typing, with no prompt and no toast. **Update** is there when you want to flush immediately; it greys out when there is nothing pending.

While a draft has unsaved work, its tab shows the unsaved dot. Closing that tab — by the tab's ✕, middle-click, the tab menu, or <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>W</kbd> — asks whether to **Save**, **Don't Save**, or **Cancel**. Quitting the app does not ask, so a draft you never created is lost on quit.

### Other actions

The <kbd>⋯</kbd> menu beside the button holds **Duplicate** and **Delete Template**.

A template's short description is shown in the Settings list but is not edited here; existing descriptions are preserved untouched.

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

Custom templates can be deleted from the Settings list's <kbd>⋯</kbd> menu, or from the editor's <kbd>⋯</kbd> menu while the template is open. Deleting from the editor closes its tab.

## Sync

Custom templates sync as standard sync items, end-to-end encrypted like the rest of your vault. Create or edit a template on one device and it appears on the others after the next sync. When the same template is edited on two devices at once, the most recent edit wins for the whole template — templates are not merged field by field.

Built-in templates are baked into the app version and not synced; they're identical across all your devices automatically, so they never appear twice.

### Upgrading from an older version

Earlier versions stored custom templates as markdown files in `.memry/templates/` inside the vault, and those files never synced. The first time you open a vault with this version, each custom template is imported into the vault database and queued for sync — ids are preserved, so a vault you copied between machines converges instead of duplicating.

The original files are left on disk. They're no longer read after the import, but they stay as a safety net if you ever roll back to an older build. The one exception is deletion: deleting a template also removes its original file, so it cannot come back if the vault database is ever rebuilt.

## See Also

- [Journal Templates & Settings](/user-guide/journal/templates-settings)
- [Inbox](/user-guide/inbox/triage) — convert inbox items into notes using a template

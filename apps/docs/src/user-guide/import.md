# Importing Notes

Bring content in from other apps as a one-time import. Imports create new notes (or tasks) in your vault; your original export files are never modified.

Open **Settings → Import** to see the available sources. Every source shares the same flow: click **Import** next to a source, choose your export file(s), and watch the live progress. Some sources (such as Todoist and CSV) first show a **preview** — counts, sample titles, and any warnings — so you can review what will be imported before committing. You can **Cancel** a running import at any time.

Each importer writes into its own top-level folder (`Notion/`, `Bear/`, `Evernote/`, …) so sources never collide, and imports are **additive** — running an import again creates new notes rather than updating existing ones.

| Source        | Export format                   | Creates | Details                                                |
| ------------- | ------------------------------- | ------- | ------------------------------------------------------ |
| Notion        | HTML export `.zip`              | Notes   | [Notion](#importing-from-notion)                       |
| Markdown      | `.md` files / folder            | Notes   | [Markdown](#importing-from-markdown)                   |
| HTML          | `.html` / `.htm` files          | Notes   | [HTML](#importing-from-html)                           |
| Evernote      | `.enex` export                  | Notes   | [Evernote](#importing-from-evernote)                   |
| Bear          | `.bear2bk` archive              | Notes   | [Bear](#importing-from-bear)                           |
| Apple Notes   | `NoteStore.sqlite` (macOS)      | Notes   | [Apple Notes](#importing-from-apple-notes)             |
| Google Keep   | Google Takeout `.json` / `.zip` | Notes   | [Google Keep](#importing-from-google-keep)             |
| Roam Research | Graph `.json` export            | Notes   | [Roam](#importing-from-roam-research)                  |
| Apple Journal | HTML export                     | Notes   | [Apple Journal](#importing-from-apple-journal)         |
| CSV           | `.csv` file                     | Notes   | [CSV](#importing-from-csv)                             |
| OneNote       | Microsoft Graph (account)       | Notes   | [OneNote](#importing-from-onenote)                     |
| Raindrop      | Bookmark CSV `.csv`             | Inbox   | [Raindrop](#importing-from-raindrop)                   |
| Todoist       | Project CSV `.csv`              | Tasks   | See [Import from Todoist](./tasks/import-todoist.md)   |
| TickTick      | Backup CSV `.csv`               | Tasks   | See [Import from TickTick](./tasks/import-ticktick.md) |

## Importing from Notion

memrynote imports a Notion **HTML** export (not the Markdown or CSV export).

### 1. Export from Notion

In Notion, open the workspace or page you want to move, choose **Export**, and pick:

- **Export format:** HTML
- **Include content:** Everything
- **Include subpages:** On

Notion produces a `.zip` (large exports are split into nested `Export-….zip → …-Part-N.zip` archives — memrynote reads these automatically).

### 2. Run the import

1. Open **Settings → Import**.
2. Click **Import** next to **Notion**.
3. **Choose file** and select your exported `.zip` (you can pick more than one part).
4. Click **Start import** and watch the live progress.

### What gets imported

| Notion                         | memrynote                                                         |
| ------------------------------ | ----------------------------------------------------------------- |
| Page tree (folders & subpages) | Mirrored as folders under a `Notion/` folder                      |
| Page body                      | Markdown (headings, lists, to-dos, code, tables, quotes/callouts) |
| Links between pages            | `[[Wiki Links]]`                                                  |
| Images & file attachments      | Copied into the note and re-linked                                |
| Database properties            | Note **properties** (frontmatter)                                 |
| `Multi-select` named _Tags_    | Note **tags**                                                     |
| Created / Last edited times    | Preserved on the note                                             |

### Notes & limitations

- Use the **HTML** export. If you select a Markdown export, the importer stops and asks you to re-export as HTML.
- Notion database `.csv` files and the export's `index.html` summary are skipped.

## Importing from Markdown

Import a single `.md` file, several files, or a whole folder. No export step is needed — just gather your `.md` / `.markdown` files.

1. Open **Settings → Import** and click **Import** next to **Markdown**.
2. Click **Choose file…** for individual notes, or **Choose folder…** for a whole export.

::: tip Pick the folder if your export has images
Exports from Capacities, Obsidian and similar apps keep media in a shared folder
and reference it from notes as `../Images/Media/photo.png`. Those references only
resolve when you select the folder that contains both — picking loose `.md` files
leaves the images behind.
:::

| Markdown source               | memrynote                             |
| ----------------------------- | ------------------------------------- |
| File / folder tree            | Notes mirrored under `Markdown/`      |
| YAML frontmatter `title`      | Note title                            |
| YAML frontmatter `tags`       | Note tags                             |
| Other frontmatter keys        | Note properties                       |
| `[[wikilinks]]`               | Preserved as-is                       |
| Relative image / file links   | Saved as attachments; links rewritten |
| `![[image.png]]` embeds       | Saved as attachments; embed rewritten |
| File created / modified times | Preserved on the note                 |

Obsidian-style embeds are handled alongside ordinary markdown links. `![[photo.png]]`,
`![[Images/photo.png]]` and the sized form `![[photo.png|300x200]]` all save the file as
an attachment and replace the whole embed with the imported image; the display size is
dropped, since you resize images in the editor instead. `![[Some Note]]` and
`![[Some Note.md]]` embed another note rather than a file, so they are left untouched.

**Limitations:** only `.md` / `.markdown` files are imported (other files only as referenced attachments); links to files outside the selected folder are not treated as attachments; links to other `.md` notes stay plain links rather than becoming attachments; note wikilinks are kept literally; the display size on a sized embed is not carried over.

## Importing from HTML

Import one or more `.html` / `.htm` files. This path also powers the Apple Journal importer.

1. Open **Settings → Import** and click **Import** next to **HTML**.
2. Select one or more `.html` / `.htm` files.

| HTML source                  | memrynote                             |
| ---------------------------- | ------------------------------------- |
| Page `<title>` (or filename) | Note title                            |
| Body                         | Converted to Markdown under `HTML/`   |
| Local images                 | Saved as attachments; links rewritten |
| Remote images (`http(s)`)    | Downloaded and saved as attachments   |
| Data-URI images              | Kept inline (not downloaded)          |
| Links between selected files | `[[Wiki Links]]` to the linked page   |

**Limitations:** there is no minimum image-dimension filter (a 10 MiB per-asset size cap applies); assets referenced with `../` outside the file's own folder are rejected as unsafe; pages behind auth/CORS fail and are skipped.

## Importing from Evernote

Import one or more Evernote `.enex` exports (in Evernote: **File → Export Notes → ENEX**).

1. Open **Settings → Import** and click **Import** next to **Evernote**.
2. Select one or more `.enex` files. Each file becomes a notebook folder.

| Evernote (.enex)        | memrynote                                     |
| ----------------------- | --------------------------------------------- |
| `<note>` content (ENML) | Markdown under `Evernote/<notebook>/`         |
| `<en-media>` resources  | Attachments matched by hash, saved + embedded |
| `<en-todo>`             | `- [ ]` / `- [x]` checkboxes                  |
| `<tag>`                 | Note tags                                     |
| Created / updated       | Preserved on the note                         |

**Limitations:** table-of-contents notes import as plain text; ink/handwriting resources are saved but not rendered; internal `evernote:///` links are not resolved; encrypted sections are skipped.

## Importing from Bear

Import a Bear `.bear2bk` archive (in Bear: **File → Export Notes → Bear Notes (.bear2bk)**).

1. Open **Settings → Import** and click **Import** next to **Bear**.
2. Select your `.bear2bk` file.

| Bear                      | memrynote                                                                   |
| ------------------------- | --------------------------------------------------------------------------- |
| Note body                 | Markdown under `Bear/` (archived → `Bear/Archived`, trashed → `Bear/Trash`) |
| `bear://…` note links     | `[[Wiki Links]]` when the target is in the export                           |
| `#tag` and `#[tag name]#` | Tags (`#[tag name]#` → `tag_name`)                                          |
| `assets/` files           | Saved as attachments (deduplicated)                                         |
| Created / modified        | Preserved on the note                                                       |

**Limitations:** only `.bear2bk` exports are supported; `bear://` links to notes not in the export are left as raw URLs.

## Importing from Apple Notes

**macOS only.** Apple Notes has no clean export, so memrynote reads a **read-only copy** of its local database — your Apple Notes data is never modified.

1. Grant the app **Full Disk Access** (System Settings → Privacy & Security → Full Disk Access) so it can read `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`.
2. Open **Settings → Import** and click **Import** next to **Apple Notes**.
3. Select the `NoteStore.sqlite` file (or accept the default location).

| Apple Notes                                     | memrynote                                       |
| ----------------------------------------------- | ----------------------------------------------- |
| Note body (gzip + protobuf)                     | Markdown under `Apple Notes/<account>/<folder>` |
| Headings, bold/italic, lists, to-dos, monospace | Markdown equivalents                            |
| Inline images                                   | Saved as attachments                            |
| Created / modified (CoreTime)                   | Preserved on the note                           |
| Password-protected notes                        | Skipped                                         |

**Limitations:** scanned documents, handwriting/drawings, and tables are not converted (shown as an unsupported-attachment marker); hashtags, @-mentions, and internal note links are dropped from the text. This importer only appears on macOS.

## Importing from Google Keep

Import a [Google Takeout](https://takeout.google.com/) Keep export — individual `.json` note files and/or the `.zip` bundle (with its `Assets/` folder).

1. Open **Settings → Import** and click **Import** next to **Google Keep**.
2. Select your `.json` files or the Takeout `.zip`.

| Google Keep                                          | memrynote                    |
| ---------------------------------------------------- | ---------------------------- |
| Title / text                                         | Note under `Google Keep/`    |
| Checklist items                                      | `- [ ]` / `- [x]` checkboxes |
| Attachments                                          | Saved and embedded           |
| Created / last-edited (µs)                           | Preserved on the note        |
| Labels, color, pinned, archived, trashed, attachment | Synthetic tags (see below)   |

Metadata is surfaced as tags: `Keep/Label/<name>`, `Keep/Color/<color>` (omitted for the default), `Keep/Pinned`, `Keep/Archived`, `Keep/Deleted`, `Keep/Attachment`.

**Limitations:** `.html` / `.txt` duplicates in the Takeout bundle are skipped; collaborator info and reminder dates (absent from Takeout) are not imported.

## Importing from Roam Research

Import a Roam graph from its **JSON** export (in Roam: **Export All → JSON**).

1. Open **Settings → Import** and click **Import** next to **Roam**.
2. Select one or more `.json` files.

Every page becomes a note under `Roam/`; the page outline becomes a nested bullet list. Slash-separated page titles (`A/B/C`) become nested folders, and daily notes are re-titled to the journal date format.

| Roam                                                                                           | memrynote                                 |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------- |
| <code v-pre>{{[[TODO]]}}</code> / <code v-pre>{{[[DONE]]}}</code>                              | `[ ]` / `[x]`                             |
| `__italic__`, `^^highlight^^`                                                                  | `*italic*`, `==highlight==`               |
| `((block ref))` / <code v-pre>{{embed:…}}</code>                                               | `[[Page]]: "referenced text"` (see below) |
| `[label]([[Page]])` aliases                                                                    | Kept as-is                                |
| <code v-pre>{{POMO}}</code>, <code v-pre>{{word-count}}</code>, other <code v-pre>{{…}}</code> | Dropped                                   |

**Block references:** memrynote markdown has no Roam-style `[[page#^uid]]` block anchors, so block references degrade to a wikilink to the page that contains the block plus the referenced text in quotes. References to unknown blocks fall back to plain text.

**Limitations:** Firebase-hosted attachments are left as inline links rather than downloaded.

## Importing from Apple Journal

Import an Apple Journal HTML export (a folder of `.html` files).

1. Open **Settings → Import** and click **Import** next to **Apple Journal**.
2. Select the exported `.html` files.

| Apple Journal              | memrynote                                                 |
| -------------------------- | --------------------------------------------------------- |
| Entry date (`.pageHeader`) | Dated note title + `date` property under `Apple Journal/` |
| Body paragraphs            | Markdown body                                             |
| Reflection prompt          | Block quote                                               |
| Map asset                  | `location` property                                       |

**Not imported:** photos, videos, and Live Photos are intentionally excluded — only text and location metadata are imported. `index.html` is skipped.

## Importing from CSV

Import an arbitrary `.csv` as notes — one note per row. A **preview** shows the detected columns, sample titles, and how many rows will be imported or skipped.

1. Open **Settings → Import** and click **Import** next to **CSV**.
2. Select a `.csv` file and review the preview, then confirm.

| CSV                                                       | memrynote                     |
| --------------------------------------------------------- | ----------------------------- |
| Each row                                                  | One note under `CSV/`         |
| `Title` / `Name` / `Subject` column (or the first column) | Note title                    |
| Every other column                                        | Note property (YAML-safe key) |

**Conventions:** the first row must be a header row; rows with an empty title are skipped and counted; all property values import as strings.

**Limitations:** an interactive column-mapping step (choose the title column, body template, target folder) is a planned enhancement — for now the conventions above apply automatically.

## Importing from Raindrop

Import a [Raindrop.io](https://raindrop.io) bookmark export. Unlike the other sources, Raindrop bookmarks land in your **Inbox** as link items (not in a folder), ready to triage or file. A **preview** shows how many bookmarks will be imported. After import, memrynote fetches each bookmark's **readable article content** in the background — the same reader used when you paste a link — so items fill in with the full page text over time.

1. In Raindrop, open **Settings → Export** and export your collections as **CSV**.
2. Open **Settings → Import** in memrynote and click **Import** next to **Raindrop**.
3. Select your `.csv` export (you can pick more than one) and review the preview, then confirm.

| Raindrop            | memrynote                                                                               |
| ------------------- | --------------------------------------------------------------------------------------- |
| Each bookmark       | A `link` item in the **Inbox**                                                          |
| Page contents       | Readable article fetched in the background and saved as the item body                   |
| Title               | Item title (falls back to the URL; the background fetch never replaces it)              |
| Note + excerpt      | Initial item body, kept as a fallback if the fetch fails                                |
| Collection (folder) | Tag (the `Unsorted` collection is dropped)                                              |
| Tags                | Item tags                                                                               |
| Created date        | Preserved on the item                                                                   |
| Cover image         | Kept in metadata; a hero image from the fetched page becomes a thumbnail when available |

**Conventions:** the first row must be the header row (`id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite`); rows without a URL are skipped and counted.

**Limitations:** article content is fetched one bookmark at a time in the background, so a very large export fills in gradually (it resumes across restarts); pages that can't be fetched or extracted — some social links such as TikTok, or paywalled/login-gated pages — keep their CSV excerpt. The import is additive and does not de-duplicate against bookmarks already in your inbox.

## Importing from OneNote

::: warning Setup required
OneNote import is **disabled** until an **Azure app registration** is configured. Microsoft Graph requires a public-client application (client) id plus a registered loopback redirect URI and the delegated scopes `user.read` and `notes.read`. Until the client id is set, OneNote does not appear in the import list.
:::

Once configured, OneNote imports notebooks → sections → pages from the Microsoft Graph API into `OneNote/<notebook>/<section>/`, converting each page's HTML to Markdown and saving inline images as attachments.

**Deferred:** OneNote math (`<math>` / MathML → LaTeX) and handwriting/ink (InkML → SVG) are not yet converted and pass through as plain text.

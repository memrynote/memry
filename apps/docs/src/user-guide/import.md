# Importing Notes

Bring content in from other apps as a one-time import. Imports create new notes (or tasks) in your vault; your original export files are never modified.

Open **Settings → Import** to see the available sources. Every source shares the same flow: click **Import** next to a source, choose your export file(s), and watch the live progress. Some sources (such as Todoist) first show a **preview** — counts, sample titles, and any warnings — so you can review what will be imported before committing.

| Source  | Export format      | Creates | Details                                              |
| ------- | ------------------ | ------- | ---------------------------------------------------- |
| Notion  | HTML export `.zip` | Notes   | See below                                            |
| Todoist | Project CSV `.csv` | Tasks   | See [Import from Todoist](./tasks/import-todoist.md) |

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
4. Click **Start import** and watch the live progress. You can **Cancel** at any time.

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

When the run finishes you'll see a summary of how many notes and attachments were imported, plus anything skipped or failed.

### Notes & limitations

- Use the **HTML** export. If you select a Markdown export, the importer stops and asks you to re-export as HTML.
- Notion database `.csv` files and the export's `index.html` summary are skipped.
- Imports are additive — running an import again creates new notes rather than updating existing ones.

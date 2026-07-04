# Obsidian Round-Trip Compatibility — Program Overview

**Date:** 2026-07-05
**Status:** Decisions locked (Kaan, 2026-07-05); one spec per work item, executed separately.

## Goal

A user opens an existing Obsidian vault in MemryNote, works in it, then opens it
back in Obsidian and sees **zero meaningless differences**. Properties, tags,
links, tasks — everything round-trips.

**Core principle:** the `.md` file stays Obsidian-clean; Memry-specific state
lives in the existing `.memry/` sidecar (`data.db`, `index.db`, `config.json`,
`attachments/`); anything the user didn't change is byte-preserved.

Pre-production: no backward-compat constraints. DB schema and vault format can
change freely.

## Spec index

| Spec | Item                                                                       | File                                                                   |
| ---- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 01   | P0.1 Frontmatter diet — no default keys, path-as-identity                  | [01-frontmatter-diet.md](01-frontmatter-diet.md)                       |
| 02   | P0.2 Note-task linkage without `{task:id}` suffix                          | [02-task-linkage.md](02-task-linkage.md)                               |
| 03   | P0.4 Bookmark/YouTube markers → plain links                                | [03-bookmark-embed-plain-links.md](03-bookmark-embed-plain-links.md)   |
| 04   | P1.5 Byte-preservation + golden round-trip test                            | [04-byte-preservation.md](04-byte-preservation.md)                     |
| 05   | P1.6 Properties as top-level keys, Obsidian emit style                     | [05-properties-top-level.md](05-properties-top-level.md)               |
| 06   | P2.9 Foreign syntax preservation (block IDs, %%…%%, Tasks emoji, Dataview) | [06-foreign-syntax-preservation.md](06-foreign-syntax-preservation.md) |
| 07   | P2.10 Filename sanitization — Obsidian-forbidden chars                     | [07-filename-sanitization.md](07-filename-sanitization.md)             |
| 08   | P2.11 Honor `.obsidian/` settings read-only; leave `.canvas`/`.base` alone | [08-obsidian-settings-readonly.md](08-obsidian-settings-readonly.md)   |

Recommended execution order: 01 → 04 (its regression insurance) → 02/03/05 in
any order → 06/07/08.

## Explicit non-goals (decided, do not revisit in specs)

- **Attachments stay in `.memry/attachments/<noteId>/`** with `<!-- file:{…} -->`
  markers (P0.3 — keep as-is).
- **HTML-comment markers stay** (`<!-- memry:block-nesting-level=N -->`,
  `<!-- colors:{…} -->`) — comments in notes are a wanted capability (P1.7).
- **Tag casing / Unicode tag regex** — being fixed in a separate PR (P1.8).

## Decision log (Kaan, 2026-07-05)

1. **No default frontmatter, ever.** Memry adds nothing to frontmatter on its
   own: no `id`, no `title`, no `created`/`modified`, no empty `tags: []`.
   Title derives from the filename. Identity: the file **path is the id**
   ("path'i id yap") — internal ids live only in the `.memry/` sidecar mapping.
2. **Frontmatter = properties**, same as Obsidian: every key the user writes in
   frontmatter is a user-visible property; Memry treats it that way and never
   claims keys for itself.
3. Task suffix `{task:<id>}` is removed; the open design question is how the
   existing task system links to checkboxes in notes (spec 02 answers it).
4. Bookmark/YouTube blocks serialize as plain markdown links; rich rendering is
   decided at parse time from the URL.
5. Byte-preservation: no write without a semantic change; frontmatter block kept
   verbatim unless a property was edited.
6. Custom properties written top-level (no nested `properties:` object), in
   Obsidian's exact emit style.

## Current write surface (code audit, 2026-07-05)

- `apps/desktop/src/main/vault/frontmatter.ts` — `createFrontmatter` injects
  `id`, `title`, `created`, `modified`, `tags: []`; `serializeNote` bumps
  `modified` on every save and re-stringifies via gray-matter; `parseNote`
  auto-generates missing id/created/modified in memory (read is non-destructive:
  `ensureFrontmatter` has no production callers). Reserved keys:
  `id,title,created,modified,tags,aliases,emoji,localOnly`.
- `apps/desktop/src/main/vault/notes-crud.ts` — `createNote` writes frontmatter
  incl. nested `properties:` object.
- `packages/app-core/src/markdown.ts` — `parseMarkdownNote`/`writeMarkdownNote`
  (gray-matter) duplicated for CLI/app-core.
- `packages/shared/src/task-block.ts` — `serializeTaskBlock` emits
  `- [ ] Title {task:<id>}`; `parseTaskBlockSuffix` / `normalizeTaskBlocks`
  parse it back.
- `apps/desktop/src/renderer/src/components/note/content-area/markdown-utils.ts`
  — `serializeBlocksPreservingBlanks` re-serializes the whole body through
  BlockNote `blocksToMarkdownLossy`; emits task/bookmark/embed/file/callout/
  colors/nesting segments.
- `apps/desktop/src/renderer/src/components/note/content-area/bookmark-block.tsx`
  / `youtube-embed-block.tsx` — `![bookmark](url)` / `![embed](url)`.
- `apps/desktop/src/main/vault/file-ops.ts` — `sanitizeFilename` strips
  `< > : " / \ | ? *` but allows `[ ] # ^`.
- `apps/desktop/src/main/vault/init.ts` — `.memry/` dir; scan excludes
  `.git`, `node_modules`, `.trash`, `.obsidian`, `.memry`.

## Obsidian facts that constrain the design (researched 2026-07-05)

Sources: help.obsidian.md (properties, tags, links, embeds, callouts,
attachments, data-storage, file-formats, daily-notes), docs.obsidian.md
(`FileManager.processFrontMatter`), forum.obsidian.md threads 65851/69048/66297
(frontmatter normalization, with official team responses), 103977 (forbidden
filename chars), publish.obsidian.md/tasks (emoji format),
blacksmithgu.github.io/obsidian-dataview (inline fields).

- **Every frontmatter key is surfaced in Obsidian's Properties UI** — there is
  no hidden key. An `id:` becomes a visible, editable property on every note
  (Dendron/Logseq-style pollution is the #1 community interop complaint).
- Obsidian rewrites frontmatter **only** when properties are edited via its UI
  or `processFrontMatter`; body edits never touch it. Its emit style: `---`
  delimiters, block lists with 2-space-indented `- `, double quotes only where
  syntactically required (always around `"[[wikilinks]]"`), dates `YYYY-MM-DD` /
  `YYYY-MM-DDTHH:MM:SS`, booleans `true|false`, key order preserved, new keys
  appended last, YAML comments deleted, flow style collapsed to block lists.
- Property types are per-key, vault-global, stored in `.obsidian/types.json`.
  Types: text, list, number, checkbox, date, datetime, tags (only for `tags`).
  Nested objects survive as data but are uneditable in the Properties UI.
- Reserved keys: `tags` (list, no `#` prefix), `aliases`, `cssclasses`;
  Publish-only: `publish`, `permalink`, `description`, `image`, `cover`.
- Tags: Unicode letters, digits, `_`, `-`, nested via `/`; at least one
  non-numeric char; case-insensitive matching, display keeps first-created
  casing.
- Links: `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]`, `[[Note#^blockid]]`;
  block anchors ` ^id` (Latin letters/digits/dash, auto-generated ones are
  6-char lowercase alphanumeric); embeds `![[file]]` (+ `|WxH` for images,
  `#page=` for PDFs). Resolution case-insensitive; "shortest path when
  possible" is the default new-link format. Both wikilink and markdown-link
  styles must be parsed; keep each link's original style when editing.
- Tasks: any character in `- [?]` brackets is valid (custom states are common).
  Ecosystem metadata standards to preserve verbatim: Tasks-plugin emoji
  signifiers appended at end of line (➕⏳🛫📅✅❌🔁🆔⛔🏁, priorities
  🔺⏫🔼🔽⏬, dates `YYYY-MM-DD`) and Dataview inline fields
  (`Key:: value` full-line, `[key:: value]` bracketed inline).
- Obsidian-flavored markdown beyond GFM: `==highlight==`, `%%comment%%`
  (inline + block), callouts `> [!type]` (+ `-`/`+` fold markers, custom
  titles, nesting), inline footnotes `^[…]`, `$math$`/`$$math$$`, mermaid
  fences, trailing ` ^block-ids`. Template files use `{{title}}`, `{{date}}`,
  `{{time}}` (+ `:format`) — never expand or mangle.
- `.obsidian/` (name user-configurable) holds `app.json` (attachment folder,
  link format), `daily-notes.json` (folder + Moment date format, may contain
  `/`), `types.json` (property types), `templates.json`, `workspace.json`
  (churns constantly — never diff/sync it). Never write into this folder.
- `.trash/` at vault root = Obsidian trash; don't index, don't delete.
- Vault also contains `.canvas` (JSON Canvas) and `.base` (Bases) files plus
  images/audio/video/PDF — leave untouched.
- Forbidden filename chars (Obsidian ≥1.8): `[ ] # ^ |` everywhere;
  `\ / :` on macOS/Linux; `* " \ / : | ?` on Windows; no leading dot.

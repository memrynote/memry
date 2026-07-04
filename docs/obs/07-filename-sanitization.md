# Filename Sanitization — Design

**Date:** 2026-07-05
**Branch:** `obs-filename-sanitization`
**Status:** Approved, pending implementation

## Goal

Memry-created and Memry-renamed files must be linkable from Obsidian. Obsidian
≥1.8 forbids `[ ] # ^ |` in filenames everywhere (they break wikilink syntax:
`[[Note#Heading]]`, `[[Note#^block]]`, `[[Note|alias]]`), plus the platform
chars Memry already strips. Today a note titled `Draft [v2] #1` produces
`Draft [v2] #1.md` — a file Obsidian cannot create a wikilink to (P2.10,
decision locked).

## Current behavior

- `apps/desktop/src/main/vault/file-ops.ts:299` — `sanitizeFilename` strips
  `/[<>:"/\\|?*]/g`, collapses whitespace, trims, drops one leading dot,
  falls back to `'untitled'` when empty, caps at 200 chars. `|` is already
  stripped; `[ ] # ^` pass through.
- Callers: `generateNotePath` (file-ops.ts:332) and `generateFilePath`
  (file-ops.ts:342), which serve `createNote` (notes-crud.ts:222), CRDT
  write-back (crdt-writeback.ts:263), and sync pull/apply
  (item-handlers/note-handler.ts:128, 224, 360, 429). `renameNote` calls the
  sanitizer directly (notes-rename.ts:48), so rename gets the new rules for
  free. Vault attachments use it too (vault/attachments.ts:227).
- Duplicate: `apps/desktop/src/main/lib/export-utils.ts:409` — same char set,
  whitespace collapse, trim, 200-char cap, but **no** leading-dot rule and
  **no** empty fallback. Callers: PDF/HTML export default filenames
  (ipc/notes-handlers.ts:764, 843) and Evernote notebook folder name
  (evernote/evernote-importer.ts:94).
- Two further private sanitizers (inbox/attachments.ts:215,
  packages/app-core/src/inbox.ts:213) name files under `.memry/attachments/`,
  which are never wikilink targets — out of scope.
- No renderer-side validation or preview: the title travels raw over IPC and
  main strips silently. The user never sees the final filename before save.
- Existing tests: file-ops.test.ts:457–493 (T350), export-utils.test.ts:67–69.

## Design

**1. Forbidden set.** Current set plus `[ ] # ^`:

```ts
.replace(/[<>:"/\\|?*[\]#^]/g, '') // platform + Obsidian-forbidden chars
```

Keep **strip, don't replace**: it matches the existing behavior for
`< > : " / ? *`, invents no characters the user didn't type, and Obsidian
itself rejects rather than substitutes. All other rules unchanged: collapse
whitespace, trim, no leading dot, `'untitled'` fallback, 200-char cap.
`Draft [v2] #1` → `Draft v2 1.md`. `generateUniquePath` (file-ops.ts:363)
already handles the new collision class (`Draft [v2]` and `Draft v2` both
sanitizing to `Draft v2.md`).

**2. Both duplicates, no consolidation.** Apply the same regex to
file-ops.ts:302 and export-utils.ts:412. Merging the two (they differ in
leading-dot and fallback rules) would touch export/import flows unrelated to
this change — future cleanup, per surgical-change rules. One addition to
export-utils: the wider set makes an all-stripped title likelier (`[#1]` →
`''` → default export name `.pdf`), so give it the same `'untitled'` fallback.

**3. No retroactive renaming.** Existing files keep their names byte-for-byte
(spec 04). Only `createNote`, `renameNote`, sync-applied titles, and export
defaults produce sanitized names. A pre-existing `Draft [v2].md` on disk stays
readable, indexed, and untouched until the user renames it.

**4. Title↔filename coupling.** After spec 01 the title _is_ the filename.
Saving title `Draft [v2]` writes `Draft v2.md`, and the displayed title
becomes `Draft v2` — the bracketed form is not preserved anywhere. Accepted:
what you can title a note is exactly what filenames allow, identical to
Obsidian's model, and it keeps path-as-identity single-source.

## Implementation plan

1. `file-ops.ts:302` — extend the regex; update the doc comment to name the
   Obsidian-forbidden chars.
2. `export-utils.ts:412` — same regex; add `'untitled'` fallback after trim.
3. `file-ops.test.ts` — extend T350: `Draft [v2] #1` → `Draft v2 1`,
   `a^b|c` → `abc`, `[#^]` → `untitled`, existing cases unchanged.
4. `export-utils.test.ts` — bracket/hash/caret case + empty-after-strip →
   `untitled`.

## Verification

- `pnpm --filter @memry/desktop test:main` — file-ops.test.ts and
  export-utils.test.ts green with the new char cases
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:desktop`
- Manual: create note titled `Draft [v2] #1` in a vault, open the vault in
  Obsidian ≥1.8, confirm `[[Draft v2 1]]` resolves

## Interactions

- **01-frontmatter-diet.md** — title derives from the filename; this spec
  defines the sanitization applied on the way in (see Design §4). Spec 01's
  sidecar id mapping keys on the _sanitized_ path.
- **04-byte-preservation.md** — no-retroactive-rename is this spec's side of
  the byte-preservation guarantee; golden round-trip fixtures may include a
  legacy `[bracketed] #name.md` to pin it.

## Open questions

- Renderer-side inline hint ("saved as: Draft v2 1.md") when a title contains
  forbidden chars — nice UX, none exists today, out of scope.
- Consolidating the four sanitizer copies (file-ops, export-utils, inbox
  attachments ×2) into one shared util — future cleanup, not this branch.

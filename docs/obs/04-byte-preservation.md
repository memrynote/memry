# Byte Preservation — Design

**Date:** 2026-07-05
**Branch:** `obs-byte-preservation`
**Status:** Approved, pending implementation

## Goal

No write without a semantic change; anything the user didn't change stays
byte-identical. Concretely:

1. **Skip-write on no-op** — if the would-be file content equals the on-disk
   bytes, no write happens at all: no mtime churn, no watcher echo, no sync item.
2. **Verbatim frontmatter** — the raw frontmatter block (delimiters, quoting,
   comments, indentation, key order) is re-emitted unchanged unless a property
   was actually edited in Memry.
3. **Line endings and trailing newline** — CRLF/LF and final-newline
   presence/absence are detected per file and preserved.
4. **Golden round-trip suite** — a fixture mini-vault of adversarial files that
   must survive parse → (no edit) → save byte-identical. This suite is the
   regression insurance for every other obs spec (01/02/03/05/06).

## Current behavior

- `parseNote` (`apps/desktop/src/main/vault/frontmatter.ts:54-110`) calls
  `matter(rawContent)` and keeps only `data` + `content` — the raw frontmatter
  substring is discarded. It also `content.trim()`s the body (line 106) and
  mutates `data` (auto id/created/modified — removed by spec 01).
- `serializeNote` (`frontmatter.ts:140-152`) rebuilds frontmatter from the
  object via `matter.stringify` (key order, quoting, comments all lost), bumps
  `modified` on every save (removed by spec 01), and pipes through
  `stripTrailingNewlines` (`frontmatter.ts:129-131`) which **kills the trailing
  final newline of every file** — an unconditional byte change on any vault
  whose files end with `\n` (i.e. nearly all of them).
- `updateNote` (`apps/desktop/src/main/vault/notes-crud.ts:464-600`) always
  serializes and calls `atomicWrite` (line 541) even when nothing changed, then
  emits `NotesChannels.events.UPDATED` and syncs caches.
- CRDT write-back (`apps/desktop/src/main/sync/crdt-writeback.ts`):
  `writebackExisting` (200-251) and `writebackJournal` re-read the file, call
  `mergeFrontmatter` (459) which bumps `modified: utcNow()`, then
  `serializeNote` + `atomicWrite` unconditionally on every debounced flush
  (500 ms, line 35). Watcher echo is suppressed only by the `ignoredWrites`
  TTL map (line 44, checked in `watcher.ts:305,549`) — the mtime churn and
  downstream sync items still happen.
- Read-path write: `getNoteById` (`notes-crud.ts:322-347`) rewrites a file when
  it finds a duplicate frontmatter id. Moot after spec 01 (path is identity).
- Duplicate pipeline: `packages/app-core/src/markdown.ts:8-18` —
  `parseMarkdownNote` trims the body, `writeMarkdownNote` re-stringifies via
  gray-matter and `.trimEnd()`s. Used by the CLI/app-core notes service.
- Renderer save path: body edits flow through the main-owned Y.Doc, so the file
  write is main-side (`yDocToMarkdown`, `blocknote-converter.ts:89` →
  `crdt-writeback.ts`). Property/title/tag edits go
  `notesService.update` → IPC `NotesChannels.invoke.UPDATE` → `updateNote`.
  `extractMarkdownFromActiveEditor` (`use-editor-sync.ts:54`) only serves the
  agent-MCP current-note read.
- gray-matter 4.0.3 **does expose the raw block**: `file.matter` is the exact
  substring between the delimiters (`node_modules/gray-matter/index.js:99`,
  `str.slice(0, closeIndex)`), CR bytes included. It does not include the
  `---` lines themselves. Gotcha: gray-matter caches file objects keyed by
  content when called without options (`index.js:35-47`) — any mutation of
  `data` leaks into later parses of identical content.
- Existing round-trip tests are renderer-side block-level only
  (`markdown-utils.test.ts:439`,
  `critic-markup-offset-map.integration.test.ts`) — nothing asserts
  file-level bytes through the main pipeline.

## Design

### 1. Skip-write on no-op

New helper in `apps/desktop/src/main/vault/file-ops.ts`:

```ts
export async function writeIfChanged(filePath: string, content: string): Promise<boolean> {
  const existing = await safeRead(filePath)
  if (existing === content) return false
  await atomicWrite(filePath, content)
  return true
}
```

Every note write site switches to it: `updateNote`, `writebackExisting`,
`writebackJournal` (`writebackNewNote` creates, nothing to compare). When it
returns `false`, the caller also skips `syncNoteToCache` event side effects,
the renderer event emit, and snapshot creation — no observable change means no
downstream signal. `ignoredWrites` stays for real writes but stops carrying
no-op traffic.

### 2. Verbatim frontmatter

`parseNote` gains raw capture. `ParsedNote` extends to:

```ts
export interface ParsedNote {
  frontmatter: NoteFrontmatter
  content: string
  hadFrontmatter: boolean
  /** Exact original substring from byte 0 through the closing '---' line
      (incl. its EOL), or null when the file had no frontmatter. */
  rawFrontmatterBlock: string | null
  eol: '\n' | '\r\n'
  hadTrailingNewline: boolean
}
```

We slice `rawFrontmatterBlock` ourselves from the raw string (a small
`splitFrontmatterBlock(raw)` scanning for the same `---` delimiters gray-matter
uses) rather than reconstructing from `file.matter` — reassembling delimiters +
CR handling around gray-matter's slice is fiddlier than one forward scan, and
slicing keeps us byte-exact by construction. gray-matter remains the YAML
parser for `data` only, called as `matter(raw, {})` to bypass its shared cache.

Serialization becomes:

```ts
serializeNote(parsed, content, { frontmatterEdited: boolean })
```

- `frontmatterEdited: false` → emit `parsed.rawFrontmatterBlock` verbatim
  (or nothing if null) + body. Comments, anchors, flow style, key order,
  quoting all survive because we never re-stringify.
- `frontmatterEdited: true` → re-emit the whole block in Obsidian style
  (spec 05 owns the emitter; until 05 lands, gray-matter stringify is the
  interim, still gated behind an actual edit).

Callers decide `frontmatterEdited` honestly: `updateNote` sets it only when
`input.frontmatter`/`properties`/`tags`/`title` actually differ from existing;
`mergeFrontmatter` in crdt-writeback returns a `changed` flag instead of
unconditionally spreading + bumping `modified` (the bump itself dies in
spec 01).

### 3. Line endings + trailing newline

- Detect once at parse: `eol = raw.includes('\r\n') ? '\r\n' : '\n'`;
  `hadTrailingNewline = /\r?\n$/.test(raw)`.
- On save, assemble `frontmatterBlock + body`, convert body EOLs to
  `parsed.eol` (BlockNote always emits LF), then apply the trailing-newline
  policy: append exactly one `eol` if `hadTrailingNewline`, none otherwise.
  New files get a single trailing LF.
- Delete `stripTrailingNewlines` from `frontmatter.ts` and the `.trimEnd()` in
  `writeMarkdownNote`; drop `parseNote`'s `content.trim()` in favor of keeping
  the body substring as-is (trailing-blank handling now lives in the assembly
  step above). `app-core/src/markdown.ts` mirrors the same split/assemble so
  the CLI pipeline can't diverge.

### 4. Body scope honesty

When the user did edit the body, BlockNote re-serialization rewrites the body —
accepted; spec 06 owns foreign-syntax fidelity within that rewrite. The
guarantees this spec makes are exactly:

| Guarantee                                        | Mechanism                                                 |
| ------------------------------------------------ | --------------------------------------------------------- |
| (a) Unchanged files are never rewritten          | `writeIfChanged` at every write site                      |
| (b) Frontmatter is never rewritten by body edits | verbatim `rawFrontmatterBlock` unless `frontmatterEdited` |
| (c) Unchanged files' mtimes stay untouched       | skip-write skips `atomicWrite` (temp+rename) entirely     |

### 5. Golden round-trip suite

- **Fixtures:** `apps/desktop/src/main/vault/__fixtures__/golden-vault/`
  (follows the `import/*/__fixtures__` convention), one `.md` per case:
  `yaml-comments.md`, `yaml-flow-style.md`, `yaml-anchors.md`,
  `yaml-weird-quoting.md` (single/double/plain mixed, `"[[wikilink]]"`),
  `crlf.md`, `no-trailing-newline.md`, `tasks-emoji.md` (➕⏳🛫📅✅ 🔁),
  `block-ids.md` (` ^abc123`), `percent-comments.md` (`%%inline%%` + block),
  `nested-callouts.md`, `dataview-inline-fields.md`, `no-frontmatter.md`.
  A `.gitattributes` with `* -text` inside the dir so git never normalizes the
  CRLF / no-final-newline fixtures.
- **Test:** `apps/desktop/src/main/vault/byte-preservation.golden.test.ts`,
  main-process vitest (`pnpm --filter @memry/desktop test:main`, project
  `main` in `config/vitest.config.ts`). It hooks the real pipeline, not a
  reimplementation:
  1. Read fixture bytes → `parseNote` → `serializeNote(parsed, parsed.content,
{ frontmatterEdited: false })` → assert strict equality with the original
     string (and `Buffer.compare === 0` to catch encoding surprises).
  2. Copy fixtures into a temp dir, run `writeIfChanged(path, roundTripped)` →
     assert it returns `false` and `fs.stat` mtime is unchanged.
  3. One mutation case per class: edit a property → only the frontmatter block
     differs; edit the body → the frontmatter block is byte-identical.
- CI: runs inside `pnpm test:desktop` (turbo) automatically.

## Implementation plan

1. `file-ops.ts`: add `writeIfChanged` + unit tests in `file-ops.test.ts`
   (equal content → no write, mtime stable; changed → write).
2. `frontmatter.ts`: add `splitFrontmatterBlock`, extend `ParsedNote`
   (`rawFrontmatterBlock`, `eol`, `hadTrailingNewline`), rework
   `serializeNote` to the verbatim/edited split, delete
   `stripTrailingNewlines`, bypass the gray-matter cache. Update
   `frontmatter.test.ts`.
3. `notes-crud.ts` `updateNote`: compute `frontmatterEdited`, use the new
   `serializeNote`, switch to `writeIfChanged`, gate event emit / cache sync /
   snapshot on an actual write.
4. `crdt-writeback.ts`: `mergeFrontmatter` returns `{ frontmatter, changed }`;
   `writebackExisting` / `writebackJournal` pass verbatim parse-through and
   use `writeIfChanged`, skipping emit + cache sync on no-op.
5. `packages/app-core/src/markdown.ts`: mirror split/assemble; drop
   `.trimEnd()` and body `trim()`.
6. Add `__fixtures__/golden-vault/` (+ `.gitattributes`) and
   `byte-preservation.golden.test.ts`.
7. Sweep remaining `serializeNote` callers (`getNoteById` duplicate-id rewrite,
   templates/journal creation) for signature fallout; the duplicate-id rewrite
   is deleted by spec 01 — do not extend it here.

## Verification

- `pnpm --filter @memry/desktop test:main` — golden suite green
- `pnpm typecheck` · `pnpm lint` · `pnpm test:desktop`
- Manual: open a git-tracked Obsidian vault, open several notes without
  editing, quit — `git status` clean (no content diff, no mtime-driven churn).

## Interactions

- **[01-frontmatter-diet.md](01-frontmatter-diet.md)** — removes the
  `modified` bump and parse-time auto-id mutation; this spec assumes 01's
  parse is non-mutating (execution order 01 → 04). The golden suite then
  gates 01's own regressions.
- **[05-properties-top-level.md](05-properties-top-level.md)** — owns the
  Obsidian-style emitter used only on the `frontmatterEdited: true` branch.
- **[06-foreign-syntax-preservation.md](06-foreign-syntax-preservation.md)** —
  owns body fidelity when the body _is_ edited; the golden fixtures
  (Tasks emoji, block IDs, `%%…%%`, callouts) pass here via whole-file
  verbatim skip, and become 06's edit-path fixtures later.

## Resolved questions (Kaan, 2026-07-05)

1. **BOM: preserve verbatim.** Capture it in `splitFrontmatterBlock` and
   re-emit — it's a byte the user didn't change. (Unedited files are covered
   by whole-file skip anyway; this rule matters on the edited path.)
2. **Mixed EOL: first-EOL-wins is accepted.** Minority CRLF lines may be
   rewritten to the dominant EOL when the body is edited — covered by
   body-scope honesty. Per-line EOL preservation is explicitly out of scope.
3. **No-op `updateNote` skips the index-DB cache refresh entirely.** Identical
   bytes imply an already-correct cache; skipping keeps "no write = no signal"
   strict (no watcher echo, no sync item, no mtime bump).

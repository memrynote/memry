# CriticMarkup Comments Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CriticMarkup the canonical storage format for note and journal comments/review marks, with SQLite only as a local search/cache projection and E2EE proof tests for sync.

**Architecture:** Add a pure CriticMarkup parser/serializer/transform layer, then thread parsed marks through contracts, local projection storage, renderer rail/action UI, and note/journal markdown saves. Remove the SQL-owned comment sync path so marks travel only inside encrypted note/journal content.

**Tech Stack:** TypeScript, React 19, BlockNote, Electron IPC/preload, Drizzle SQLite, Vitest, pnpm, existing Memry sync/encryption pipeline.

---

## Source Spec

Implement against `docs/superpowers/specs/2026-05-23-criticmarkup-comments-design.md`.

## Required Setup

- Implementation must start in a fresh worktree, not this planning worktree.
- Use @subagent-driven-development for execution because this codebase has independent parser, storage, renderer, and sync tasks.
- Use @test-driven-development for every feature task.
- Use @verification-before-completion before claiming done.
- Do not commit unless Kaan explicitly asks. If commits are requested, commit only after each task's verification passes.

## File Map

Create:

- `packages/shared/src/critic-markup/types.ts` - pure shared mark/action/result types used by main and renderer.
- `packages/shared/src/critic-markup/metadata.ts` - readable metadata parse/serialize/escape helpers.
- `packages/shared/src/critic-markup/protected-ranges.ts` - Markdown protected range detector.
- `packages/shared/src/critic-markup/parser.ts` - left-to-right CriticMarkup parser and pairing rules.
- `packages/shared/src/critic-markup/transforms.ts` - accept/reject/update/delete/wrap transforms.
- `packages/shared/src/critic-markup/index.ts` - critic-markup subpath exports.
- `packages/shared/src/critic-markup/*.test.ts` - focused shared Vitest coverage.
- `packages/contracts/src/critic-markup-api.ts` - IPC-safe schemas for parsed marks, projection reads, changed events, and markdown actions.
- `packages/contracts/src/critic-markup-api.test.ts` - contract schema tests.
- `packages/db-schema/src/schema/critic-marks.ts` - `critic_marks` projection schema.
- `apps/desktop/src/main/critic-marks/projection-store.ts` - local projection rebuild/query store.
- `apps/desktop/src/main/critic-marks/projection-store.test.ts` - projection tests.
- `apps/desktop/src/main/critic-marks/search-index.ts` - helper that projects mark text/body into local search indexing.
- `apps/desktop/src/main/ipc/critic-markup-handlers.ts` - IPC handlers for projection reads/action broadcasts if needed.
- `apps/desktop/src/renderer/src/services/critic-markup-service.ts` - renderer service wrapper.
- `apps/desktop/src/renderer/src/lib/critic-markup-actions.ts` - renderer helpers that transform note/journal markdown and save it.
- `apps/desktop/src/renderer/src/components/comments/review-mark-actions.tsx` - accept/reject controls for review marks.
- `apps/desktop/src/renderer/src/components/comments/critic-mark-rendering.test.tsx` - renderer tests for marks/controls.
- `apps/desktop/src/main/sync/critic-markup-e2ee.test.ts` - E2EE proof tests.

Modify:

- `packages/contracts/src/comments-api.ts` - remove old SQL-owned CRUD contract or re-export new types temporarily if imports require staged changes.
- `packages/contracts/src/index.ts` - export new critic-markup API.
- `packages/contracts/src/ipc-channels.ts` - replace `CommentsChannels` with critic-mark channels or keep channel names only if payloads are renamed and no SQL CRUD remains.
- `packages/contracts/src/sync-api.ts` - remove `comment` from sync item type constants.
- `packages/contracts/src/sync-payloads.ts` - remove `CommentSyncPayloadSchema`.
- `packages/db-schema/src/schema/index.ts` and `packages/db-schema/src/data-schema.ts` - export `critic_marks` schema and remove old comments export if no longer used.
- `apps/desktop/src/main/database/drizzle-data/*` - generate/adjust migration replacing comments projection with critic marks. App is pre-release; hard reset is acceptable.
- `apps/desktop/src/main/ipc/comments-handlers.ts` - delete or reduce to compatibility-free critic handler registration.
- `apps/desktop/src/main/comments/store.ts` and `apps/desktop/src/main/comments/runtime-effects.ts` - remove canonical store/sync effects or replace with projection-only code.
- `apps/desktop/src/preload/api/comments.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/preload/index.d.ts`, `apps/desktop/src/preload/api/preload-api.test.ts` - update preload API surface.
- `apps/desktop/src/main/sync/runtime.ts`, `apps/desktop/src/main/sync/local-mutations.ts`, `apps/desktop/src/main/sync/offline-clock.ts`, `apps/desktop/src/main/sync/item-handlers/index.ts` - remove comment sync registration/offline clocks/handlers.
- Delete or rewrite `apps/desktop/src/main/sync/comment-sync.ts`, `apps/desktop/src/main/sync/item-handlers/comment-handler.ts`, and their tests.
- `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx` - replace selected-quote SQL overlays with parsed CriticMarkup marks.
- `apps/desktop/src/renderer/src/components/note/content-area/types.ts` - replace `comments` props with critic mark props/actions.
- `apps/desktop/src/renderer/src/pages/note.tsx` and `apps/desktop/src/renderer/src/pages/journal.tsx` - load parsed marks from markdown/projection and save markdown transforms.
- `apps/desktop/src/renderer/src/components/comments/comments-rail.tsx`, `comments-panel.tsx`, `comment-mentions.tsx`, `comment-compose-utils.ts` - accept parsed marks and metadata-backed bodies.
- `apps/docs/src/user-guide/notes/editing.md`, `apps/docs/src/user-guide/journal/daily-entries.md`, `apps/docs/src/architecture/sync-protocol.md`, `apps/docs/src/architecture/sync-handlers.md`, `apps/docs/src/architecture/local-storage.md` - update docs.

Verification commands:

- Focused shared tests: `pnpm --filter @memry/desktop test:shared -- critic-markup`
- Focused main tests: `pnpm --filter @memry/desktop test:main -- critic-mark`
- Focused renderer tests: `pnpm --filter @memry/desktop test:renderer -- critic-mark comments-rail ContentArea`
- Focused contract tests: `pnpm --filter @memry/desktop test:shared -- critic-markup-api sync-api sync-payloads ipc-channels`
- IPC after contract/preload changes: `pnpm ipc:generate && pnpm ipc:check`
- Full desktop checks: `pnpm --filter @memry/desktop typecheck && pnpm --filter @memry/desktop test`
- Repo checks: `pnpm typecheck && pnpm test && pnpm lint && git diff --check`
- Docs gate after docs changes: `pnpm docs:impact --base origin/main --strict && pnpm docs:build`

---

## Chunk 1: Pure CriticMarkup Core

### Task 1: Metadata Grammar

**Files:**

- Create: `packages/shared/src/critic-markup/types.ts`
- Create: `packages/shared/src/critic-markup/metadata.ts`
- Create: `packages/shared/src/critic-markup/metadata.test.ts`
- Create: `packages/shared/src/critic-markup/index.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/package.json`

- [ ] **Step 1: Write failing metadata tests**

Add tests for valid metadata, plain comments, escaping, unknown key preservation, invalid status, attachments, mentions, and `\n` body rendering.

Required test cases:

```ts
expect(parseCriticMetadata('id:c_1 status:open kind:highlight | Body')).toMatchObject({
  metadata: { id: 'c_1', status: 'open', kind: 'highlight' },
  body: 'Body'
})

expect(serializeCriticMetadata({ id: 'c_1', status: 'open', kind: 'comment' }, 'A | B')).toBe(
  'id:c_1 status:open kind:comment | A \\| B'
)

expect(parseCriticMetadata('not metadata at all')).toMatchObject({
  metadata: null,
  body: 'not metadata at all'
})
```

- [ ] **Step 2: Run metadata test and verify it fails**

Run: `pnpm --filter @memry/desktop test:shared -- metadata.test.ts`

Expected: FAIL because `parseCriticMetadata` and `serializeCriticMetadata` do not exist.

- [ ] **Step 3: Implement minimal metadata helpers**

Implement exported helpers:

```ts
export function parseCriticMetadata(payload: string): ParsedCriticMetadata
export function serializeCriticMetadata(metadata: CriticMarkupMetadata, body: string): string
export function escapeCriticValue(value: string): string
export function unescapeCriticValue(value: string): string
```

Rules: first unescaped `|` splits metadata/body; unescaped `<<}` terminates comments at parser layer; unknown keys preserved in `extra`; invalid known values produce `warnings` but preserve body.

Update `packages/shared/package.json` exports with `./critic-markup`: `./src/critic-markup/index.ts` so desktop main and renderer can import the same pure code.

- [ ] **Step 4: Run metadata test and verify it passes**

Run: `pnpm --filter @memry/desktop test:shared -- metadata.test.ts`

Expected: PASS.

### Task 2: Protected Ranges and Parser

**Files:**

- Create: `packages/shared/src/critic-markup/protected-ranges.ts`
- Create: `packages/shared/src/critic-markup/protected-ranges.test.ts`
- Create: `packages/shared/src/critic-markup/parser.ts`
- Create: `packages/shared/src/critic-markup/parser.test.ts`
- Modify: `packages/shared/src/critic-markup/index.ts`

- [ ] **Step 1: Write failing protected range tests**

Cover YAML frontmatter, fenced code, indented code, inline code, raw HTML blocks, and HTML comments. Include literal strings like `{--not a deletion--}` inside protected ranges.

- [ ] **Step 2: Write failing parser tests from the CriticMarkup README**

Include fixtures for:

```md
Lorem ipsum dolor{++ sit++} amet...
Lorem{-- ipsum--} dolor sit amet...
Lorem {~~hipsum~>ipsum~~} dolor sit amet...
Lorem ipsum dolor sit amet.{>>This is a comment<<}
Lorem {==Truth is stranger than fiction==}{>>true<<}.
```

Also include metadata-backed review marks:

```md
Text{++ add++}{>>id:r_1 status:open kind:addition | reason<<}
Text{-- remove--}{>>id:r_2 status:open kind:deletion | reason<<}
Text {~~bad~>good~~}{>>id:r_3 status:open kind:substitution | reason<<}
```

Include edge fixtures for unclosed marks, nested openers as literal payload, overlapping marks falling back to literal text, escaped and unescaped `<<}` in comment bodies, conflicting review metadata `kind`, and exact `sourceStart` / `sourceEnd` offsets.

- [ ] **Step 3: Run parser tests and verify they fail**

Run: `pnpm --filter @memry/desktop test:shared -- protected-ranges.test.ts parser.test.ts`

Expected: FAIL because parser modules do not exist.

- [ ] **Step 4: Implement protected range detector**

Implement `findMarkdownProtectedRanges(markdown: string): Array<{ start: number; end: number; kind: string }>` and `isOffsetProtected(ranges, offset)`.

- [ ] **Step 5: Implement parser**

Implement `parseCriticMarkup(markdown, options)` returning non-overlapping marks with `id`, `kind`, `sourceStart`, `sourceEnd`, `text`, `oldText`, `newText`, `body`, `metadata`, `pairedComment`, and `warnings`.

Required options:

```ts
interface ParseCriticMarkupOptions {
  targetType: 'note' | 'journal'
  targetId: string
}
```

Parser rules:

- Scan left to right.
- Skip protected ranges.
- Do not recursively parse mark contents.
- Pair highlight+comment only when adjacent with optional whitespace.
- Pair review mark metadata only when adjacent and `kind` matches or is absent.
- Plain marks get deterministic IDs from target id, kind, offsets, and text hash.

- [ ] **Step 6: Run parser tests and verify they pass**

Run: `pnpm --filter @memry/desktop test:shared -- protected-ranges.test.ts parser.test.ts`

Expected: PASS.

### Task 3: Markdown Transforms

**Files:**

- Create: `packages/shared/src/critic-markup/transforms.ts`
- Create: `packages/shared/src/critic-markup/transforms.test.ts`
- Modify: `packages/shared/src/critic-markup/index.ts`

- [ ] **Step 1: Write failing transform tests**

Cover accept/reject for addition, deletion, substitution, comment update/delete, highlight unwrap delete, duplicate id returns `ambiguous-mark`, absent id returns `mark-not-found`, wrong action returns `invalid-mark`.

Required examples:

```ts
expect(applyCriticMarkupAction('A{++B++}', { type: 'accept', markId }).markdown).toBe('AB')
expect(applyCriticMarkupAction('A{++B++}', { type: 'reject', markId }).markdown).toBe('A')
expect(applyCriticMarkupAction('A{--B--}', { type: 'accept', markId }).markdown).toBe('A')
expect(applyCriticMarkupAction('A{--B--}', { type: 'reject', markId }).markdown).toBe('AB')
expect(applyCriticMarkupAction('A{~~B~>C~~}', { type: 'accept', markId }).markdown).toBe('AC')
expect(applyCriticMarkupAction('A{~~B~>C~~}', { type: 'reject', markId }).markdown).toBe('AB')
```

Also assert metadata-backed accept/reject removes both the review mark and paired `{>> <<}` comment, and strict `expectedContentHash` mismatch returns `stale-cache` without editing markdown.

- [ ] **Step 2: Run transform tests and verify they fail**

Run: `pnpm --filter @memry/desktop test:shared -- transforms.test.ts`

Expected: FAIL because action helpers do not exist.

- [ ] **Step 3: Implement transforms**

Implement:

```ts
export function applyCriticMarkupAction(
  markdown: string,
  action: CriticMarkupAction
): CriticMarkupActionResult
export function wrapSelectionAsCriticHighlight(
  markdown: string,
  range: TextRange,
  input: CreateCriticCommentInput
): CriticMarkupActionResult
export function insertPointCriticComment(
  markdown: string,
  offset: number,
  input: CreateCriticCommentInput
): CriticMarkupActionResult
```

Every transform reparses current markdown first and uses metadata IDs as primary locators.

- [ ] **Step 4: Run shared core test suite**

Run: `pnpm --filter @memry/desktop test:shared -- critic-markup`

Expected: PASS.

---

## Chunk 2: Contracts, SQLite Projection, and IPC

### Task 4: Contract Schemas and Critic-Mark IPC Channels

**Files:**

- Create: `packages/contracts/src/critic-markup-api.ts`
- Create: `packages/contracts/src/critic-markup-api.test.ts`
- Modify: `packages/contracts/src/comments-api.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/ipc-channels.ts`
- Modify: `packages/contracts/package.json`
- Modify tests: `packages/contracts/src/comments-api.test.ts`, `ipc-channels.test.ts`

- [ ] **Step 1: Write failing contract tests**

Assert schemas accept parsed marks, action requests, projection list requests, and changed events. Do not remove `comment` sync constants in this task; that happens with the desktop sync deletion in Task 10 so the repo stays compile-safe between chunks.

- [ ] **Step 2: Run contract tests and verify they fail**

Run: `pnpm --filter @memry/desktop test:shared -- critic-markup-api ipc-channels`

Expected: FAIL because new schemas and channels do not exist.

- [ ] **Step 3: Add critic-markup contract schemas**

Define Zod schemas with these fields:

```ts
CriticMarkKind = 'addition' | 'deletion' | 'substitution' | 'comment' | 'highlight'
CriticMarkStatus = 'open' | 'resolved' | 'archived'
CriticMark = {
  id: string
  targetType: 'note' | 'journal'
  targetId: string
  kind: CriticMarkKind
  status: CriticMarkStatus | null
  selectedQuote: string
  oldText: string | null
  newText: string | null
  body: string
  mentionRefs: CriticMentionRef[]
  attachmentRefs: string[]
  markdownStart: number
  markdownEnd: number
  contentHash: string
  createdAt: string | null
  modifiedAt: string | null
  warnings: string[]
}
ListCriticMarksInput = { targetType: 'note' | 'journal'; targetId: string; status?: CriticMarkStatus | CriticMarkStatus[] }
ApplyCriticMarkupActionInput = { targetType: 'note' | 'journal'; targetId: string; markId: string; action: 'accept' | 'reject' | 'update-comment' | 'delete' | 'set-status'; body?: string; status?: CriticMarkStatus; expectedContentHash?: string }
ApplyCriticMarkupActionResult = { ok: true; markdown: string; activeMarkId?: string | null } | { ok: false; error: 'mark-not-found' | 'ambiguous-mark' | 'stale-cache' | 'invalid-mark' }
CriticMarksChangedEvent = { targetType: 'note' | 'journal'; targetId: string; markId: string; action: 'rebuilt' | 'updated' | 'deleted' }
```

Add `./critic-markup-api` to `packages/contracts/package.json` exports.

- [ ] **Step 4: Keep mention refs but stop exposing SQL CRUD as the preferred API**

Move or re-export `CommentMentionKindSchema` and `CommentMentionRefSchema` from `critic-markup-api.ts` so existing mention rendering can migrate without keeping SQL CRUD semantics. Do not delete `CommentSyncPayloadSchema` until Task 10.

- [ ] **Step 5: Update IPC channel constants**

Replace SQL CRUD channels with critic-mark channels such as `critic-marks:list`, `critic-marks:rebuild`, and `critic-marks:changed`. Do not keep create/update/delete SQL-source channels.

- [ ] **Step 6: Run contract tests and IPC generation**

Run: `pnpm --filter @memry/desktop test:shared -- critic-markup-api ipc-channels && pnpm ipc:generate && pnpm ipc:check`

Expected: PASS and no generated IPC diff after `ipc:check`.

### Task 5: SQLite Projection Schema and Store

**Files:**

- Create: `packages/db-schema/src/schema/critic-marks.ts`
- Modify: `packages/db-schema/src/schema/index.ts`
- Modify: `packages/db-schema/src/data-schema.ts`
- Modify: `apps/desktop/src/main/database/drizzle-data/*`
- Create: `apps/desktop/src/main/critic-marks/projection-store.ts`
- Create: `apps/desktop/src/main/critic-marks/projection-store.test.ts`
- Create: `apps/desktop/src/main/critic-marks/search-index.ts`
- Create: `apps/desktop/src/main/critic-marks/search-index.test.ts`
- Modify: `apps/desktop/src/main/vault/note-sync.ts`
- Modify: `apps/desktop/src/main/vault/indexer.ts`
- Modify or delete: `packages/db-schema/src/schema/comments.ts`
- Modify or delete: `apps/desktop/src/main/comments/store.ts`, `apps/desktop/src/main/comments/store.test.ts`

- [ ] **Step 1: Write failing projection store tests**

Test rebuilding marks from note markdown and journal markdown, replacing stale rows by target, deterministic IDs for plain marks, metadata IDs for Memry marks, stale/missing cache rebuild on content-hash mismatch, and no sync clock columns.

- [ ] **Step 2: Run projection tests and verify they fail**

Run: `pnpm --filter @memry/desktop test:main -- projection-store.test.ts`

Expected: FAIL because `critic_marks` schema/store do not exist.

- [ ] **Step 3: Add `critic_marks` schema**

Fields: `id`, `targetType`, `targetId`, `kind`, `status`, `selectedQuote`, `oldText`, `newText`, `body`, `mentionRefs`, `attachmentRefs`, `markdownStart`, `markdownEnd`, `contentHash`, `createdAt`, `modifiedAt`, `indexedAt`. Index by target, target+status, kind, and content hash.

- [ ] **Step 4: Generate or hard-write data migration**

Run: `pnpm --filter @memry/desktop db:generate:data`

Expected: new migration adds `critic_marks` and removes or ignores old `comments`. Because app is pre-release, do not add data migration compatibility logic.

- [ ] **Step 5: Implement projection rebuild/query store**

Implement:

```ts
rebuildCriticMarksForTarget(db, { targetType, targetId, markdown }): CriticMark[]
listCriticMarks(db, input): CriticMark[]
clearCriticMarksForTarget(db, targetType, targetId): void
ensureCriticMarksProjectionFresh(db, { targetType, targetId, markdown }): CriticMark[]
```

Rules: SQLite rows are a projection only; when `contentHash` differs from current markdown, rebuild before returning rows. Missing cache rows for a target with marks must rebuild on open/index and after synced note/journal content lands through the existing projection event path.

- [ ] **Step 6: Add local search projection helper**

Implement `buildCriticMarkSearchText(mark)` and wire note/journal indexing paths through `apps/desktop/src/main/vault/note-sync.ts` / `indexer.ts` or the existing projection event consumer so comment body, deleted text, inserted text, substitution text, and highlighted quote are searchable locally. Do not create a sync path for `critic_marks`.

- [ ] **Step 7: Run projection and search tests**

Run: `pnpm --filter @memry/desktop test:main -- projection-store.test.ts search-index.test.ts`

Expected: PASS.

### Task 6: Main IPC and Preload API

**Files:**

- Create: `apps/desktop/src/main/ipc/critic-markup-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/comments-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/index.ts`
- Modify: `apps/desktop/src/preload/api/comments.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`
- Modify: `apps/desktop/src/preload/api/preload-api.test.ts`
- Create: `apps/desktop/src/renderer/src/services/critic-markup-service.ts`
- Modify or delete: `apps/desktop/src/renderer/src/services/comments-service.ts`

- [ ] **Step 1: Write failing preload and handler tests**

Update tests to expect critic-mark projection list/rebuild APIs and changed event subscription. Remove expectations for SQL create/update/resolve/archive/delete/linkAttachment.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `pnpm --filter @memry/desktop test:main -- comments-handlers critic-markup-handlers && pnpm --filter @memry/desktop test:renderer -- preload-api.test.ts`

Expected: FAIL because API surface still uses old comments CRUD.

- [ ] **Step 3: Implement handlers and preload API**

Expose projection reads and rebuild triggers only. Markdown mutation actions should remain in renderer page code unless main already owns note/journal content writes for the touched flow.

- [ ] **Step 4: Remove sync side effects from handlers**

Delete calls to `syncCommentCreate`, `syncCommentUpdate`, and `syncCommentDelete`. No critic mark projection API may enqueue sync.

- [ ] **Step 5: Run IPC checks and focused tests**

Run: `pnpm ipc:generate && pnpm ipc:check && pnpm --filter @memry/desktop test:main -- critic-markup-handlers projection-store && pnpm --filter @memry/desktop test:renderer -- preload-api.test.ts`

Expected: PASS.

---

## Chunk 3: Renderer Markdown Actions and UI

### Task 7: Note and Journal Markdown Action Helpers

**Files:**

- Create: `apps/desktop/src/renderer/src/lib/critic-markup-actions.ts`
- Create: `apps/desktop/src/renderer/src/lib/critic-markup-actions.test.ts`
- Modify: `apps/desktop/src/renderer/src/pages/note.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/journal.tsx`

- [ ] **Step 1: Write failing renderer helper tests**

Test that creating a selected comment produces `{==selection==}{>>metadata | body<<}`, point comment insertion works, comment update rewrites the `{>> <<}` body, comment delete unwraps highlight text, status updates rewrite `status`, and accept/reject delegates to shared transforms and returns next markdown. Include block-comment safety cases for child blocks, generated task/callout syntax, custom/media/code blocks, nested/list blocks where after-block insertion would alter structure, and ranges that would split Markdown delimiters.

- [ ] **Step 2: Run helper tests and verify they fail**

Run: `pnpm --filter @memry/desktop test:renderer -- critic-markup-actions.test.ts`

Expected: FAIL because renderer helper does not exist.

- [ ] **Step 3: Implement renderer markdown action helper**

The helper should take current markdown, current target type/id, action input, and return next markdown plus active mark id. It should not call SQL CRUD.

Also implement block-comment placement helpers:

```ts
createPlainParagraphBlockComment(markdown, blockRange, input) // wraps as highlight+comment
createUnsafeBlockPointComment(markdown, insertAfterOffset, blockId, input) // inserts separate point-comment paragraph
```

Disable block-comment creation when the target block is nested/list/custom/media/code and there is no safe after-block insertion offset.

Only wrap a block when it serializes to one plain paragraph with no children, no task/callout/generated syntax, and no range split across Markdown delimiters. Otherwise insert a point-comment paragraph after the block, and disable if that insertion would alter structure.

- [ ] **Step 4: Wire note page saves**

Change `handleSaveComment`, `handleUpdateComment`, and `handleDeleteComment` in `apps/desktop/src/renderer/src/pages/note.tsx` to transform markdown and call existing `updateNote.mutateAsync({ id: noteId, content: nextMarkdown })`. Refresh projection after save.

- [ ] **Step 5: Wire journal page saves**

Change `handleSaveComment`, `handleUpdateComment`, and `handleDeleteComment` in `apps/desktop/src/renderer/src/pages/journal.tsx` to transform `editorState.content`, call `updateContent(nextMarkdown)` from `useJournalEntry(selectedDate)`, set active mark id, and refresh projection after the save debounce path updates the current entry. Do not call `commentsService.create/update/delete`.

- [ ] **Step 6: Run renderer helper tests**

Run: `pnpm --filter @memry/desktop test:renderer -- critic-markup-actions.test.ts note journal`

Expected: PASS for helper tests; page tests should not reference old SQL create/delete calls.

### Task 8: Page Data Flow and ContentArea Mark Rendering

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/note/content-area/types.ts`
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx`
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/hooks/use-editor-sync.ts`
- Modify: `apps/desktop/src/renderer/src/pages/note.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/journal.tsx`
- Create or modify tests: `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.test.tsx`
- Modify: `apps/desktop/src/renderer/src/components/comments/comments-rail.tsx`
- Modify tests: `apps/desktop/src/renderer/src/components/comments/comments-rail.test.tsx`

- [ ] **Step 1: Write failing rendering tests**

Use markdown with all marks and assert:

- Highlight/comment shows a rail card.
- Addition/deletion/substitution show accept/reject controls.
- CriticMarkup-looking text inside inline code or fenced code does not render controls.
- Plain markdown still renders normally.
- Normal editing mode hides raw CriticMarkup delimiters from the rendered editor surface for generated marks.
- Visible review text remains visible: additions show new text, deletions show old struck text, substitutions show old/new text, comments show an anchor/highlight and rail body.

- [ ] **Step 2: Run rendering tests and verify they fail**

Run: `pnpm --filter @memry/desktop test:renderer -- ContentArea.test.tsx comments-rail.test.tsx`

Expected: FAIL because `ContentArea` still consumes SQL comment rows and selected quotes.

- [ ] **Step 3: Wire page mark data flow**

Use this renderer flow:

```text
current markdown
  -> parseCriticMarkup / criticMarksService.list-or-rebuild
  -> page criticMarks state
  -> ContentArea + CommentsRail
  -> transform action
  -> save note/journal markdown
  -> rebuild projection
  -> refresh criticMarks state
```

In `note.tsx` and `journal.tsx`, replace `comments` state with `criticMarks`, subscribe to `critic-marks:changed`, rebuild on `editorInitialContent` / `editorState.content` changes when cache is stale/missing, and clear active mark id when a mark disappears.

- [ ] **Step 4: Replace `comments` prop model with parsed critic marks**

Update props to accept `criticMarks`, `activeCriticMarkId`, and action callbacks. Keep wrapper names simple and avoid compatibility aliases unless required during the same patch.

- [ ] **Step 5: Render marks with concrete expected behavior**

Render generated marks so users do not see raw `{++`, `{--`, `{~~`, `{==`, or `{>>` delimiters in normal editing mode. The implementation may use BlockNote inline content, decorations, or overlay elements, but tests must prove raw delimiters are hidden for generated marks and action handlers still transform the canonical markdown source by mark id.

- [ ] **Step 6: Update rail cards**

Rail cards should show body/mentions/attachments for comments/highlights and show review body plus accept/reject actions for addition/deletion/substitution. Existing mention renderer can be reused after refs come from metadata.

- [ ] **Step 7: Run renderer tests**

Run: `pnpm --filter @memry/desktop test:renderer -- ContentArea.test.tsx comments-rail.test.tsx`

Expected: PASS.

### Task 9: Accept/Reject and Status UI

**Files:**

- Create: `apps/desktop/src/renderer/src/components/comments/review-mark-actions.tsx`
- Modify: `apps/desktop/src/renderer/src/components/comments/comments-rail.tsx`
- Modify: `apps/desktop/src/renderer/src/components/comments/comments-panel.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/note.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/journal.tsx`
- Test: `apps/desktop/src/renderer/src/components/comments/comments-rail.test.tsx`

- [ ] **Step 1: Write failing accept/reject UI tests**

Assert clicking Accept on addition saves markdown without the marker, Reject removes it, deletion accept removes text, deletion reject keeps text, substitution accept keeps new text, substitution reject keeps old text. Also assert Resolve, Reopen, and Archive update only the metadata `status` field in canonical markdown and refresh the rail filter.

- [ ] **Step 2: Run UI tests and verify they fail**

Run: `pnpm --filter @memry/desktop test:renderer -- comments-rail.test.tsx`

Expected: FAIL because controls do not exist.

- [ ] **Step 3: Implement review action component**

Add accessible buttons with labels `Accept change`, `Reject change`, `Resolve comment`, `Reopen comment`, and `Archive comment`. Keep styling aligned with existing comment card buttons and use logical Tailwind classes for new spacing.

- [ ] **Step 4: Wire callbacks to markdown transforms**

Call page-level action handlers that transform markdown, save note/journal content, rebuild local projection, and update active mark state. Status actions call the shared `set-status` transform and must preserve unknown metadata keys.

- [ ] **Step 5: Run UI tests**

Run: `pnpm --filter @memry/desktop test:renderer -- comments-rail.test.tsx ContentArea.test.tsx`

Expected: PASS.

---

## Chunk 4: Sync Removal, E2EE Proof, Docs, and Final Verification

### Task 10: Remove Comment Sync Path

**Files:**

- Delete or gut: `apps/desktop/src/main/sync/comment-sync.ts`
- Delete or gut: `apps/desktop/src/main/sync/item-handlers/comment-handler.ts`
- Delete or rewrite: `apps/desktop/src/main/sync/item-handlers/comment-handler.test.ts`
- Modify: `packages/contracts/src/sync-api.ts`
- Modify: `packages/contracts/src/sync-payloads.ts`
- Modify tests: `packages/contracts/src/sync-api.test.ts`, `packages/contracts/src/sync-payloads.test.ts`
- Modify: `apps/desktop/src/main/sync/runtime.ts`
- Modify: `apps/desktop/src/main/sync/local-mutations.ts`
- Modify: `apps/desktop/src/main/sync/offline-clock.ts`
- Modify: `apps/desktop/src/main/sync/item-handlers/index.ts`
- Modify tests covering sync registry/local mutations.

- [ ] **Step 1: Write failing no-comment-sync tests**

Assert `comment` is no longer in `SYNC_ITEM_TYPES`, `RECORD_SYNC_ITEM_TYPES`, `RECORD_CLOCK_REQUIRED_ITEM_TYPES`, or `ENCRYPTABLE_ITEM_TYPES`; `CommentSyncPayloadSchema` is not exported; `getHandler('comment')` is type-invalid or absent; local mutation registry cannot enqueue `comment`; and runtime adapter registry does not register `comment`.

- [ ] **Step 2: Run sync tests and verify they fail**

Run: `pnpm --filter @memry/desktop test:shared -- sync-api sync-payloads && pnpm --filter @memry/desktop test:main -- sync comment local-mutations runtime`

Expected: FAIL because `comment` sync is still registered.

- [ ] **Step 3: Remove sync service and handler registrations**

Remove sync constants/payloads, imports, adapter entries, offline clock handling, and queue paths for `comment`. Keep note/journal sync untouched.

- [ ] **Step 4: Remove deleted sync payload tests**

Delete tests that assert comment sync payload behavior. Replace with regression tests that comment sync item emission is impossible.

- [ ] **Step 5: Run sync tests**

Run: `pnpm --filter @memry/desktop test:shared -- sync-api sync-payloads && pnpm --filter @memry/desktop test:main -- sync local-mutations runtime`

Expected: PASS.

- [ ] **Step 6: Check no active comment sync references remain**

Use `grep`/IDE search for `comment-sync`, `CommentSyncPayload`, `type: 'comment'`, `enqueueLocalSyncCreate('comment'`, `enqueueLocalSyncUpdate('comment'`, and `enqueueLocalSyncDelete('comment'`.

Expected: no active sync registration, handler, payload schema, or local mutation enqueue path remains. Local `critic_marks` projection references are allowed.

### Task 11: E2EE Proof Tests

**Files:**

- Create: `apps/desktop/src/main/sync/critic-markup-e2ee.test.ts`
- Modify: `apps/desktop/src/main/sync/crdt-encrypt.test.ts`
- Modify: `apps/desktop/src/main/sync/runtime.test.ts`
- Modify: `apps/desktop/src/main/sync/crdt-provider.test.ts`
- Modify: `apps/desktop/src/main/sync/sync-crypto-batch.test.ts`
- Modify: `apps/desktop/src/main/sync/worker.test.ts`
- Modify: `apps/desktop/src/main/sync/worker-bridge.test.ts`
- Inspect/extend helpers in `apps/desktop/src/main/sync/crdt-encrypt.ts`, `runtime.ts`, `crdt-provider.ts`, `http-client.ts`, `sync-crypto-batch.ts`, `worker.ts`, `worker-bridge.ts`, and `encrypt.ts`.

- [ ] **Step 1: Write failing E2EE fixtures**

Create note and journal markdown fixtures containing unique sentinel strings for every mark:

```md
Alpha {++VISIBLE_ADD_SENTINEL++}
Beta {--VISIBLE_DELETE_SENTINEL--}
Gamma {~~VISIBLE_OLD_SENTINEL~>VISIBLE_NEW_SENTINEL~~}
Delta {>>id:c_e2ee status:open kind:comment | VISIBLE_COMMENT_SENTINEL<<}
Epsilon {==VISIBLE_HIGHLIGHT_SENTINEL==}{>>id:h_e2ee status:open kind:highlight | VISIBLE_HIGHLIGHT_BODY_SENTINEL<<}
```

- [ ] **Step 2: Assert plaintext builders and outbound artifacts**

Tests must inspect plaintext sync-item builders before encryption and final outbound/server-visible artifacts after encryption. Plaintext is allowed only in local markdown/local SQLite projection, not in server-visible sync payloads outside encrypted note/journal body handling.

Explicit assertions:

- Queue rows for note/journal may contain plaintext before `encryptPushBatch` because encryption has not happened yet.
- The output of `encryptPushBatch` and worker `encrypt-batch-result` must not contain any sentinel string or CriticMarkup opener.
- The output of `encryptCrdtUpdate`, `/sync/crdt/updates` payloads built in `runtime.ts`, `pushSnapshotForNote`, and `pushCrdtSnapshot` payloads must not contain any sentinel string or CriticMarkup opener.
- No queued or encrypted item may use type `comment`.
- No queued or encrypted item may use type `critic_mark`, `critic_marks`, or any projection/cache type.
- `critic_marks` SQLite rows may contain plaintext locally, but no projection row is prepared for upload.

- [ ] **Step 3: Run E2EE tests and verify they fail**

Run: `pnpm --filter @memry/desktop test:main -- critic-markup-e2ee.test.ts`

Expected: FAIL until comment sync is removed and note/journal encrypted payload assertions are implemented.

- [ ] **Step 4: Implement assertions against real sync path**

Extend `crdt-encrypt.test.ts` with raw CRDT update/snapshot bytes containing the sentinel markdown and assert encrypted bytes/base64 do not expose sentinels. Extend `runtime.test.ts` around the existing `/sync/crdt/updates`, `pushSnapshotForNote`, and `pushCrdtSnapshot` assertions so request bodies contain encrypted base64 only. Extend `sync-crypto-batch.test.ts` to feed record note/journal queue rows through `encryptPushBatch`. Extend worker tests if the worker path bypasses main-thread encryption assertions. Assert no `comment` item is queued/emitted for mark creation, update, delete, accept, or reject. Assert outbound artifacts do not contain sentinel strings or marker openers.

- [ ] **Step 5: Run E2EE tests**

Run: `pnpm --filter @memry/desktop test:main -- critic-markup-e2ee.test.ts`

Expected: PASS.

### Task 12: Documentation Updates

**Files:**

- Modify: `apps/docs/src/user-guide/notes/editing.md`
- Modify: `apps/docs/src/user-guide/journal/daily-entries.md`
- Modify: `apps/docs/src/architecture/sync-protocol.md`
- Modify: `apps/docs/src/architecture/sync-handlers.md`
- Modify: `apps/docs/src/architecture/local-storage.md`
- Modify: `apps/docs/src/features.md`

- [ ] **Step 1: Update user docs**

Explain that comments and review marks are CriticMarkup in saved markdown. Include examples for `{++ ++}`, `{-- --}`, `{~~ ~> ~~}`, `{>> <<}`, and `{== ==}{>> <<}`.

- [ ] **Step 2: Update architecture docs**

Remove statements that comments sync as encrypted `comment` records. Explain that note/journal content carries CriticMarkup and SQLite `critic_marks` is local projection/search cache.

- [ ] **Step 3: Run docs impact and build**

Run: `pnpm docs:impact --base origin/main --strict && pnpm docs:build`

Expected: PASS.

### Task 13: Full Verification

**Files:**

- All changed files.

- [ ] **Step 1: Run IPC checks**

Run: `pnpm ipc:generate && pnpm ipc:check`

Expected: PASS with no uncommitted generated IPC drift after check.

- [ ] **Step 2: Run focused suites**

Run: `pnpm --filter @memry/desktop test:shared -- critic-markup && pnpm --filter @memry/desktop test:main -- critic-mark sync && pnpm --filter @memry/desktop test:renderer -- critic-mark comments-rail ContentArea`

Expected: PASS.

- [ ] **Step 3: Run desktop typecheck and tests**

Run: `pnpm --filter @memry/desktop typecheck && pnpm --filter @memry/desktop test`

Expected: PASS. If native module load errors appear, run `pnpm --filter @memry/desktop rebuild:node` and retry once.

- [ ] **Step 4: Run repo-level checks**

Run: `pnpm typecheck && pnpm test && pnpm lint && git diff --check`

Expected: PASS, except known pre-existing type errors only if they match `AGENTS.md` known gotchas exactly.

- [ ] **Step 5: Manual smoke test**

Run: `pnpm dev:desktop`

Expected: desktop app opens.

Manual flow:

- Create a note with all five marks.
- Confirm rendered review UI appears.
- Accept and reject one addition/deletion/substitution each.
- Create a highlight comment in a note and a journal entry.
- Reopen the note/journal and confirm markdown still contains CriticMarkup.
- Confirm local search/cache finds comment body text.

- [ ] **Step 6: Final diff review**

Run: `git diff --stat && git diff --check`

Expected: only intended CriticMarkup, comment, sync, docs, contract, and migration files changed; no secrets; whitespace check passes.

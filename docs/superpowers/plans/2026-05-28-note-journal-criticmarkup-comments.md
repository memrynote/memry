# Note and Journal CriticMarkup Comments Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dummy note comment rail with real note and journal comment/suggestion features backed by CriticMarkup, while the BlockNote editor shows only polished UI and never raw `{++ ++}` / `{>> <<}` syntax.

**Architecture:** Keep note and journal markdown as the canonical storage layer. Add a pure CriticMarkup parser/serializer/action layer in `@memry/shared`, then add a BlockNote adapter that converts stored CriticMarkup into custom inline content/styles on load and serializes those editor nodes/styles back to CriticMarkup on save. Wire one shared review rail and one shared formatting-toolbar action surface through `ContentArea`, then pass target type/id from `NotePage` and `JournalPage`.

**Tech Stack:** TypeScript, React 19, BlockNote 0.47.1, Electron renderer, Vitest, Testing Library, Playwright, CriticMarkup.

---

## References

- CriticMarkup README: `https://github.com/CriticMarkup/CriticMarkup-toolkit/blob/master/README.md`
- BlockNote docs confirmed through `ctx7`: custom formatting toolbar buttons use `FormattingToolbarController`, `FormattingToolbar`, and `useComponentsContext`; custom rendering can use custom inline content specs and custom style specs.
- Current code facts:
  - Notes and journal both render the shared `ContentArea`.
  - `NotePage` currently owns the dummy `DummyCommentRail`.
  - `NoteLayout` already has a `sideRail` slot in the dirty working tree.
  - `ContentArea` currently uses BlockNote `FormattingToolbar` directly.
  - `ContentArea` markdown load/save flows through `parseMarkdownPreservingBlanks` and `serializeBlocksPreservingBlanks`.
  - Agent Chat already has the right mention model in `apps/desktop/src/renderer/src/agent-chat/ref-picker.tsx`, `mention-icons.tsx`, and `agent-prompt-editor.tsx`: search-backed refs, calendar refs, typed `AttachmentInput`, icon/color chips, Enter submit, and Shift+Enter newline.
  - Comment file uploads can reuse `notesService.uploadAttachment(target.id, file)`; journal image upload already does this with a journal entry id.

## Assumptions

- V1 supports selected text inside one text block. A whole paragraph/block is supported when it is a single BlockNote text block. Multi-block suggestions/comments are out of scope for the first implementation and should show disabled actions with a tooltip.
- Comments on selected text serialize as CriticMarkup highlight comments: `{==selected text==}{>>metadata | body<<}`.
- Collapsed-cursor comments serialize as plain comments: `{>>metadata | body<<}`.
- Suggested edit mode supports:
  - Collapsed cursor + inserted text -> addition `{++new text++}`.
  - Selected text + empty replacement -> deletion `{--old text--}`.
  - Selected text + replacement -> substitution `{~~old text~>new text~~}`.
- The `application` -> `applications` example should serialize as a substitution, but the UI should diff old/new and visually emphasize only the added `s`.
- Metadata inside `{>> <<}` is Memry-owned and readable, not JSON.
- Comment bodies support inline `@` mentions for note, journal, inbox, calendar event, and task refs. The picker should reuse the Agent Chat ref source and visual language: same icons, same colors, same labels.
- Comment bodies support file attachments. Files are uploaded to the note/journal attachment store, displayed as chips/previews in the rail, and persisted as attachment metadata on the CriticMarkup comment payload.
- No SQLite projection, IPC surface, or separate comment sync item in v1. Existing note/journal markdown persistence and sync carry the marks. Add a derived projection later only if search/performance needs it.

## CriticMarkup Contract

Generated Memry marks use this comment metadata shape:

```md
{>>id:c_123 status:open kind:highlight created:2026-05-28T12:00:00.000Z modified:2026-05-28T12:00:00.000Z mentions:note:n_1:Planning%20note,calendar_event:e_1:Launch%20call attachments:attachments%2Fa.pdf:a.pdf:application%2Fpdf:12345 | Comment body with @Planning note<<}
```

Metadata list values:

- `mentions` is a comma-separated list of `kind:refId:encodedLabel[:encodedIconHint]`.
- Allowed mention kinds for comments are `note`, `journal`, `inbox`, `calendar_event`, and `task`.
- Mention labels and optional icon hints are percent-encoded inside each token, then the full metadata value still uses the normal metadata escaping rules.
- `attachments` is a comma-separated list of `encodedPath:encodedName:encodedMimeType:size`.
- Attachment paths come from `notesService.uploadAttachment`; do not store absolute filesystem paths in markdown.
- The visible comment body contains readable `@Label` text. The structured `mentions` list is the durable ref map.

Supported stored forms:

```md
Addition: {++new text++}{>>id:s_1 status:open kind:addition | optional note<<}
Deletion: {--old text--}{>>id:s_2 status:open kind:deletion | optional note<<}
Substitution: {~~old text~>new text~~}{>>id:s_3 status:open kind:substitution | optional note<<}
Point comment: {>>id:c_1 status:open kind:comment | note<<}
Highlight comment: {==selected text==}{>>id:c_2 status:open kind:highlight | note<<}
```

Action behavior:

- Accept addition: replace full mark span with `new text`.
- Reject addition: remove full mark span.
- Accept deletion: remove full mark span.
- Reject deletion: replace full mark span with `old text`.
- Accept substitution: replace full mark span with `new text`.
- Reject substitution: replace full mark span with `old text`.
- Delete highlight comment: unwrap selected text and remove paired comment metadata.
- Delete point comment: remove the `{>> <<}` mark.
- Resolve comment: update metadata `status:resolved`; keep mark visible but dimmed, or hide from the default open rail filter.

## File Map

Create:

- `packages/shared/src/critic-markup/types.ts` - shared mark, metadata, action, parse result, and transform result types.
- `packages/shared/src/critic-markup/metadata.ts` - parse/serialize metadata payloads inside `{>> <<}`.
- `packages/shared/src/critic-markup/protected-ranges.ts` - detect markdown ranges where CriticMarkup-looking text is literal.
- `packages/shared/src/critic-markup/parser.ts` - parse additions, deletions, substitutions, comments, and highlight comments.
- `packages/shared/src/critic-markup/transforms.ts` - apply create/update/delete/accept/reject transforms to markdown.
- `packages/shared/src/critic-markup/diff.ts` - small common-prefix/suffix diff for suggestion display.
- `packages/shared/src/critic-markup/comment-refs.ts` - encode/decode mention refs and file attachment refs in metadata.
- `packages/shared/src/critic-markup/index.ts` - public exports.
- `packages/shared/src/critic-markup/*.test.ts` - focused parser, metadata, transform, and diff tests.
- `apps/desktop/src/renderer/src/components/mentions/mention-icons.tsx` - shared icon/color rendering extracted from Agent Chat.
- `apps/desktop/src/renderer/src/components/mentions/ref-picker.tsx` - shared search/calendar `@` picker extracted from Agent Chat.
- `apps/desktop/src/renderer/src/components/comments/comment-input.tsx` - compact rich comment input with `@` mentions, Enter submit, Shift+Enter newline, and file attach control.
- `apps/desktop/src/renderer/src/components/note/content-area/critic-markup-schema.ts` - BlockNote custom style specs and inline content specs.
- `apps/desktop/src/renderer/src/components/note/content-area/critic-markup-roundtrip.ts` - convert CriticMarkup markdown into BlockNote editor content and serialize editor content back to CriticMarkup markdown.
- `apps/desktop/src/renderer/src/components/note/content-area/review-formatting-toolbar.tsx` - custom selected-text toolbar with Comment and Suggest buttons.
- `apps/desktop/src/renderer/src/components/comments/review-rail.tsx` - right-side rail shell for open comments and suggestions.
- `apps/desktop/src/renderer/src/components/comments/comment-composer.tsx` - Enter-submit comment composer.
- `apps/desktop/src/renderer/src/components/comments/suggestion-composer.tsx` - suggested edit composer.
- `apps/desktop/src/renderer/src/components/comments/review-mark-card.tsx` - comment/suggestion card with accept/reject/resolve/delete controls.
- `apps/desktop/src/renderer/src/components/comments/review-diff.tsx` - inline old/new diff renderer for suggestions.
- `apps/desktop/src/renderer/src/components/comments/attachment-chip.tsx` - uploaded file chip/preview used in composers and cards.
- `apps/desktop/src/renderer/src/hooks/use-critic-markup-review.ts` - page-level markdown state, parsed marks, active draft, and actions.
- `apps/desktop/src/renderer/src/components/comments/review-rail.test.tsx`
- `apps/desktop/src/renderer/src/components/comments/comment-input.test.tsx`
- `apps/desktop/src/renderer/src/components/note/content-area/critic-markup-roundtrip.test.ts`
- `apps/desktop/src/renderer/src/components/note/content-area/review-formatting-toolbar.test.tsx`

Modify:

- `packages/shared/src/index.ts` - export `./critic-markup`.
- `packages/shared/package.json` - add `./critic-markup` export.
- `apps/desktop/src/renderer/src/components/note/content-area/editor-schema.ts` - register CriticMarkup inline content/style specs.
- `apps/desktop/src/renderer/src/components/note/content-area/markdown-utils.ts` - route markdown parse/serialize through CriticMarkup round-trip helpers.
- `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx` - add review props, selection capture, custom formatting toolbar, and editor action hooks.
- `apps/desktop/src/renderer/src/components/note/content-area/types.ts` - add `ReviewTarget`, `ReviewSelection`, and review callbacks.
- `apps/desktop/src/renderer/src/agent-chat/ref-picker.tsx` - move or re-export from shared `components/mentions/ref-picker.tsx` so Agent Chat and comments use one picker.
- `apps/desktop/src/renderer/src/agent-chat/mention-icons.tsx` - move or re-export from shared `components/mentions/mention-icons.tsx`.
- `apps/desktop/src/renderer/src/agent-chat/agent-prompt-editor.tsx` - update imports to shared mention icon/color helpers after extraction.
- `apps/desktop/src/renderer/src/components/note/note-layout.tsx` - keep the side rail slot from the current dummy work.
- `apps/desktop/src/renderer/src/pages/note.tsx` - remove `DummyCommentRail`; wire `useCriticMarkupReview`, `ReviewRail`, and `ContentArea` review props.
- `apps/desktop/src/renderer/src/pages/journal.tsx` - wire the same hook/rail/props for day-view journal entries.
- `apps/desktop/src/renderer/src/pages/note.test.tsx` - replace dummy rail test with real comment/suggestion rendering tests.
- `apps/desktop/src/renderer/src/pages/journal.test.tsx` - cover journal rail wiring.
- `apps/desktop/src/renderer/src/components/note-sidebar-surfaces.test.tsx` - keep layout rail coverage.
- `packages/i18n/src/locales/en/notes.json` - replace dummy comment copy with real review UI strings.
- `packages/i18n/src/locales/en/journal.json` - add journal-specific fallback labels only if needed.
- `apps/docs/src/user-guide/notes/editing.md` - document comments/suggested edits.
- `apps/docs/src/user-guide/journal/daily-entries.md` - document journal comments/suggested edits.

Avoid:

- Do not add comment IPC channels in v1.
- Do not add comment tables/migrations in v1.
- Do not reintroduce deleted `2026-05-23` plan/spec files unless explicitly requested.
- Do not implement multiple reviewers or threaded replies in this pass.

## Chunk 1: Pure CriticMarkup Core

### Task 1: Metadata Helpers

**Files:**

- Create: `packages/shared/src/critic-markup/types.ts`
- Create: `packages/shared/src/critic-markup/metadata.ts`
- Create: `packages/shared/src/critic-markup/comment-refs.ts`
- Create: `packages/shared/src/critic-markup/metadata.test.ts`
- Create: `packages/shared/src/critic-markup/comment-refs.test.ts`
- Create: `packages/shared/src/critic-markup/index.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/package.json`

- [ ] **Step 1: Write failing metadata tests**

Cover:

- Plain comments with no metadata.
- `id`, `status`, `kind`, `created`, `modified`.
- Unknown key preservation.
- Escaped `\`, `|`, `,`, `\n`, and `<<}`.
- Invalid `status` and invalid `kind` return warnings while preserving body.
- Mention refs encode/decode `note`, `journal`, `inbox`, `calendar_event`, and `task`.
- Attachment refs encode/decode uploaded `path`, `name`, `mimeType`, and `size`.

Minimum test fixture:

```ts
expect(parseCriticMetadata('id:c_1 status:open kind:highlight | Needs work')).toMatchObject({
  metadata: { id: 'c_1', status: 'open', kind: 'highlight' },
  body: 'Needs work'
})

expect(serializeCriticMetadata({ id: 'c_1', status: 'open', kind: 'comment' }, 'A | B')).toBe(
  'id:c_1 status:open kind:comment | A \\| B'
)

expect(parseCriticMetadata('plain note')).toMatchObject({
  metadata: null,
  body: 'plain note'
})

expect(encodeCriticMentionRefs([{ kind: 'note', refId: 'n_1', label: 'Planning note' }])).toBe(
  'note:n_1:Planning%20note'
)

expect(
  encodeCriticAttachmentRefs([
    { path: 'attachments/a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 12345 }
  ])
).toBe('attachments%2Fa.pdf:a.pdf:application%2Fpdf:12345')
```

- [ ] **Step 2: Run failing test**

Run:

```bash
pnpm --filter @memry/desktop test:shared -- metadata.test.ts comment-refs.test.ts
```

Expected: FAIL because helpers do not exist.

- [ ] **Step 3: Implement minimal metadata helpers**

Implement:

```ts
export function parseCriticMetadata(payload: string): ParsedCriticMetadata
export function serializeCriticMetadata(metadata: CriticMarkupMetadata, body: string): string
export function escapeCriticMetadataValue(value: string): string
export function unescapeCriticMetadataValue(value: string): string
export function encodeCriticMentionRefs(refs: CriticMentionRef[]): string
export function decodeCriticMentionRefs(value: string): CriticMentionRef[]
export function encodeCriticAttachmentRefs(refs: CriticAttachmentRef[]): string
export function decodeCriticAttachmentRefs(value: string): CriticAttachmentRef[]
```

- [ ] **Step 4: Run passing test**

Run:

```bash
pnpm --filter @memry/desktop test:shared -- metadata.test.ts comment-refs.test.ts
```

Expected: PASS.

### Task 2: Parser and Protected Ranges

**Files:**

- Create: `packages/shared/src/critic-markup/protected-ranges.ts`
- Create: `packages/shared/src/critic-markup/protected-ranges.test.ts`
- Create: `packages/shared/src/critic-markup/parser.ts`
- Create: `packages/shared/src/critic-markup/parser.test.ts`
- Modify: `packages/shared/src/critic-markup/index.ts`

- [ ] **Step 1: Write failing protected-range tests**

Cover YAML frontmatter, fenced code, indented code, inline code, HTML comments, and raw HTML blocks. CriticMarkup-looking text inside those ranges must stay literal.

- [ ] **Step 2: Write failing parser tests**

Use README fixtures plus Memry metadata:

```md
Lorem ipsum dolor{++ sit++} amet...
Lorem{-- ipsum--} dolor sit amet...
Lorem {~~hipsum~>ipsum~~} dolor sit amet...
Lorem ipsum dolor sit amet.{>>This is a comment<<}
Lorem {==Truth is stranger than fiction==}{>>true<<}.
Text {~~application~>applications~~}{>>id:s_1 status:open kind:substitution | pluralize<<}
Text {==review this==}{>>id:c_2 status:open kind:highlight mentions:note:n_1:Planning%20note attachments:attachments%2Fa.pdf:a.pdf:application%2Fpdf:12345 | See @Planning note<<}
```

Assert mark kind, text fields, paired comment, metadata, decoded mentions, decoded attachments, deterministic fallback IDs, and exact source ranges.

- [ ] **Step 3: Run failing parser tests**

Run:

```bash
pnpm --filter @memry/desktop test:shared -- protected-ranges.test.ts parser.test.ts
```

Expected: FAIL because parser modules do not exist.

- [ ] **Step 4: Implement parser**

Rules:

- Scan left to right.
- Skip protected ranges.
- Do not parse nested marks in v1.
- Pair highlight plus immediately-adjacent comment.
- Pair addition/deletion/substitution plus immediately-adjacent metadata comment when `kind` matches or is absent.
- Treat conflicting following comment kind as a separate point comment.
- Plain marks get deterministic IDs from target type, target id, kind, source range, and text hash.

- [ ] **Step 5: Run parser tests**

Run:

```bash
pnpm --filter @memry/desktop test:shared -- protected-ranges.test.ts parser.test.ts
```

Expected: PASS.

### Task 3: Markdown Actions

**Files:**

- Create: `packages/shared/src/critic-markup/transforms.ts`
- Create: `packages/shared/src/critic-markup/transforms.test.ts`
- Create: `packages/shared/src/critic-markup/diff.ts`
- Create: `packages/shared/src/critic-markup/diff.test.ts`
- Modify: `packages/shared/src/critic-markup/index.ts`

- [ ] **Step 1: Write failing action tests**

Cover:

- Create highlight comment around selected text.
- Create point comment at cursor.
- Create comment with two typed mentions and one uploaded attachment.
- Create addition at cursor.
- Create deletion from selection.
- Create substitution from selection and replacement.
- Update comment body while preserving existing mentions/attachments unless explicitly changed.
- Accept/reject addition.
- Accept/reject deletion.
- Accept/reject substitution.
- Delete highlight comment unwraps selected text.
- Duplicate IDs return `ambiguous-mark`.
- Missing IDs return `mark-not-found`.

- [ ] **Step 2: Add diff tests**

Fixtures:

```ts
expect(diffSuggestionText('application', 'applications')).toEqual([
  { kind: 'equal', text: 'application' },
  { kind: 'insert', text: 's' }
])

expect(diffSuggestionText('colour', 'color')).toEqual([
  { kind: 'equal', text: 'colo' },
  { kind: 'delete', text: 'u' },
  { kind: 'equal', text: 'r' }
])
```

- [ ] **Step 3: Run failing action tests**

Run:

```bash
pnpm --filter @memry/desktop test:shared -- transforms.test.ts diff.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement transforms**

Implement current-markdown-first transforms:

```ts
export function applyCriticMarkupAction(
  markdown: string,
  action: CriticMarkupAction
): CriticMarkupTransformResult
```

Every transform reparses the current markdown. Offsets from UI are hints, not authority.

- [ ] **Step 5: Run action tests**

Run:

```bash
pnpm --filter @memry/desktop test:shared -- transforms.test.ts diff.test.ts
```

Expected: PASS.

## Chunk 2: BlockNote Hidden Syntax Round Trip

### Task 4: Register CriticMarkup Editor Schema

**Files:**

- Create: `apps/desktop/src/renderer/src/components/note/content-area/critic-markup-schema.ts`
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/editor-schema.ts`
- Test: `apps/desktop/src/renderer/src/components/note/content-area/critic-markup-roundtrip.test.ts`

- [ ] **Step 1: Write failing schema test**

Assert BlockNote can hold:

- `criticHighlight` style on selected text.
- `criticAddition` style on inserted text.
- `criticCommentAnchor` inline content with no visible syntax.
- `criticDeletion` inline content with old text props.
- `criticSubstitution` inline content with old/new text props.

- [ ] **Step 2: Implement schema specs**

Use:

- `createStyleSpec` for editable styled text:
  - `criticHighlight`: yellow highlight/comment underline.
  - `criticAddition`: green inserted text styling.
- `createInlineContentSpec` for non-editable inline chips:
  - `criticCommentAnchor`: small comment marker.
  - `criticDeletion`: red strikethrough text.
  - `criticSubstitution`: old/new pair rendered through `diffSuggestionText`.

Keep visual class names stable with `data-critic-mark-id` for tests and rail focus.

- [ ] **Step 3: Run schema test**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- critic-markup-roundtrip.test.ts
```

Expected: PASS for schema registration, even before full round trip.

### Task 5: Parse Stored CriticMarkup Into Editor Content

**Files:**

- Create: `apps/desktop/src/renderer/src/components/note/content-area/critic-markup-roundtrip.ts`
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/markdown-utils.ts`
- Test: `apps/desktop/src/renderer/src/components/note/content-area/critic-markup-roundtrip.test.ts`

- [ ] **Step 1: Write failing load tests**

Fixtures:

```md
Hello {==application==}{>>id:c_1 status:open kind:highlight | comment<<}
Use {~~application~>applications~~}{>>id:s_1 status:open kind:substitution | pluralize<<}
Remove {--legacy--}{>>id:s_2 status:open kind:deletion | stale<<}
Add {++new++}{>>id:s_3 status:open kind:addition | needed<<}
```

Assert rendered/editor content contains no raw `{==`, `{>>`, `{~~`, `{--`, or `{++` text nodes.

- [ ] **Step 2: Implement markdown load adapter**

Approach:

- Parse raw markdown with `parseCriticMarkup`.
- Convert marks into temporary HTML spans/nodes with `data-critic-*` attributes, or sentinel text that is replaced immediately after BlockNote parsing.
- Keep normal markdown parsing behavior for existing wiki links, hash tags, callouts, file blocks, YouTube embeds, task blocks, and blank-line preservation.
- Prefer the smallest adapter inside `parseMarkdownPreservingBlanks`; do not rewrite the whole markdown pipeline.

- [ ] **Step 3: Run load tests**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- critic-markup-roundtrip.test.ts
```

Expected: PASS for load/hide behavior.

### Task 6: Serialize Editor Content Back to CriticMarkup

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/note/content-area/critic-markup-roundtrip.ts`
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/markdown-utils.ts`
- Test: `apps/desktop/src/renderer/src/components/note/content-area/critic-markup-roundtrip.test.ts`

- [ ] **Step 1: Write failing save tests**

Assert markdown round trips back to the original CriticMarkup forms and metadata survives edits:

```ts
expect(savedMarkdown).toContain('{==application==}{>>id:c_1')
expect(savedMarkdown).toContain('{~~application~>applications~~}{>>id:s_1')
expect(savedMarkdown).toContain('mentions:note:n_1:Planning%20note')
expect(savedMarkdown).toContain('attachments:attachments%2Fa.pdf:a.pdf:application%2Fpdf:12345')
expect(savedMarkdown).not.toContain('data-critic-mark-id')
```

- [ ] **Step 2: Implement serializer adapter**

Rules:

- If a block group has no CriticMarkup custom nodes/styles, keep existing `blocksToMarkdownLossy` path.
- If a block group has CriticMarkup custom nodes/styles, serialize that group with a focused inline walker that emits CriticMarkup for those nodes and delegates normal text/link formatting to existing BlockNote output where possible.
- Preserve blank lines through `assembleMarkdownWithBlanks`.
- Keep tests around bold/italic text next to review marks so formatting does not regress.

- [ ] **Step 3: Run round-trip tests**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- critic-markup-roundtrip.test.ts markdown-utils.test.ts
```

Expected: PASS.

## Chunk 3: Toolbar and Rail UX

### Task 7: Add Review Props and Selection Capture to ContentArea

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/note/content-area/types.ts`
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx`
- Test: `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.test.tsx`

- [ ] **Step 1: Write failing ContentArea tests**

Assert:

- Selection changes expose selected text and single-block eligibility.
- Review actions are disabled with no selection where required.
- Raw syntax is not visible when initial markdown contains CriticMarkup.

- [ ] **Step 2: Implement review props**

Add:

```ts
export type ReviewTargetType = 'note' | 'journal'

export interface ReviewTarget {
  type: ReviewTargetType
  id: string
}

export interface ReviewSelection {
  text: string
  isCollapsed: boolean
  isSingleBlock: boolean
  blockId?: string
  boundingBox?: DOMRect
}
```

Add callbacks:

```ts
onStartComment?: (selection: ReviewSelection) => void
onStartSuggestion?: (selection: ReviewSelection) => void
```

- [ ] **Step 3: Run tests**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- ContentArea.test.tsx
```

Expected: PASS.

### Task 8: Custom Formatting Toolbar Buttons

**Files:**

- Create: `apps/desktop/src/renderer/src/components/note/content-area/review-formatting-toolbar.tsx`
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx`
- Test: `apps/desktop/src/renderer/src/components/note/content-area/review-formatting-toolbar.test.tsx`
- Modify: `packages/i18n/src/locales/en/notes.json`

- [ ] **Step 1: Write failing toolbar tests**

Assert:

- The selected-text toolbar includes Comment and Suggest next to existing formatting controls.
- `Comment` calls `onStartComment`.
- `Suggest` calls `onStartSuggestion`.
- Buttons are disabled for unsupported multi-block selections.

- [ ] **Step 2: Implement custom toolbar**

Use BlockNote's custom toolbar path:

- Import `FormattingToolbarController`, `FormattingToolbar`, `getFormattingToolbarItems`, and `useComponentsContext`.
- Set `BlockNoteView` default `formattingToolbar={false}` when review toolbar is enabled.
- Render default items plus review buttons.
- Keep sticky toolbar behavior intact.
- Use existing icon library for buttons; prefer `CommentAdd01Icon` if already available in `@/lib/icons`, otherwise use the closest existing comment icon.

- [ ] **Step 3: Run toolbar tests**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- review-formatting-toolbar.test.tsx ContentArea.test.tsx
pnpm --filter @memry/desktop i18n:check
```

Expected: PASS.

### Task 9: Shared Review Rail

**Files:**

- Create: `apps/desktop/src/renderer/src/components/mentions/mention-icons.tsx`
- Create: `apps/desktop/src/renderer/src/components/mentions/ref-picker.tsx`
- Create: `apps/desktop/src/renderer/src/components/comments/review-rail.tsx`
- Create: `apps/desktop/src/renderer/src/components/comments/comment-input.tsx`
- Create: `apps/desktop/src/renderer/src/components/comments/comment-composer.tsx`
- Create: `apps/desktop/src/renderer/src/components/comments/suggestion-composer.tsx`
- Create: `apps/desktop/src/renderer/src/components/comments/review-mark-card.tsx`
- Create: `apps/desktop/src/renderer/src/components/comments/review-diff.tsx`
- Create: `apps/desktop/src/renderer/src/components/comments/attachment-chip.tsx`
- Create: `apps/desktop/src/renderer/src/components/comments/review-rail.test.tsx`
- Create: `apps/desktop/src/renderer/src/components/comments/comment-input.test.tsx`
- Modify: `apps/desktop/src/renderer/src/agent-chat/ref-picker.tsx`
- Modify: `apps/desktop/src/renderer/src/agent-chat/mention-icons.tsx`
- Modify: `apps/desktop/src/renderer/src/agent-chat/agent-prompt-editor.tsx`
- Modify: `packages/i18n/src/locales/en/notes.json`

- [ ] **Step 1: Write failing rail tests**

Assert:

- Comment draft opens when `Comment` is clicked.
- Suggestion draft opens when `Suggest` is clicked.
- Enter submits.
- Shift+Enter inserts newline.
- Typing `@` opens a picker populated from notes, journal, inbox, calendar events, and tasks.
- Picked mentions render as icon/color chips matching Agent Chat.
- Picked mentions persist structured refs in CriticMarkup metadata and readable `@Label` text in the body.
- Clicking attach uploads through `notesService.uploadAttachment(target.id, file)`.
- Uploaded attachments render as chips/previews in the composer and final card.
- Uploaded attachments persist path/name/mime/size in CriticMarkup metadata.
- Existing open comments/suggestions render in order.
- Suggestion cards show Accept and Decline.
- `application` -> `applications` renders only `s` as inserted.

- [ ] **Step 2: Implement rail components**

UI contract:

- Rail is right side of editor content, not global app sidebar.
- No redundant "You" section for single-user mode.
- Comment composer is compact and focused, with the same `@` mention behavior as Agent Chat prompt input.
- Suggestion composer shows selected text and replacement input.
- Mention chips use shared `MentionIcon` and `mentionColorForKind` so note/journal/inbox/calendar/task visuals match Agent Chat.
- The shared ref picker queries `window.api.search.query({ text, limit: 20 })` and `window.api.calendar.listEvents({ includeArchived: false })`, matching Agent Chat behavior.
- File attachments use an icon chip by default and an image thumbnail only when the uploaded mime type is image.
- Accept/Decline buttons use icons plus accessible labels.
- Hover/focus state should align the card with the corresponding editor mark.

- [ ] **Step 3: Extract mention primitives without breaking Agent Chat**

Move or re-export:

- `apps/desktop/src/renderer/src/agent-chat/mention-icons.tsx` -> `apps/desktop/src/renderer/src/components/mentions/mention-icons.tsx`
- `apps/desktop/src/renderer/src/agent-chat/ref-picker.tsx` -> `apps/desktop/src/renderer/src/components/mentions/ref-picker.tsx`

Then update Agent Chat imports and keep existing Agent Chat tests green.

- [ ] **Step 4: Run rail tests**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- comment-input.test.tsx review-rail.test.tsx agent-prompt-editor.test.tsx ref-picker.test.tsx mention-icons.test.tsx
pnpm --filter @memry/desktop i18n:check
```

Expected: PASS.

## Chunk 4: Note and Journal Wiring

### Task 10: Hook for Markdown Review State

**Files:**

- Create: `apps/desktop/src/renderer/src/hooks/use-critic-markup-review.ts`
- Create: `apps/desktop/src/renderer/src/hooks/use-critic-markup-review.test.tsx`

- [ ] **Step 1: Write failing hook tests**

Assert:

- Parses marks from current markdown.
- Opens comment draft from a selection.
- Opens suggestion draft from a selection.
- Submit comment applies CriticMarkup transform and calls save callback.
- Submit comment carries `mentions` and `attachments` into metadata.
- Submit suggestion applies CriticMarkup transform and calls save callback.
- Submit suggestion can include an optional rationale body with mentions/attachments.
- Accept/reject applies transforms and refreshes parsed marks.
- Stale current markdown is reparsed before action.

- [ ] **Step 2: Implement hook**

Signature:

```ts
export function useCriticMarkupReview(input: {
  target: ReviewTarget | null
  markdown: string
  saveMarkdown: (markdown: string) => Promise<void> | void
  uploadAttachment?: (targetId: string, file: File) => Promise<CriticAttachmentRef>
})
```

Return:

```ts
{
  ;(marks,
    activeDraft,
    contentAreaProps,
    railProps,
    submitComment,
    submitSuggestion,
    uploadCommentAttachment,
    acceptSuggestion,
    declineSuggestion,
    resolveComment,
    deleteMark)
}
```

- [ ] **Step 3: Run hook tests**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- use-critic-markup-review.test.tsx
```

Expected: PASS.

### Task 11: Replace Dummy Note Rail

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/note.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/note.test.tsx`
- Modify: `packages/i18n/src/locales/en/notes.json`

- [ ] **Step 1: Write failing note page tests**

Replace the dummy rail assertion with:

- No `DummyCommentRail`.
- `ReviewRail` appears only when marks or an active draft exist.
- Add comment on selected text saves highlight comment CriticMarkup.
- Add comment with `@Planning note` saves `mentions:note:...` metadata and shows the note icon/color chip.
- Add comment with an uploaded file calls `notesService.uploadAttachment(noteId, file)` and saves attachment metadata.
- Suggest substitution saves substitution CriticMarkup.
- Accept/decline updates note content through `updateNote`.

- [ ] **Step 2: Wire note page**

Use current note markdown as hook input. Save actions should reuse the existing note update path and update local `lastSavedContent`/pending refs consistently so autosave does not overwrite the action.

- [ ] **Step 3: Run note tests**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- note.test.tsx ContentArea.test.tsx review-rail.test.tsx
```

Expected: PASS.

### Task 12: Add Journal Rail

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/journal.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/journal.test.tsx`
- Modify: `packages/i18n/src/locales/en/journal.json` only if journal-specific strings are needed.

- [ ] **Step 1: Write failing journal page tests**

Assert:

- Day-view journal entry passes `target: { type: 'journal', id: entry.id }`.
- Comment submission calls journal `updateContent` with highlight comment CriticMarkup.
- Comment attachment upload calls `notesService.uploadAttachment(entry.id, file)` and stores the returned relative attachment path.
- Comment mention picker supports journal/task/note/inbox/calendar refs the same way as notes.
- Suggestion accept/reject calls journal update path.
- Month/year views do not render review rail.

- [ ] **Step 2: Wire journal page**

Reuse `ReviewRail` and `ContentArea` props from the same hook. Keep journal full-width and existing right-side day context surfaces intact.

- [ ] **Step 3: Run journal tests**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- journal.test.tsx use-critic-markup-review.test.tsx
```

Expected: PASS.

## Chunk 5: Visual QA, Docs, and Gates

### Task 13: Focused E2E Coverage

**Files:**

- Create or modify: `apps/desktop/e2e/comments-criticmarkup.e2e.ts`

- [ ] **Step 1: Write E2E for note comment**

Flow:

1. Seed a note with `The application is ready`.
2. Select `application`.
3. Click toolbar Comment.
4. Type comment.
5. Press Enter.
6. Assert editor shows highlighted `application`, rail shows comment, raw syntax is not visible.
7. Assert persisted markdown contains `{==application==}{>>`.

- [ ] **Step 2: Write E2E for mention and attachment**

Flow:

1. Seed a note and at least one task/journal/inbox/calendar fixture.
2. Select text and click toolbar Comment.
3. Type `@` and pick a note or task from the picker.
4. Attach a small fixture file.
5. Press Enter.
6. Assert the card shows the icon/color mention chip and attachment chip.
7. Assert persisted markdown contains `mentions:` and `attachments:` metadata, while the editor surface still hides CriticMarkup syntax.

- [ ] **Step 3: Write E2E for suggestion**

Flow:

1. Seed a note with `The application is ready`.
2. Select `application`.
3. Click toolbar Suggest.
4. Change replacement to `applications`.
5. Submit.
6. Assert only `s` is visually inserted.
7. Click Accept.
8. Assert editor and persisted markdown contain `applications` with no CriticMarkup mark.

- [ ] **Step 4: Add journal smoke E2E or renderer equivalent**

Use runtime-local current date, not a hard-coded day.

- [ ] **Step 5: Run focused E2E**

Run:

```bash
pnpm --filter @memry/desktop test:e2e -- comments-criticmarkup.e2e.ts
```

Expected: PASS.

### Task 14: Docs

**Files:**

- Modify: `apps/docs/src/user-guide/notes/editing.md`
- Modify: `apps/docs/src/user-guide/journal/daily-entries.md`

- [ ] **Step 1: Add smallest real docs note**

Document:

- Select text -> Comment.
- Select text -> Suggest.
- Suggestions can be accepted/declined.
- Comments can mention notes, journal entries, inbox items, calendar events, and tasks with `@`.
- Comments can include uploaded file attachments.
- Markdown stores CriticMarkup for portability.
- Editor hides the raw syntax in normal editing.

- [ ] **Step 2: Run docs gate**

Run:

```bash
pnpm docs:impact --base origin/main --strict
pnpm docs:build
```

Expected: PASS.

### Task 15: Final Verification

- [ ] **Step 1: Run focused tests**

```bash
pnpm --filter @memry/desktop test:shared -- critic-markup
pnpm --filter @memry/desktop test:renderer -- critic-markup review-formatting-toolbar comment-input review-rail use-critic-markup-review note.test.tsx journal.test.tsx agent-prompt-editor.test.tsx ref-picker.test.tsx mention-icons.test.tsx
pnpm --filter @memry/desktop i18n:check
```

- [ ] **Step 2: Run contract and architecture checks**

Even though no IPC is expected, run these because editor/page changes can touch boundary-sensitive imports:

```bash
pnpm check:contracts
pnpm check:architecture
```

- [ ] **Step 3: Run typechecks**

```bash
pnpm --filter @memry/desktop typecheck:web
pnpm --filter @memry/desktop typecheck:node
pnpm typecheck:packages
```

- [ ] **Step 4: Run diff hygiene**

```bash
git diff --check
```

Expected: PASS.

## Implementation Notes

- Keep comment/suggestion state local to renderer in v1. The source of truth is note/journal markdown.
- Do not let `onMarkdownChange` strip CriticMarkup. The strongest invariant is: load CriticMarkup -> editor hides syntax -> save -> CriticMarkup still exists.
- Do not apply actions from cached offsets alone. Reparse current markdown before every accept/reject/delete/update.
- Keep generated metadata on one logical line. Persist multiline composer text as escaped `\n`.
- Keep mention/attachment metadata durable enough to render without live lookup; live lookup can refresh labels/icons later, but saved markdown must still carry label/path/name/mime/size.
- Reuse Agent Chat mention visuals and ref lookup behavior rather than creating a second visual language for comments.
- Preserve current user dirty changes. The current dummy layout work should be evolved, not reverted.
- If BlockNote's default markdown serializer cannot preserve custom style specs cleanly, use a focused inline serializer only for blocks containing CriticMarkup nodes/styles.

# CriticMarkup Comments and Review Marks - Design Spec

**Date:** 2026-05-23
**Status:** Draft for implementation planning
**Owner:** Kaan Karaca
**Scope:** Notes and journal markdown, inline comments, review/change-tracking marks, comment rail, SQLite search/cache projection, sync behavior, docs.

## Summary

Move note and journal comments from SQL-owned sidecar records to CriticMarkup-owned markdown. The saved markdown is the durable source of truth and always contains the review annotations. SQLite remains useful, but only as a derived search/cache projection rebuilt from note and journal content.

The app is not released yet, so this is a hard cutover. We do not preserve the old SQL-owned comments architecture, do not keep compatibility shims, and do not design for existing user data. If local dev data matters, it can be manually reset or handled by a one-off helper outside the product path.

CriticMarkup syntax support covers all five marks from the toolkit README:

```md
Addition: {++new text++}
Deletion: {--old text--}
Substitution: {~~old text~>new text~~}
Comment: {>>metadata and comment body<<}
Highlight with comment: {==selected text==}{>>metadata and comment body<<}
```

Additions, deletions, and substitutions are actionable review marks with accept/reject controls. Comments and highlights stay visible in markdown and render in the editor/rail with richer UI.

## Goals

- Persist every comment and review mark directly in note/journal markdown.
- Support CriticMarkup additions, deletions, substitutions, comments, and highlight comments.
- Keep Memry metadata in markdown so SQLite is never required to preserve comments.
- Keep SQLite for search, fast comment/review rail loading, and derived indexes.
- Provide accept/reject controls for addition/deletion/substitution marks.
- Preserve the existing note and journal comment affordances, but make them edit markdown instead of SQL.
- Remove the old sidecar-comment source of truth and independent comment sync path.
- Prefer simple, hard-cutover implementation because the app is pre-release.

## Non-Goals

- Backward-compatible support for old SQL-owned comments.
- A production migration for released users.
- Supporting arbitrary nested CriticMarkup marks inside other CriticMarkup marks in v1.
- Full collaborative review workflow with reviewers, assignments, or threaded replies.
- Export-only CriticMarkup. The canonical saved markdown itself contains CriticMarkup.
- Keeping markdown visually clean by hiding all annotation syntax from the storage layer.

## Decisions Log

| #   | Decision                                               | Rationale                                                                                   |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 1   | CriticMarkup is canonical in markdown                  | Users can see comments and review marks in plain markdown without Memry.                    |
| 2   | SQLite is a projection/cache only                      | Search and fast UI are useful, but SQL must not own durable comments.                       |
| 3   | Hard cutover, no compatibility path                    | App is unreleased; simpler design and fewer long-term branches.                             |
| 4   | Metadata is embedded inside `{>> <<}`                  | Stable IDs, status, attachments, mentions, and timestamps survive outside SQLite.           |
| 5   | Add/delete/substitute marks get accept/reject controls | Change tracking is not useful if users cannot apply or discard proposed edits.              |
| 6   | Note/journal body sync owns marks                      | Inline marks should merge with the text they annotate; separate comment sync creates drift. |

## CriticMarkup Semantics

The parser and serializer must follow the public CriticMarkup forms from the toolkit README.

### Addition

```md
Lorem ipsum dolor{++ sit++} amet...
Lorem ipsum dolor{++ sit++}{>>id:r_123 status:open kind:addition created:2026-05-23T12:00:00.000Z modified:2026-05-23T12:00:00.000Z | Add missing word<<} amet...
```

- Render as inserted/proposed text.
- Accept: replace `{++ sit++}` with ` sit`.
- Reject: remove the entire mark.

### Deletion

```md
Lorem{-- ipsum--} dolor sit amet...
Lorem{-- ipsum--}{>>id:r_124 status:open kind:deletion created:2026-05-23T12:00:00.000Z modified:2026-05-23T12:00:00.000Z | Remove filler word<<} dolor sit amet...
```

- Render as deleted/proposed-removal text.
- Accept: remove the entire mark and deleted text.
- Reject: replace `{-- ipsum--}` with ` ipsum`.

### Substitution

```md
Lorem {~~hipsum~>ipsum~~} dolor sit amet...
Lorem {~~hipsum~>ipsum~~}{>>id:r_125 status:open kind:substitution created:2026-05-23T12:00:00.000Z modified:2026-05-23T12:00:00.000Z | Correct spelling<<} dolor sit amet...
```

- Render as old text replaced by new text.
- Accept: replace the mark with `ipsum`.
- Reject: replace the mark with `hipsum`.

Metadata pairing rules for review marks:

- A `{>> <<}` comment immediately following an addition, deletion, or substitution with only optional whitespace between them belongs to that review mark when `kind` matches the review mark kind or `kind` is absent.
- Accept/reject of a metadata-backed review mark removes both the review mark and its paired metadata comment.
- A following `{>> <<}` with a conflicting `kind` is a separate point comment, not review-mark metadata.
- Plain review marks without paired metadata remain valid and actionable using deterministic IDs from the fresh parse, but they cannot preserve status, attachments, mentions, or timestamps.
- Memry-created review marks always serialize paired metadata comments so accept/reject actions have stable IDs.

### Comment

```md
Lorem ipsum dolor sit amet.{>>id:c_123 status:open created:2026-05-23T12:00:00.000Z modified:2026-05-23T12:00:00.000Z | This is a comment<<}
```

- Render as an inline comment anchor at the insertion point.
- Show the body in the rail/panel.
- Updating the comment edits the `{>> <<}` payload in markdown.
- Deleting the comment removes the `{>> <<}` mark.

### Highlight With Comment

```md
Lorem ipsum dolor sit amet, {==consectetur adipiscing elit==}{>>id:c_456 status:open created:2026-05-23T12:00:00.000Z modified:2026-05-23T12:00:00.000Z | Needs clarification<<} sed do eiusmod.
```

- Render the highlighted range and comment rail card.
- Updating the comment edits the metadata/comment payload.
- Deleting the comment unwraps to `consectetur adipiscing elit` and removes the comment metadata.

## Embedded Metadata Format

Generated Memry marks use one metadata payload inside `{>> <<}`. The first `|` separates machine-readable metadata from the human-readable comment body.

```md
{==Text==}{>>id:c_123 status:open kind:highlight created:2026-05-23T12:00:00.000Z modified:2026-05-23T12:00:00.000Z attachments:a1,a2 mentions:task:t1,note:n2 | Needs clarification.<<}
```

Rules:

- `id` is stable and generated by Memry for any Memry-created mark.
- `status` is `open`, `resolved`, or `archived`.
- `kind` is `addition`, `deletion`, `substitution`, `comment`, or `highlight`.
- `created` and `modified` are ISO timestamps.
- `attachments` is a comma-separated list of attachment refs, omitted when empty.
- `mentions` is a comma-separated list of `kind:id` refs, omitted when empty.
- The body after `|` is the readable comment text.
- Generated comments should stay on one logical line when practical because the CriticMarkup README warns that newlines inside marks can break processors or invalid HTML output.
- If the UI supports multiline comment bodies, persist line breaks as escaped `\n` inside the body and render them as newlines in the rail.
- The parser accepts plain CriticMarkup without metadata. Plain marks get deterministic cache IDs based on target id, kind, markdown offsets, and text hash, but Memry-created/edited marks should be serialized with metadata.

Metadata is intentionally readable instead of JSON. It keeps the markdown approachable and simple to parse, matching CriticMarkup's human-readable goal.

### Metadata Grammar

The generated payload grammar is deliberately small:

```text
comment-payload = metadata-segment " | " body
metadata-segment = field *(SP field)
field = key ":" value
key = ALPHA *(ALPHA / DIGIT / "_" / "-")
value = escaped-char *(escaped-char)
body = escaped-char *(escaped-char)
```

Reserved characters inside values and bodies are escaped with backslash:

| Raw value                    | Serialized |
| ---------------------------- | ---------- | ---- |
| `\`                          | `\\`       |
| newline                      | `\n`       |
| `                            | `          | `\|` |
| `,` inside comma-list values | `\,`       |
| `<<}`                        | `\<<}`     |

Parsing rules:

- The end of a comment is the first unescaped `<<}` sequence. A terminator preceded by an odd number of backslashes is part of the body.
- The metadata/body separator is the first unescaped `|` sequence inside the comment payload.
- Metadata is valid only when every token before the separator is a valid `key:value` field. If not, treat the entire payload as a plain CriticMarkup comment body with no metadata.
- Unknown metadata keys are preserved when rewriting the same mark.
- Invalid known values, such as `status:banana`, leave the mark visible and actionable where possible, but the cache row records `status` as null and exposes a parse warning for diagnostics.
- Serializer always emits valid metadata for Memry-created or Memry-edited marks.

### Markdown Protected Ranges

CriticMarkup is parsed only in prose ranges, not inside Markdown regions where the same characters are literal examples or syntax.

Protected ranges in v1:

- YAML frontmatter at the start of the document: `---` through the closing `---`.
- Fenced code blocks using backticks or tildes.
- Indented code blocks.
- Inline code spans delimited by backticks.
- Raw HTML blocks and HTML comments.

Any CriticMarkup-looking text inside a protected range remains literal markdown and does not create cache rows or action controls. This prevents code examples like `{--old--}` from becoming real review marks. If a user wants a real review mark near code, they can place it in prose before or after the protected range.

## Architecture

```text
Markdown content (canonical)
  -> CriticMarkup parser
      -> BlockNote editor decorations / custom inline nodes
      -> SQLite critic mark cache
      -> Search index

Editor actions
  -> markdown transform
      -> note/journal save
      -> cache rebuild
      -> rail refresh
```

### Canonical Layer

The note/journal markdown stores all CriticMarkup. The markdown content field is the only durable representation of comments and review marks.

### Parser/Serializer Layer

Add a CriticMarkup parser/serializer module with clear boundaries:

- Parse markdown into a list of marks with kind, id, offsets, text payloads, metadata, and body.
- Convert marks into editor render data.
- Apply accept/reject/delete/update transforms to markdown.
- Serialize Memry-created marks back to valid CriticMarkup.
- Reject or preserve malformed marks safely without deleting user text.

Action transforms use this boundary:

```ts
applyCriticMarkupAction(markdown, action):
  | { ok: true; markdown: string }
  | { ok: false; error: 'mark-not-found' | 'ambiguous-mark' | 'stale-cache' | 'invalid-mark' }
```

Rules:

- Every transform reparses the current markdown first. SQLite offsets are hints, never authority.
- Metadata `id` is the primary locator. Plain marks use deterministic IDs from the fresh parse only.
- If a requested ID is absent, return `mark-not-found` and refresh UI from markdown.
- If more than one current mark has the same ID, return `ambiguous-mark`; do not edit markdown.
- If the cache content hash differs from current markdown, ignore cache offsets, reparse, and continue from the fresh parse. Return `stale-cache` only when the caller supplied an expected hash and requested strict matching.
- If the current mark kind does not match the requested action, return `invalid-mark`.
- Accept/reject/update/delete transforms replace the full current source span of the mark, including the adjacent metadata comment when that metadata belongs to the mark.

The parser should be independent from React, BlockNote, IPC, and SQLite so it can have focused unit tests.

### Editor Layer

BlockNote should not treat CriticMarkup markers as ordinary visible prose in normal editing mode. It should render marks as styled inline review elements while preserving canonical markdown on save.

Implementation can use custom inline nodes/decorations, but the boundary is:

- Load markdown with CriticMarkup.
- Parse marks before or during markdown-to-block conversion.
- Render additions, deletions, substitutions, comment anchors, and highlights.
- Keep enough mapping back to markdown offsets or inline mark IDs so actions can transform the source markdown correctly.
- Serialize back to markdown with CriticMarkup intact.

If BlockNote cannot preserve a mark shape through arbitrary inline edits, prefer a small CriticMarkup-aware source buffer and targeted markdown transforms over trying to infer marks from rendered text after the fact.

### Rail and Toolbar Layer

The existing comment rail concept remains, but its input comes from parsed markdown/cache, not SQL-owned comments.

- Highlight/comment marks appear in the rail.
- Addition/deletion/substitution marks expose accept/reject controls near the mark and can also appear in a review rail/filter.
- Existing selection comment flow wraps the selected markdown range as `{==selection==}{>>metadata | body<<}`.
- Block-level comments wrap the block text only when the block serializes to a single plain paragraph with no children and no custom block syntax. Otherwise they insert a point comment at the end of the block: `block text{>>metadata | body<<}`.

Whole-block wrapping is unsafe when it would cross block boundaries, include child blocks, split Markdown delimiters, wrap attachments/media/custom blocks, or wrap generated task/callout/code syntax. In those cases, prefer a separate point-comment paragraph immediately after the block:

```md
Original unsafe block markdown

{>>id:c_789 status:open kind:comment block:b_123 created:2026-05-23T12:00:00.000Z modified:2026-05-23T12:00:00.000Z | Comment about the block<<}
```

If inserting that paragraph would change Markdown structure, such as inside a nested list where an adjacent paragraph would alter list membership, disable the block-comment affordance for that block in v1.

Multi-block selections are not generated by v1 UI. If a user-authored multi-block CriticMarkup mark exists, the parser may render it, but editor actions should avoid rewriting it unless the parser can identify one contiguous source span safely.

### SQLite Projection Layer

Replace or hard-change the current `comments` table into a projection that can represent all CriticMarkup marks. A clean table name like `critic_marks` is preferable because these are no longer only comments.

Suggested projection fields:

| Field                             | Purpose                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `id`                              | Stable metadata id or deterministic cache id.                                       |
| `target_type`                     | `note` or `journal`.                                                                |
| `target_id`                       | Note id or journal entry id.                                                        |
| `kind`                            | `addition`, `deletion`, `substitution`, `comment`, `highlight`.                     |
| `status`                          | `open`, `resolved`, `archived`, nullable for plain marks.                           |
| `selected_quote`                  | Highlight/comment text, deletion text, addition text, or substitution display text. |
| `old_text`                        | Deletion text or substitution old side.                                             |
| `new_text`                        | Addition text or substitution new side.                                             |
| `body`                            | Comment body from metadata payload.                                                 |
| `mention_refs`                    | Parsed mention refs.                                                                |
| `attachment_refs`                 | Parsed attachment refs.                                                             |
| `markdown_start` / `markdown_end` | Source offsets for transforms and rail anchoring.                                   |
| `content_hash`                    | Hash of the source content used to build the row.                                   |
| `created_at` / `modified_at`      | Metadata timestamps when present.                                                   |

Cache rules:

- Rebuild projection rows after note/journal save, after synced content changes, and when opening a document with missing/stale cache.
- Do not sync projection rows independently.
- Do not treat projection rows as authoritative when markdown disagrees.
- Search indexes use projection rows for comment body, deleted text, inserted text, and highlighted quote.

## Sync Design

The note/journal body CRDT owns CriticMarkup. Separate `comment` sync items should be removed from the active path.

- Creating or editing a comment changes note/journal markdown, so it syncs with the document body.
- Accepting/rejecting review marks changes note/journal markdown.
- Cache rows rebuild locally after remote document content arrives.
- Conflicts are handled by the same document CRDT merge path as surrounding text.
- If two devices concurrently edit the same metadata payload, the resulting markdown may need parser recovery, but there is no separate SQL source to reconcile.

E2EE proof requirement:

- Synced CriticMarkup must be present only inside the encrypted note/journal body payload.
- Sync metadata, D1 rows, R2 objects, projection/cache rows prepared for upload, and removed `comment` item paths must not contain plaintext comment bodies, highlighted quotes, deleted text, inserted text, substitution text, attachment metadata comments, or reviewer notes.
- Tests must fail if a `{>>`, `{==`, `{++`, `{--`, or `{~~` marker or its human-readable payload appears in any server-visible plaintext sync artifact outside the local encrypted document body before encryption.
- Test interception points are both the plaintext sync-item builders before encryption and the final outbound/server-visible artifacts after encryption. Plaintext is allowed only in local editor state, local markdown storage, and local SQLite projection/cache.

## Error Handling and Edge Cases

- Malformed CriticMarkup should remain visible as literal text, not be deleted.
- Unclosed marks should not create cache rows.
- Nested marks are not supported in v1. The parser scans left to right and does not recursively parse mark contents. Once an opener is accepted, any opener-looking text inside that mark is literal payload until the matching closer. If the accepted opener has no matching closer, the opener is literal text and scanning resumes after it.
- Highlight comments are parsed as a pair only when a `{>> <<}` comment immediately follows a `{== ==}` highlight with no non-whitespace text between them. Otherwise the highlight and comment are separate marks.
- Review mark metadata comments are parsed as a pair only under the metadata pairing rules in CriticMarkup Semantics.
- Overlapping marks that cannot be represented as non-overlapping source spans are treated as literal text from the first problematic opener.
- `<<}` inside a comment body terminates the comment. Composer should prevent or escape that sequence.
- Markdown formatting should be wrapped completely by marks, following the README caveat. Prefer `{~~*old*~>*new*~~}` over splitting emphasis markers across a CriticMarkup boundary.
- Paragraph-level additions/deletions are supported by the syntax, but generated comments should avoid unnecessary newlines inside `{>> <<}`.
- Plain user-authored CriticMarkup without metadata should render and be actionable, but only metadata-backed marks can preserve attachments, mentions, and status.

## Implementation Phases

When implementation starts, create a fresh git worktree first. Work should not begin in the current worktree.

1. Build `critic-markup` parser/serializer utilities with README-based fixtures and round-trip tests.
2. Replace comment contracts/services with CriticMarkup mark contracts where needed.
3. Hard-change local schema from SQL-owned comments to `critic_marks` projection/cache.
4. Wire note/journal loading to parse marks and rebuild cache.
5. Wire editor rendering for all five mark types.
6. Change selection/block comment creation to write CriticMarkup into markdown.
7. Add update/delete/status operations that transform markdown payloads.
8. Add accept/reject for additions, deletions, and substitutions.
9. Remove active use of independent comment sync items.
10. Update docs that currently say comments do not enter markdown.

## Integration Inventory

| Current area                                        | Change                                                                                                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db-schema/src/schema/comments.ts`         | Replace hard with a `critic_marks` projection schema or rename/rework the existing table; no SQL-owned comment source remains.                                  |
| `packages/contracts/src/comments-api.ts`            | Replace comment CRUD contracts with critic-mark read/projection and markdown-action contracts. Keep exported shapes only when they still describe parsed marks. |
| `packages/contracts/src/ipc-channels.ts`            | Rename or replace `comments:*` channels with critic-mark channels; regenerate/check IPC contracts.                                                              |
| Renderer `comments-service.ts`                      | Replace SQL CRUD service with critic-mark projection reads and markdown action requests.                                                                        |
| `apps/desktop/src/preload/api/comments.ts`          | Replace preload comment API with critic-mark APIs and update preload tests.                                                                                     |
| `apps/desktop/src/preload/index.d.ts`               | Replace `CommentsClientAPI` types with critic-mark client types.                                                                                                |
| `apps/desktop/src/main/ipc/comments-handlers.ts`    | Replace create/update/delete SQL handlers with projection query and markdown-action handlers.                                                                   |
| Main `comments/store.ts`                            | Remove canonical create/update/delete store; add projection rebuild/query code.                                                                                 |
| `apps/desktop/src/main/comments/runtime-effects.ts` | Rework or remove side effects that assume SQL-owned comment lifecycle events.                                                                                   |
| Note page comment handlers                          | Stop calling SQL create/update/delete as source of truth; call markdown transforms and save note content.                                                       |
| Journal page comment handlers                       | Same as notes, scoped to current day entry markdown.                                                                                                            |
| `ContentArea.tsx` comment highlights                | Use parsed CriticMarkup marks and source spans instead of selected-quote lookup from SQL rows.                                                                  |
| Comment rail components                             | Reuse UI where useful, but accept parsed critic marks and show accept/reject for review marks.                                                                  |
| Sync payload schemas and handlers                   | Remove active `comment` sync item path; note/journal content sync carries marks.                                                                                |
| Comment sync schema/handler tests                   | Delete or rewrite separately from local `critic_marks` projection tests so E2EE sync proof is not confused with local plaintext cache behavior.                 |
| Search/index jobs                                   | Index `critic_marks` projection rows after markdown parse.                                                                                                      |
| Generated IPC map/checks                            | Run `pnpm ipc:generate` and `pnpm ipc:check` after contract/preload/handler changes.                                                                            |
| Docs under `apps/docs/src`                          | Reverse current docs that say comments stay outside markdown.                                                                                                   |

## Testing Plan

- Parser tests for all README examples: addition, deletion, substitution, comment, highlight+comment, combined paragraph.
- Metadata parser tests for ids, status, kind, timestamps, attachments, mentions, and escaped line breaks.
- Malformed syntax tests: unclosed marks, nested marks, terminator inside comment body.
- Transform tests for accept/reject of addition/deletion/substitution.
- Transform tests for comment update/delete and highlight unwrap.
- Cache rebuild tests from note and journal markdown.
- Renderer tests that notes and journals both show rail cards and review controls.
- Sync-adjacent tests that remote content changes rebuild cache without separate comment sync payloads.
- E2EE proof tests that encrypted note/journal sync payloads are the only sync path carrying CriticMarkup, and server-visible sync artifacts never expose plaintext marks or comment bodies.
- E2EE fixtures for both notes and journals covering `{>>`, `{==`, `{++`, `{--`, `{~~`, and human-readable comment/review bodies.
- Regression tests that no `comment` sync item is emitted when creating/updating/deleting/accepting/rejecting CriticMarkup marks.
- Docs impact checks after user-facing docs change.

## Open Implementation Notes

- Prefer replacing the `comments` concept with `critic marks` in code names where the type now covers additions, deletions, and substitutions.
- Existing attachment storage can remain; attachment refs are embedded in metadata and resolved through existing attachment services.
- Existing mention rendering can remain; mention refs are parsed from metadata and rendered in the rail.
- Existing orphan detection becomes less central because marks live at the annotated range. Cache rows can still become stale, but markdown cannot lose the durable comment by anchor mismatch.

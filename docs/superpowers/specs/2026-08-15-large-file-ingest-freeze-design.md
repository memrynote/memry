# Large-file vault ingest: freeze root cause and tiered-ingest design

Status: design, not implemented
Date: 2026-08-15
Epic: #1468
Children: #1458 (prefactor) · #1459 (the fix) · #1460 (stat-only ingest) · #1461 (no sync, both sides) · #1462 (2 GB read-only viewer) · #1463 (threshold calibration) · #1464 (in-file search) · #1465 (silent sync ceiling)
Related: #1445 (oversized note never syncs, silently)

## Symptom

A `.md` file pasted into the vault from Finder locks the app. Reproduced on three
installs: dev A (signed in, synced), dev B (received the same note over sync),
and a third signed-out install. All three showed a spinner and macOS
"not responding"; the 1.9 MB case recovered after seconds, the 17.8 MB case was
force-quit before it recovered.

Reported timing, which turns out to be exact: **the freeze starts the moment the
row appears in the sidebar.**

## Measurements

All on the reporter's machine, against the real files.

| stage                                      | 1.9 MB       | 17.8 MB               |
| ------------------------------------------ | ------------ | --------------------- |
| djb2 content hash + every metadata regex   | 20 ms        | ~200 ms               |
| FTS5 insert, `tokenize='porter unicode61'` | 14 ms        | 93 ms (19.5 MB index) |
| **`tryParseMarkdownToBlocks`**             | **6 594 ms** | see below             |

The first two were the initial suspects and both are cleared by measurement.

Parse cost tracks **single-block size**, not file size:

```
1.81 MB, blank-line separated (124 blocks)  ->    477 ms
1.81 MB, as-is                (1 block)     ->  6 594 ms      14x
2.73 MB, as-is                (2 blocks)    ->  8 936 ms
```

Identical bytes; the only difference is block shape. Log dumps contain no blank
lines, so remark parses the whole file as one paragraph with hard breaks — one
block holding millions of inline nodes, and the inline parse is roughly
quadratic in block size. Quadratic extrapolation puts the 17.8 MB file near ten
minutes, before counting GC pressure from the resulting ~18 MB Y.Doc.

Engine ceilings that bound any design here:

```
V8 max string length : 536 870 888 chars  (~512 MB)  -> readFile(…, 'utf-8') throws ERR_STRING_TOO_LONG above this
SQLite MAX_LENGTH    : 2 147 483 645 bytes (~2 GB)
```

## Root cause

`handleMarkdownFileAdd` does not separate _listing a note_ from _processing its
body_. Everything the sidebar row needs is `stat` + filename. What actually runs
before the row is shown:

| #   | site                   | work                                                                                     |
| --- | ---------------------- | ---------------------------------------------------------------------------------------- |
| 1   | `vault/watcher.ts:333` | `safeRead` — whole file into one JS string                                               |
| 2   | `:339`                 | `parseNote` / gray-matter                                                                |
| 3   | `:343`                 | `generateContentHash`, char-by-char djb2                                                 |
| 4   | `:354`                 | `syncNoteToCache`; puts full `parsedContent` on the projection event                     |
| 5   | `:368`                 | `flushProjectionEvents` → FTS insert                                                     |
| 6   | `:395`                 | `syncNoteCreate` → `initForNote` → `open()` → `seedFromMarkdown` → `markdownToYFragment` |
| 7   | `:399`                 | `emitEvent(CREATED)` — sidebar row appears                                               |

Step 6 is called before step 7 but is not awaited: `initForNote` yields at its
first `await`, `emitEvent` paints the row, the handler returns, and the
microtask queue then resumes `seedFromMarkdown` — which runs the BlockNote parse
on the main process with no yield point. That ordering is exactly the reported
"freezes the moment I see it in the sidebar".

**One sentence:** to put one row in the sidebar, the app reads, hashes, indexes
and CRDT-seeds the entire file, on the main process, before the user has touched
the note.

A size ceiling does not fix this. Any file _under_ the ceiling still takes the
same path. The ceiling only picks which files are excluded; it is not the fix.

## Design: tiered ingest

Two classes of vault file, decided at ingest, and three tiers of work.

### Classes

- **Note** — editable, BlockNote, CRDT-seeded, synced. Today's behaviour.
- **Large file** — read-only streaming viewer. No BlockNote, no Y.Doc, no sync.
  Carries a visible "read-only, not synced" badge so it never fails silently
  the way #1445 does.

Classification, both conditions required for **Note**:

```
NOTE_MAX_BYTES       = 1 MB      // 830 ms/MB for the worst realistic shape -> 0.83 s
NOTE_MAX_BLOCK_BYTES = 128 KB    // worst single 128 KB block measured at ~1 s
```

Largest block = largest blank-line-separated segment. Files over
`NOTE_MAX_BYTES` are classified on `stat` alone and never read. Files under it
are cheap to read, so the largest block is computed exactly rather than sampled.

A fixed byte ceiling alone misclassifies both directions: it rejects a
well-formed 3 MB note that parses fine, and accepts a 900 KB log dump that does
not. The pair is the point.

Both numbers were re-derived against a generated corpus in #1463, from a stated
budget of **1 s of main-process block on a note's first open**. That work moved
`NOTE_MAX_BYTES` from 2 MB to 1 MB (2 MB measured 1.65 s for an imported vault
note and 3.0 s for a table-dense document) and confirmed `NOTE_MAX_BLOCK_BYTES`
at 128 KB. It also found that a plain paragraph parses _linearly_, not
quadratically — density, not block size alone, is the driver — and that
table-heavy markdown is superlinear in file size, which neither bound catches.
See `2026-08-15-note-class-threshold-calibration.md`.

### Tiers

- **T0 — on `add`, O(1).** `stat` + path + title → sidebar row. The file is not
  read. Applies to both classes.
- **T1 — on idle, smallest file first.** Metadata + FTS, off the main thread,
  chunked for large files. Fills in `wordCount` / `snippet`.
- **T2 — on click.** Content loads. Note class → BlockNote + CRDT seed. Large
  file class → streaming viewer.

**CRDT seeding never runs at ingest.** It moves to the point where a note is
actually opened for editing. First open of a note pays up to ~500 ms; today that
cost is paid at ingest while blocking the main process, so a visible 0.5 s
replaces an invisible 7 s.

### Viewer

Ceiling **2 GB**. 512 MB was considered and rejected: it simplifies nothing,
because 512 MB cannot be held as a JS string either, so the viewer must read in
chunks regardless. Once chunked reading exists, 512 MB and 2 GB cost the same.

Requirements: chunked reads via file handle + offset, a line-offset index built
by one streaming scan on a worker, virtualized rendering (the repo already has
`virtualized-notes-tree.tsx` / `virtualized-all-tasks-view.tsx` to follow),
incremental in-file search. Above 2 GB: the row still appears in the sidebar,
clicking reports why it cannot open rather than a bare "failed to open".

### Sync

Large-file class does not sync at all. On other devices the file does not appear
in the sidebar. Showing an unopenable row is worse than not showing it. Syncing
metadata without a body is more correct but opens a new class of inconsistency
for materially more work; not in this design.

### Receiver side

Device B froze without ever touching Finder — it received the note over sync
(`memrynote-B/main.old.log:55716`, `CrdtWriteback: Created new note from sync`).
The snapshot push from A was rejected at the 5 MB encrypt cap (#1445), so the
body arrived as incremental CRDT updates, which are capped at 256 KB merged /
512 KB per flush and therefore pass. B then wrote the file back and paid the
same parse.

An ingest-side guard alone would not have saved B. The classification must also
apply to notes arriving over sync: a note whose written-back body exceeds the
Note-class thresholds degrades to large-file class on the receiver too, and is
not seeded.

### Backward compatibility

No reindex, no migration, no full re-scan. Existing note rows, FTS rows and CRDT
stores stay valid as they are; the tiered path applies only to new `add` events
and to new inbound sync writebacks. `search-projector.ts:267` already documents
what a full re-scan cost last time — do not repeat it.

## Non-goals

- Moving the BlockNote parse to a worker. It relocates a ten-minute parse rather
  than removing it, and the note would read as empty for the duration. Separate
  conversation.
- Editing large files. Not possible at these sizes at any threshold.
- Fixing #1445. Related and same underlying gap, but a separate issue: this
  design makes the oversized-note case unreachable going forward, while #1445
  covers the silent failure for notes already in existing vaults.

## Verification

1. 250 MB `.md` pasted into the vault → row appears, no main-process stall.
   Assert no `safeRead` on the ingest path for it.
2. 1.9 MB log dump (no blank lines) → classified large-file, viewer opens,
   never seeded.
3. Well-formed 1.8 MB markdown, 124 blocks → stays Note class, opens, seeds,
   syncs.
4. Sync: large-file class produces no sync item; receiver sidebar stays clean.
5. Receiver: inbound writeback over the thresholds degrades to large-file class
   and does not seed.
6. Existing vault opens with no reindex and no FTS rebuild.

## Open risks

- ~~`NOTE_MAX_BYTES` rests on one data point; tune against real notes.~~ Done in
  #1463. The residual it exposed: table-dense and punctuation-dense markdown is
  superlinear in _file_ size, so a file inside both bounds can still cost
  minutes. Bounding that needs a time-boxed parse, not a third size number.
- `NoteListItem.wordCount` / `snippet` become nullable — a renderer-visible
  contract change; needs the IPC contract updated and `pnpm ipc:check` run.
- The viewer is the bulk of the work here and is the piece most likely to want
  its own spec.

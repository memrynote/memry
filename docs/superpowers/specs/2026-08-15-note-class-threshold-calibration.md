# Note-class thresholds: parse budget, corpus and calibration

Status: measured and applied
Date: 2026-08-15
Issue: #1463 · Epic: #1468 · Follows #1459
Classifier: `packages/shared/src/markdown-class.ts`
Harness: `apps/desktop/src/main/sync/markdown-parse-budget.test.ts`

## Result

| constant               | before (#1459) | after                  | why                                                                                                           |
| ---------------------- | -------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `NOTE_MAX_BYTES`       | 2 MB           | **1 MB**               | 2 MB costs 1.65 s for a realistic imported note and 3.0 s for a table-dense one, against a 1 s budget         |
| `NOTE_MAX_BLOCK_BYTES` | 128 KB         | **128 KB** (confirmed) | no shape measured costs more than ~1 s for one 128 KB block, and the pathology it exists for is 4–140x larger |

## Re-running the measurement

```bash
pnpm --filter @memry/desktop measure:parse-budget
```

It is opt-in: the suite is `describe.skipIf(!process.env.MEMRY_PARSE_BUDGET)`, so
`pnpm test` collects one skipped file and pays nothing. A full run takes about
13 minutes, most of it in the deliberately pathological cases.

The corpus is generated at measurement time from fixed-seed PRNGs rather than
committed — it is megabytes of markdown, and the shapes are what matter. The
harness measures `markdownToBlocks`, which is what `CrdtDocStore.seedFromMarkdown`
calls, so the numbers include the embed rewrite, the colour masking and the
blank-line split, not just `tryParseMarkdownToBlocks`.

Numbers below: median of 3 (1 for samples over ~1 s), Apple Silicon dev machine,
Node 24, Vitest `main` project.

## The budget

**A note's first open may block the main process for at most 1 second.**

Four things fix that number.

1. **It is a full main-process stall, not a background task.** The BlockNote
   parse runs synchronously on the main process with no yield point. While it
   runs, every IPC call queues and every window stops painting — the sidebar,
   the other note you had open, the menu bar. This is not "one view is slow".
2. **The OS calls it hung at about 2 s.** On macOS the main process is the UI
   thread; WindowServer starts the beachball once it stops servicing events for
   a couple of seconds. 1 s leaves a factor of two before the app looks broken.
3. **The measuring machine is fast.** Everything below is an Apple Silicon
   laptop. A 2019 Intel machine or a low-end Windows box runs this parse 2–4x
   slower, so 1 s here is already 2–4 s there. That headroom is spent, not
   spare, which is why the budget is not looser.
4. **It is cheap to hold.** After #1459/#1460 the seed happens on first open and
   the resulting Y.Doc is persisted, so the cost is paid once per note per
   install. Buying a smaller ceiling costs almost nothing in practice: 1 MB is
   still ~150k words, roughly three novels.

A budget is not a guarantee — see "What the bounds do not bound" below.

## Method

Two bounds, so two questions.

- **How does cost grow with file size?** Sweep total bytes with the block shape
  held constant and small (600 B paragraphs).
- **How does cost grow with the size of one block?** Sweep the size of a single
  block, per shape, with the file being exactly that one block.

Then a third question the first two do not answer: **does a file of N blocks
cost N times one block?** `splitMarkdownPreservingBlanks` only splits on runs of
3+ newlines, so an ordinary `\n\n`-separated document reaches
`tryParseMarkdownToBlocks` as **one call**. Blocks are remark's business inside
that call, and remark is not additive for every shape.

## Corpus

| shape               | stands for                                                                                                 | blank lines?         |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------- |
| prose               | daily notes, long-form writing                                                                             | yes, every paragraph |
| structured          | written-up docs: headings, nested lists, tables, code fences, links                                        | yes                  |
| obsidian vault note | imported vaults: frontmatter, `[[wikilinks]]`, `#tags`, `- [ ]` tasks, quotes                              | yes                  |
| tight outline       | Roam/Bear exports — `convertBlocks` in `packages/importers/src/roam` joins every bullet with a single `\n` | **no**               |
| log dump            | the 17.8 MB file that opened #1468                                                                         | **no**               |
| table               | one wide markdown table                                                                                    | **no**               |
| minified json       | an API response pasted straight in                                                                         | **no**, one line     |

`![[embeds]]` are deliberately absent: they reach `resolveVaultEmbeds`, whose
cost is a vault-index lookup, not a parse.

## Sweep A — file size, well-formed prose (600 B blocks)

| file   | blocks | ms    |
| ------ | ------ | ----- |
| 64 KB  | 123    | 31    |
| 256 KB | 490    | 109   |
| 512 KB | 978    | 210   |
| 1 MB   | 1 953  | 429   |
| 2 MB   | 3 906  | 891   |
| 3 MB   | 5 859  | 1 364 |

Fitted: **450 ms/MB, linear**. Prose is not the problem.

## Sweep B — one block, growing

Each row is a file consisting of exactly one block. `p` is the exponent of a
log-log fit `ms = k · blockKB^p`; 1 is linear, 2 is quadratic.

| block      | paragraph | log dump  | tight outline | table     | minified json |
| ---------- | --------- | --------- | ------------- | --------- | ------------- |
| 8 KB       | 3         | 6         | 20            | 25        | 6             |
| 16 KB      | 6         | 9         | 32            | 51        | 16            |
| 32 KB      | 13        | 17        | 63            | 123       | 54            |
| 64 KB      | 26        | 36        | 129           | 343       | 217           |
| **128 KB** | **53**    | **74**    | **264**       | **1 017** | **1 026**     |
| 256 KB     | 103       | 181       | 599           | 4 160     | 4 565         |
| 512 KB     | 211       | **2 653** | 1 419         | —         | —             |
| fitted `p` | 1.00      | 1.33      | 1.04          | 1.47      | 1.95          |

Two things here correct the spec's model.

- **A plain paragraph is linear, not quadratic.** 512 KB of words and spaces in
  one block costs 211 ms — the same rate as the same bytes split into 800
  paragraphs. The 14x in the original single measurement was not "one block"; it
  was _what was in_ the block.
- **Density is the driver, and it is punctuation.** Minified JSON is the only
  genuinely quadratic shape (`p = 1.95`): it opens with `[` and is wall-to-wall
  `{`, `"`, `:`, so the inline scanner backtracks over link labels the whole
  way. Tables are next (`p = 1.47`), then log dumps (`p = 1.33`, with a cliff
  between 256 KB and 512 KB — 181 ms to 2 653 ms).

## Additivity — 512 KB as 8 × 64 KB blocks

| shape         | measured   | 8 × one 64 KB block | ratio   |
| ------------- | ---------- | ------------------- | ------- |
| paragraph     | 216        | 208                 | 1.0     |
| log dump      | 298        | 288                 | 1.0     |
| minified json | 1 621      | 1 736               | 0.9     |
| tight outline | 1 820      | 1 032               | 1.8     |
| table         | **13 635** | 2 744               | **5.0** |

Tables are strongly super-additive. Eight 64 KB tables in one 512 KB document
cost five times eight separate 64 KB tables, because they are one parse call and
remark's table handling is superlinear in _document_ size. That single fact is
why the block bound cannot be the whole answer.

## Realistic shapes at size

| shape                    | 512 KB | 2 MB  | implied rate              |
| ------------------------ | ------ | ----- | ------------------------- |
| prose                    | 210    | 891   | 450 ms/MB                 |
| obsidian vault note      | 423    | 1 654 | 830 ms/MB                 |
| structured (table-dense) | 691    | 2 990 | ~1 400 ms/MB, superlinear |

Against a 1 s budget:

| ceiling  | prose      | vault note | structured |
| -------- | ---------- | ---------- | ---------- |
| 2 MB     | 891 ✅     | 1 654 ❌   | 2 990 ❌   |
| **1 MB** | **429 ✅** | **830 ✅** | 1 400 ⚠️   |
| 512 KB   | 210 ✅     | 423 ✅     | 691 ✅     |

**1 MB** is the landing. It holds the budget for the two shapes that describe
real notes — written prose and imported vault pages. It is 1.4x over for the
table-dense synthetic, and 512 KB would cover that too, but a document with
~1 400 tables in it is not a note anyone writes; paying for it with half the
remaining headroom on genuine content is the wrong trade.

## Confirming 128 KB

At 128 KB a single block costs 53 ms (prose), 74 ms (log dump), 264 ms
(outline), ~1 s (table, JSON). Nothing exceeds the budget on its own.

The bound exists to catch documents with **no blank line anywhere**, where the
block _is_ the file. Those run 500 KB to 18 MB — 4x to 140x above 128 KB — so
the exact cut point is not delicately placed. Between 64 KB and 128 KB the bound
only decides the fate of genuine human content: one wide table, one long code
fence, one exported outline page. Halving it would trim the machine-generated
tail and take editability from real notes, so 128 KB stays.

## What the bounds do not bound

Two size numbers cannot bound parse time, and pretending otherwise would be
worse than saying so.

- **Cost per byte varies ~30x by shape** — 450 ms/MB for prose against
  ~13 600 ms/MB for a table-dense 512 KB document.
- **Tables and dense punctuation are superlinear in file size, not block size.**
  A 1 MB file of 8 × 128 KB tables sits inside both bounds and still costs
  minutes. This is the residual, and it is real.

Neither bound can close that. It needs a different mechanism — a time-boxed
parse that aborts into large-file class, or the parse moved off the main
process. The design doc already lists the worker option as a non-goal for this
epic ("it relocates a ten-minute parse rather than removing it"). Worth its own
issue; nothing here should be read as claiming the case is handled.

## Backward compatibility

Classification is **derived, never persisted**. `notes-crud.ts` computes it per
call from `stat` plus content, and `crdt-provider.ts` recomputes it before
seeding. Nothing writes `sizeClass` to either database, no on-disk format
carries it, and the vault file is never touched.

So the change is a behaviour change on next open, and only that:

- **No migration, no reindex, no schema change, no re-scan.** Nothing to run.
- **Fully reversible.** Moving the constant back restores the previous
  behaviour exactly, on the next open, with no repair step.
- **Nothing is destroyed by the lowering.** A note between 1 MB and 2 MB that
  was already seeded keeps its Y.Doc and its persisted CRDT updates; it opens
  read-only with the large-file notice instead of in the editor, and the file on
  disk is untouched. Raising the ceiling brings it straight back.
- **No user is losing a note they edit today.** #1459 (PR #1474) is the first
  build to have any ceiling at all and has not shipped, so no released version
  ever treated 1–2 MB as editable-by-threshold. Relative to what users run
  today, this changes which oversized files stop freezing the app — 1 MB catches
  a strictly larger set than 2 MB did.
- **Sync is unaffected by the number.** The client encrypt cap (~3.7 MB of
  markdown) and the server body cap (8 MiB) are separate ceilings on a separate
  axis and neither moves. #1465 owns telling the user about those.

# Plan 007: Fetch R2 payloads concurrently (bounded) in `pullItems` instead of one serial round-trip per item

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. When done, update the status row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 86ee0cd1..HEAD -- apps/sync-server/src/services/sync.ts`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `86ee0cd1`, 2026-06-12
- **Issue**: https://github.com/memrynote/memry/issues/548

## Why this matters

`pullItems` is the sync-server's bulk download path: a client asks for N item ids, the server fetches their metadata from D1 and their encrypted payloads from R2. The D1 reads are already **batched** (chunked to respect the bind-parameter limit), but the R2 reads are done in a **serial `for await` loop** — one network round-trip to R2 per item, each waiting for the previous to finish. For a first sync or a large pull (hundreds of items), latency is O(N) × per-object-latency when most of those reads could overlap. Making the R2 reads concurrent (with a bound so a Worker isn't firing hundreds of simultaneous requests) cuts pull latency substantially without changing behavior or output ordering.

## Current state

```ts
// apps/sync-server/src/services/sync.ts:668
const D1_MAX_BIND_PARAMS = 95

// apps/sync-server/src/services/sync.ts:670
export const pullItems = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  itemIds: string[],
  vaultId = 'default'
): Promise<RecordPullItemResponse[]> => {
  if (itemIds.length === 0) return []

  const BATCH_SIZE = D1_MAX_BIND_PARAMS - 2 - RECORD_SYNC_ITEM_TYPES.length
  const allDbRows: StoredSyncItemPullRow[] = []

  for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
    const batch = itemIds.slice(i, i + BATCH_SIZE)
    const placeholders = batch.map(() => '?').join(', ')
    const rows = await db
      .prepare(/* SELECT ... WHERE item_id IN (...) ORDER BY server_cursor ASC */)
      .bind(userId, vaultId, ...RECORD_SYNC_ITEM_TYPES, ...batch)
      .all<StoredSyncItemPullRow>()
    allDbRows.push(...(rows.results ?? []))
  }

  allDbRows.sort((a, b) => a.server_cursor - b.server_cursor)

  const results: RecordPullItemResponse[] = []

  // apps/sync-server/src/services/sync.ts:706 — the serial R2 loop
  for (const row of allDbRows) {
    const item = await toPullItemResponse(storage, userId, row) // 1 R2 getBlob per item
    if (item) {
      results.push(item)
    }
  }

  return results
}
```

`toPullItemResponse(storage, userId, row)` reads one encrypted payload from R2 and returns a `RecordPullItemResponse | null` (null = skip, e.g. payload missing). The final array is ordered by `server_cursor` ascending; **this ordering must be preserved** for the client cursor protocol.

Conventions: this is a Cloudflare Worker (Hono). Keep it dependency-free — no new libraries; a tiny inline concurrency helper is fine. Tests live in `apps/sync-server/src/services/sync.test.ts` and mock D1 + R2.

## Commands you will need

| Purpose                         | Command                                                                      | Expected on success |
| ------------------------------- | ---------------------------------------------------------------------------- | ------------------- |
| Typecheck sync-server           | `pnpm typecheck:sync-server`                                                 | exit 0              |
| Test sync-server                | `pnpm test:sync-server`                                                      | all pass            |
| Run only the sync service tests | `pnpm --filter @memry/sync-server exec vitest run src/services/sync.test.ts` | pass                |

(`pnpm test:sync-server` may show the documented parallel-worker flake in `schema/d1.test.ts`; if a failure is _only_ in that file, re-run with `--no-file-parallelism` to confirm it's the known flake, not your change.)

## Scope

**In scope** (modify):

- `apps/sync-server/src/services/sync.ts` — replace the serial R2 loop with a bounded-concurrency version; preserve output ordering.
- `apps/sync-server/src/services/sync.test.ts` — add a test asserting order is preserved and nulls are filtered.

**Out of scope** (do NOT touch):

- `toPullItemResponse` internals and the D1 batching loop.
- The function signature / return type of `pullItems`.
- Any change that alters output ordering or the cursor semantics.

## Git workflow

- Branch: `perf/pullitems-concurrent-r2` (from `origin/main`).
- Commit message: `perf(sync-server): fetch R2 payloads concurrently in pullItems`.
- Do NOT push or open a PR unless instructed. No `Co-Authored-By` trailers.

## Steps

### Step 1: Replace the serial loop with a bounded-concurrency map that preserves order

Process `allDbRows` in fixed-size windows, awaiting each window with `Promise.all`, so at most `R2_CONCURRENCY` reads are in flight at once. Because we map over the already-sorted `allDbRows` and concatenate window results in order, output ordering is preserved. Filter `null`s after.

```ts
const R2_CONCURRENCY = 25

const settled: Array<RecordPullItemResponse | null> = []
for (let i = 0; i < allDbRows.length; i += R2_CONCURRENCY) {
  const window = allDbRows.slice(i, i + R2_CONCURRENCY)
  const part = await Promise.all(window.map((row) => toPullItemResponse(storage, userId, row)))
  settled.push(...part)
}

return settled.filter((item): item is RecordPullItemResponse => item !== null)
```

Remove the old `const results: RecordPullItemResponse[] = []` + `for (const row ...)` block. Keep everything above the loop (D1 batching, sort) unchanged.

**Verify**: `pnpm typecheck:sync-server` → exit 0.

### Step 2: Add a test that pins ordering and null-filtering

**Verify**: `pnpm --filter @memry/sync-server exec vitest run src/services/sync.test.ts` → all pass, including the new test.

## Test plan

Add to `apps/sync-server/src/services/sync.test.ts` (model after the existing `pullItems` tests — they already mock the D1 `prepare().bind().all()` chain and an R2 stub):

1. **Order preserved across concurrency windows**: stub D1 to return ≥ `R2_CONCURRENCY + 5` rows with ascending `server_cursor`, stub R2 so `toPullItemResponse` resolves with the item id; assert the returned array's order matches ascending `server_cursor` (i.e. the concurrency windowing did not reorder).
2. **Null payloads filtered**: make the R2 stub return "missing" for a couple of ids so `toPullItemResponse` yields `null`; assert those ids are absent and the rest are present in order.
3. (If feasible with the existing stubs) **concurrency is bounded**: track concurrent in-flight R2 reads in the stub and assert the peak never exceeds `R2_CONCURRENCY`. If the existing test scaffolding makes this awkward, skip it and note so — tests 1 and 2 are the required ones.

**Verify**: `pnpm test:sync-server` → all pass (modulo the documented `d1.test.ts` parallel flake).

## Done criteria

ALL must hold:

- [ ] The serial `for (const row of allDbRows) { await toPullItemResponse(...) }` loop is gone (`grep -n "for (const row of allDbRows)" apps/sync-server/src/services/sync.ts` → no matches).
- [ ] R2 reads run with bounded concurrency and the result remains ordered by `server_cursor`.
- [ ] `pnpm typecheck:sync-server` exits 0.
- [ ] `pnpm test:sync-server` passes (new tests included; any failure isolated to the documented `d1.test.ts` flake, confirmed via `--no-file-parallelism`).
- [ ] `git status` shows only `sync.ts` and `sync.test.ts` (plus `plans/README.md`) modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- `toPullItemResponse` has side effects that assume serial execution (e.g. it mutates shared state or writes a running counter) — concurrency would be unsafe; report instead of proceeding.
- The pull protocol elsewhere depends on items being produced lazily/streamed rather than collected into an array — the current code already collects into an array, but if you find streaming, stop.
- Tests reveal the output order is not actually `server_cursor`-sorted downstream (i.e. ordering wasn't load-bearing) — note it, but still keep ordering stable.

## Maintenance notes

- `R2_CONCURRENCY = 25` is a conservative default for a Worker; if Cloudflare subrequest limits or observed latency suggest a different value, tune it in one place.
- If `pullItems` ever gains pagination or a max-items cap, revisit whether the windowing should align with the page size.
- A reviewer should confirm ordering is preserved (the windowed concat keeps it) and that no new dependency was added.

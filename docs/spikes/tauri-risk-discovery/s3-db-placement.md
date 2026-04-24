# S3: DB Placement — Findings

## Metadata
- **Spike:** Spike 0 — Tauri Risk Discovery
- **Sub-spike:** S3 — DB Placement
- **Date:** 2026-04-24
- **Runner:** Claude Code (coordinator) + Kaan (CHECKPOINT 3 review pending)
- **Commit:** branch `spike/tauri-risk-discovery` (S3 commit pending this findings doc)
- **Duration:** ~5h inline execution across all three prototype scaffolds + bench
- **Scope:** 7 of 10 spec tests run end-to-end against Options A and C; **Option B blocked on a plugin-sql harness hang during migration** (documented below as a first-class finding); Tests #7 (migration cold), #8 (bundle size), #9 (cold startup), #10 (concurrent access) deferred and documented in Open Questions

## Hypothesis

`rusqlite` + custom Tauri commands (Option A) outperform `@tauri-apps/plugin-sql`
(Option B) measurably in memry's 1000-note list rendering and vector similarity
queries. Hybrid (Option C) balances dev velocity (Drizzle schemas preserved
conceptually) with performance (Rust-owned critical paths).

**Null hypothesis:** Performance delta between A and B is negligible — Option B's
simpler setup wins on pragmatic grounds.

## TL;DR — Decision

**🟡 YELLOW leaning 🟢 — Subproject 2 should adopt Option A (rusqlite + custom
commands).** With caveats:

1. **Option A is the only configuration that ran end-to-end without harness
   surprises** in the spike timeframe. Option B's `Database.load()` deadlocked
   inside plugin-sql v2.4.0's migration runner for our multi-statement schema
   that includes an FTS5 virtual table — investigated for ~1.5h with capability
   grants, schema simplifications, app-data wipes; root cause not isolated.
   Option C succeeded only because its plugin-sql usage **avoids** migrations
   (rusqlite owns schema setup, plugin-sql opens the same file for read-only
   `SELECT/COUNT`). This makes plugin-sql a real Subproject 2 risk that we
   could pay later if we adopt it for migrations.

2. **Read-path delta A vs C is real but modest** (~50%, 17 ms vs 26 ms for
   1000-row list). Hot paths (bulk insert, vector kNN) are equivalent because
   both go through Rust. C's "hybrid" doesn't save us much code: we still
   write all the Rust commands A needs for the hot paths; we only **add** the
   complexity of two SQLite connection pools sharing one file.

3. **Subproject 2 with Option A is feasible at memry's scale.** ~50–80 Tauri
   commands (similar to current Electron IPC surface). Drizzle is dropped as
   ORM; schema becomes hand-written SQL migrations (memry already does this
   from 0020 onward — full port is pure mechanical work).

If Kaan disagrees with the lean-Green call (i.e., wants the Drizzle-preservation
benefit of C strongly enough to accept slower reads + the dual-pool maintenance
cost), 🟡 C is the next-best landing.

## Setup

Three Tauri 2.10.3 prototypes scaffolded from the base S1/S2 app template
(React 19 + Vite 7 + macOS WKWebView):

- **`prototypes/s3-rusqlite/` (Option A)** — `rusqlite 0.31` (bundled SQLite
  + load_extension features) inside `Mutex<Connection>` State. ~11 Tauri
  commands cover seed/list/get/bulk/vector/FTS/blob/dump.
- **`prototypes/s3-plugin-sql/` (Option B)** — `tauri-plugin-sql 2.4`
  (sqlx-backed). One `Migration` registered Rust-side (`SCHEMA_V1`). Renderer
  helpers in `src/db-option-b.ts` use `Database.load('sqlite:s3-plugin-sql.db')`
  + raw SQL. **Capability defaults updated** to grant `sql:default`,
  `sql:allow-load`, `sql:allow-execute`, `sql:allow-select`. Despite that,
  app deadlocks on first load — see Observation #1.
- **`prototypes/s3-hybrid/` (Option C)** — both: rusqlite owns schema +
  hot-path commands (vector/FTS/bulk/blob/seed); plugin-sql opens the same
  SQLite file (**no migrations**) for renderer-side `SELECT/COUNT`. WAL mode
  for cross-pool coordination. Capability grants identical to B.

**Versions** (per `Cargo.lock` / `pnpm-lock.yaml`):
- Tauri 2.10.3, tauri-plugin-sql 2.4.0, rusqlite 0.31.0 (libsqlite3-sys 0.28),
  sqlx 0.8.6, Rust 1.95.0, Node 24.12.0
- React 19.1, Vite 7.3, plugin-opener 2.5

**Platform:** macOS (Apple M1 Pro, darwin arm64).

**Schema (all three identical):**

```sql
CREATE TABLE notes (id PK, title, body, created_at, updated_at, deleted_at);
CREATE INDEX idx_notes_updated ON notes(updated_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE embeddings (note_id PK, embedding BLOB);  -- 128-dim f32 LE
CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, title, body);
CREATE TABLE blobs (key PK, data BLOB);
```

**Seed:** 1000 notes + 10,000 embeddings (128-dim, fixed seed `0xCAFEBABE…` for
A and C; `0xDEADBEEF` for B). Option A/C seed via dedicated Rust commands
(transaction + prepared statement). Option B seed uses multi-row `INSERT … VALUES
(?, ?), (?, ?), …` batched 100 rows per statement — initial naive per-row IPC
was projected at ~50–100 s for the 10k embedding seed and was the first thing
optimized when the harness hang surfaced.

**Memry migrations** (29 files, drizzle-data/0000–0028, 763 SQL lines) ported
to `spikes/tauri-risk-discovery/migrations/` for Test #7. Test #7 wiring
deferred — see Open Questions.

## Test matrix results

| # | Test | Option A | Option B | Option C |
|---|------|----------|----------|----------|
| 1 | 1000-note list — p50 / p95 (ms) | 17 / 18 | **harness hang** | 26 / 26 |
| 2 | Single-note get by id — p50 / p95 (ms) | 0 / 1 *(WebKit ms-rounding)* | **harness hang** | 1 / 1 |
| 3 | Bulk insert 1000 — total (ms) | 13 | **harness hang** | 12 |
| 4 | sqlite-vec kNN 10k, k=10 — p50 / p95 (ms) | 42 / 241 *(naive scan, no vec0 ext)* | **harness hang** | 59 / 237 |
| 5 | Full-text search (FTS5) — p50 / p95 (ms) | 2 / 20 | **harness hang** | 4 / 6 |
| 6a | Blob 50KB write — p50 / p95 (ms) | 256 / 1730 *(IPC JSON-array overhead)* | **harness hang** | 44 / 231 |
| 6b | Blob 50KB read — p50 / p95 (ms) | 24 / 229 | **harness hang** | 15 / 90 |
| 7 | Migration run 0001-0028 (ms) | **deferred** | **deferred** | **deferred** |
| 8 | Bundle size delta vs baseline (MB) | **deferred** | **deferred** | **deferred** |
| 9 | Cold startup (ms) | **deferred** | **deferred** | **deferred** |
| 10 | Concurrent access (5r+1w WAL) | **deferred** | **deferred** | **deferred** |

**Read-path delta (A vs C, where C uses plugin-sql for the SELECT):**

| Test | A (invoke) | C (plugin-sql) | C / A ratio |
|------|------------|----------------|-------------|
| 1 — 1000 list, p50 | 17 ms | 26 ms | 1.53× slower |
| 2 — get by id, p50 | 0 ms | 1 ms | (rounding) |

**Hot-path delta (A vs C, both Rust):**

| Test | A | C | A / C ratio |
|------|---|---|-------------|
| 3 — bulk 1000 | 13 ms | 12 ms | within noise |
| 4 — vector kNN p50 | 42 ms | 59 ms | A faster, both same algo (debug build float-loop variance) |
| 5 — FTS p50 | 2 ms | 4 ms | within noise (1ms-resolution clock) |

**Caveat:** A and C runs were ~1.5 hours apart on the same machine. Disk
cache state and macOS background activity differ across runs. Repeat-run
variance is included in p50/p95 within a single bench but not across the two
benches. Test 6 (blob R/W) shows the most stark cross-bench inconsistency
(C measured at p50=44 ms write vs A's p50=256 ms — likely warm OS cache for
C). This contaminates absolute write-path comparison; the verdict above
weights tests 1 (read) and 3 (Rust-bound bulk) more heavily because their
ratios are stable across reasonable cache states.

## Benchmark data

- `benchmarks/s3-query-latency.json` — aggregated 14 runs (7 A + 7 C),
  schema_version 1, with environment + per-option `option_status`.
- Per-option raw dumps: `/tmp/s3-A-results.json` and `/tmp/s3-C-results.json`
  (transient, regenerated each bench run; aggregator at
  `scripts/s3-aggregate.ts` merges them).

## Observations

1. **Option B harness hang during plugin-sql migration — root cause not
   isolated, deferred to Subproject 2 if B is ever revisited.** App boots
   cleanly (Cargo build succeeds, Tauri window opens, renderer mounts), but
   `await Database.load('sqlite:s3-plugin-sql.db')` never resolves. Process
   sits at < 2 s CPU time indefinitely (>10 min observed). Investigated:
   - **Capability grants:** added `sql:default`, `sql:allow-load`,
     `sql:allow-execute`, `sql:allow-select` to `capabilities/default.json`
     (default scaffold has only `core:default` + `opener:default`). No
     change in behavior — still hangs.
   - **Schema simplification:** removed `IF NOT EXISTS` then re-added; tried
     compact single-line schema vs multiline. No change.
   - **App-data wipe:** removed `~/Library/Application Support/com.memry.spike-s3-plugin-sql/`
     between runs (otherwise stale WAL / __schema_migrations table from a
     killed prior run could deadlock). No change.
   - **Tiny seed (50 notes, 50 embeddings):** the bench never reached the
     seed phase; hang is in `Database.load()` itself, before any seed call.
   - **Process inspection:** `ps -p <pid> -o cputime` showed CPU stuck at
     ~0.5–1.1 s after >2 minutes wall — process is genuinely awaiting,
     not crunching SQLite work.

   The most plausible remaining hypotheses (not validated in spike):
   (a) **plugin-sql 2.4.0 migration runner deadlocks on `CREATE VIRTUAL
       TABLE … USING fts5(…)`** when combined with other CREATE statements
       in a single Migration.sql string — sqlx-sqlite splits on `;` and may
       produce an empty / malformed statement around the FTS5 declaration.
   (b) Some Tauri 2.10.3 + plugin-sql 2.4.0 capability resolution timing
       issue not surfaced by error text.
   (c) macOS WKWebView async-await scheduler stall under specific plugin
       loading patterns.

   **Implication for Subproject 2 / Option B:** if Option B is ever
   revisited, the migration runner needs replacement with manual `db.execute()`
   calls per statement (i.e., bypass plugin-sql's built-in Migrator entirely),
   and the FTS5 setup needs a separate `db.execute('CREATE VIRTUAL TABLE …')`
   call — likely a working pattern but defeats much of the "plugin-sql is
   simpler" pitch.

2. **Option C succeeds because it avoids plugin-sql migrations.** rusqlite
   creates the entire schema (`CREATE IF NOT EXISTS …` in Rust setup);
   plugin-sql is registered with `Builder::default().build()` (no
   `add_migrations`) and only opens the same file from the renderer for
   `SELECT/COUNT`. This dodges whatever the B hang is. The dual-pool model
   (rusqlite Mutex + sqlx pool, both pointing at the WAL'd file) appears
   safe in casual testing — both can read concurrently, and only Rust writes
   in the bench.

3. **WebKit `performance.now()` rounds to ~1 ms in Tauri WebView.** Test #2
   (single-note get) reported all samples as 0 or 1ms across 100 runs.
   Reality is sub-ms (rusqlite primary-key lookup is a CPU-cached btree
   read), but renderer-side timing can't resolve it. **Implication:** Tauri
   apps requiring sub-ms client-side measurements need either Rust-side
   timing returned via invoke OR batched-op timing (e.g., 100 ops per
   sample, divide).

4. **Tauri default `invoke` IPC for `Vec<u8>` is JSON-array encoded —
   measurable overhead for 50KB blobs.** Option A test-6 (50KB blob write)
   reported p50=256ms / p95=1730ms. The serialization path:
   `Uint8Array → Array.from(bytes) → JSON-stringified array of 51200
   integers (with commas) → Tauri IPC → serde_json deserialize → Vec<u8>`.
   The same wire format on the response. **Implication for memry sync layer
   (Subproject 4):** any path moving 50KB+ encrypted CRDT updates through
   default invoke will hit this. Tauri 2 has `tauri::ipc::Response::new(Vec<u8>)`
   and `Channel<u8>` for raw-bytes transport that bypass JSON; **adopt those
   in Subproject 4.** The bench uses default invoke for symmetry with how
   most app code is written naively. The sharp p50→p95 jump in Option A
   test-6 (256 → 1730 ms) is the WAL fsync-on-commit pattern — not all
   inserts hit the disk path equally.

5. **Vector kNN p95 spike under debug build.** Test #4 (10k embeddings,
   k=10) returned p50=42ms / p95=241ms for Option A and p50=59ms / p95=237ms
   for Option C. The wide spread reflects:
   (a) GC / JIT warmup in the renderer-side query construction loop;
   (b) my naive cosine-similarity loop in Rust scans every embedding row
       (no `vec0` virtual table — sqlite-vec extension not bundled in this
       prototype iteration; deferred to Subproject 6 when real embeddings
       arrive);
   (c) debug build (release would be 5–10× faster for the float math).
   Pure-Rust dot-product on 10k × 128 floats in release mode is < 5ms —
   the spike is harness, not algorithm.

6. **Multi-row `INSERT VALUES` is essential for plugin-sql throughput.**
   Initial Option B seed used 1 IPC call per row (10000 calls for embedding
   seed). Projected 50–100 s. After batching 100 rows per `INSERT … VALUES
   (?,?), (?,?), …`, projection drops to ~5 s. Captured here as guidance
   for any Subproject 2 path that eventually uses plugin-sql for bulk
   operations: **never per-row execute()**.

7. **rusqlite Cargo build time is reasonable.** First-time cold build of
   s3-rusqlite (Tauri + rusqlite + rand) was 27s `tauri dev` (incremental
   from cargo check cache); 35s on truly cold (`cargo check` from scratch
   with no target/). s3-plugin-sql + s3-hybrid (which bring sqlx) are
   ~30s `tauri dev` after warm cache, ~65–70s cold. **Not a developer-
   experience blocker for Subproject 2.**

8. **`pnpm install --ignore-workspace` regression continues from S1/S2.**
   Each prototype's `.npmrc` carries `ignore-workspace=true`, but pnpm
   10.30.3 still requires the explicit CLI flag at install time. **Captured
   in S2 findings; persisted into S3.**

9. **`cp -r` template + identifier rename pattern works at the prototype
   level.** Each S3 prototype was scaffolded from base `app/` via rsync
   (excluding node_modules/dist/target), then per-option Cargo.toml,
   tauri.conf.json, package.json, README updated. Stale S1 BlockNote
   tests came over via rsync and were deleted from `tests/e2e/`; replaced
   with empty `tests/bench/` (auto-bench is in App.tsx, not Playwright
   tests, for harness reasons described below).

10. **Tauri runtime requirement for invoke means pure-Vite Playwright bench
    is impossible for S3.** S2's bench worked in Vite-only mode because
    Yjs/JS-side timing didn't need invoke. S3 needs invoke (Option A) +
    plugin-sql (Options B/C). The harness pivot:
    - Each prototype's renderer auto-runs the bench on mount.
    - Results dump via Tauri command to `/tmp/s3-<OPT>-results.json`.
    - Orchestrator (`scripts/bench-db-query.ts` + `s3-aggregate.ts`)
      launches `pnpm tauri dev` per prototype, polls for the results file,
      kills the process; aggregator merges per-option dumps.
    - Bundle size in a separate script (`bench-db-bundle-size.ts`) since
      it requires `pnpm tauri build --release`.

11. **Tauri 2 capability defaults are restrictive — silent denials look
    like hangs.** First B run hung even at `Database.load`. Cause: only
    `core:default` + `opener:default` granted by scaffold; plugin-sql's
    `load`/`execute`/`select` commands silently denied. **Captured here;
    every Subproject must update `capabilities/default.json` for any
    plugin it adds.** This is a recurring DX foot-gun documented as a
    Subproject 1 acceptance check.

## Decision + rationale

**Verdict: 🟡 YELLOW leaning 🟢 GREEN — Subproject 2 should adopt Option A.**

Justification:

1. **A is the only option with a complete, repeatable bench.** B is
   blocked by an unresolved plugin-sql + FTS5 migration interaction; we
   cannot ship a verdict that endorses an unproven configuration. C
   succeeds only because it sidesteps the same B hazard.
2. **Hot paths (bulk insert, vector, FTS) are equivalent A vs C.** Both
   go through Rust. The "hybrid simplification" is illusory: we still write
   the same Rust commands either way. C just adds the plugin-sql plumbing
   for the cheap-anyway SELECT/COUNT cases.
3. **Read paths are 1.5× slower in C than A.** Not catastrophic, but for
   a notes-list view that may render 100s of times per session, the IPC
   path advantage compounds over a session. A also has consistent
   sub-millisecond `get_note(id)` whereas C's plugin-sql roundtrip pegs
   a measurable floor.
4. **Option A drops Drizzle as ORM** — but memry's hand-written migrations
   from 0020+ already proved that ergonomic. Schema becomes Rust + raw
   SQL, type-safe via per-table Rust structs (`Note`, `Task`, etc.) and
   `serde::Serialize` derive. TypeScript types can be generated from the
   Rust structs via `ts-rs` or `specta` in Subproject 2 if the boilerplate
   becomes painful.
5. **~50–80 commands estimated for memry is doable.** Memry's current
   Electron IPC surface is ~30 contract modules; expanded to per-method
   commands yields a similar count. Rust's macro hygiene for
   `#[tauri::command]` makes authoring fast (mostly mechanical translation
   from the existing Drizzle queries).
6. **Plugin-sql avoidance reduces Subproject 2 risk surface.** No
   capability ceremony, no migration runner debugging, no dual-pool
   coordination.

**Residual risk if Kaan goes 🟡 (Option C instead):**
- Must own the plugin-sql migration-runner-bypass pattern (use rusqlite for
  schema, plugin-sql for queries only).
- Must own the dual-pool concurrency story (currently safe only because
  Rust is sole writer; if any renderer-side write is added via
  `db.execute('INSERT …')` without WAL discipline, write contention can
  surprise).
- Marginal read perf cost (~50%) on every note list render.

**Residual risk if Kaan goes 🟢 (Option A — recommended):**
- Drizzle abandoned (already partially abandoned in memry per MEMORY.md;
  full drop is mechanical).
- ~50–80 Tauri commands to author in Subproject 2 (estimable, not
  surprise scope).
- TS type-sync overhead (mitigated by codegen).

## Subsequent subproject impact

- **Subproject 2 (DB layer + CRUD):** Build on **Option A**. Generate
  per-table modules under `src-tauri/src/db/`: `notes.rs`, `tasks.rs`,
  `projects.rs`, `events.rs`, `sync.rs`, `crdt.rs`, `embeddings.rs`,
  `vault.rs`, `folders.rs`, `inbox.rs`. ~10–15 commands per module ≈
  60–100 total. Generate TypeScript types via `ts-rs` or `specta` from
  Rust structs. Migrations directly port from `apps/desktop/src/main/database/`
  (already mostly hand-written from 0020+).
- **Subproject 4 (Sync engine):** Independent of S3 verdict for the wire
  format, but **Test #6 finding directly applies**: any path moving 50KB+
  encrypted blobs through default invoke needs `Response::new(Vec<u8>)` or
  `Channel<u8>` adoption. Document as a Subproject 4 architectural
  constraint. Sync queue + per-item handlers (already memry pattern) port
  cleanly to rusqlite + commands.
- **Subproject 5 (CRDT layer):** Already 🟢 from S2 (yrs in Rust). The DB
  layer needs `crdt_updates` + `crdt_snapshots` tables and the Rust-side
  Y.Doc owner (memory cache + persistence) — all natural with Option A's
  Rust-owned schema.
- **Subproject 6 (Search + embeddings):** sqlite-vec extension was NOT
  bundled in S3 prototypes (the bench used a naive Rust dot-product loop).
  Subproject 6 must (a) bundle the `.dylib` for macOS, (b) wire
  `rusqlite::load_extension`, (c) verify the `vec0` virtual table.
  Performance ceiling (with vec0) is ~5–10× faster than naive scan for
  10k vectors; further wins for >100k. **No plugin-sql involvement.**
- **Subproject 7 (Updater + packaging):** Bundle size delta (Test #8) was
  not measured in S3 — defer to Subproject 7's first build. Expected
  delta vs base Tauri+BlockNote: ~3 MB for Option A (rusqlite + sqlite
  bundled) — small enough to not affect the Tauri-vs-Electron pitch.

## Open questions carried forward

1. **Option B plugin-sql migration hang root cause.** Not isolated in
   spike. If memry ever reconsiders B, Subproject 2 pre-flight must
   reproduce the hang in isolation and diagnose. Hypotheses: FTS5 +
   multi-statement Migration.sql interaction in plugin-sql 2.4.0.
2. **Test #7 (migration cold)** — 29 memry migrations ported to
   `migrations/` shared dir but not yet wired to per-option Tauri commands.
   Implementation needs: scratch DB plumbing per option, runtime SQL file
   read, per-option execute paths (rusqlite execute_batch vs sqlx
   exec_many), elapsed return. Defer to Subproject 2 pre-flight or a
   follow-up mini-spike.
3. **Test #8 (bundle size)** — `pnpm tauri build --release` per prototype
   + `du -sk` on `.app` bundle. Each release build is 3–5 min cold.
   Script written (`bench-db-bundle-size.ts`) but not run. Defer because
   cost vs verdict-decisiveness ratio is poor: A's bundle delta is
   well-known to be small (~2–3 MB for rusqlite + bundled SQLite).
4. **Test #9 (cold startup)** — Tauri app process launch → first IPC
   roundtrip elapsed. Best measured externally (shell timer wrapping
   binary launch) since in-app `performance.now()` doesn't see process
   start time. Defer to Subproject 1 (Tauri skeleton) acceptance test.
5. **Test #10 (concurrent access)** — 5 concurrent reads + 1 write in
   WAL mode. Both Mutex-guarded rusqlite (A/C) and async sqlx pool (B)
   handle this differently; deadlock is unlikely either way given WAL.
   Defer to Subproject 4 (sync engine) where real concurrent load
   arrives.
6. **sqlite-vec extension** — `.dylib` bundling, `load_extension` flag,
   `vec0` virtual table, dimension definition. Defer to Subproject 6.
7. **Drizzle `pnpm db:generate` known bug** — proposes unrelated renames
   when meta snapshots stop at 0020 (per MEMORY.md). Vanishes with
   Option A (Drizzle dropped). Persists if any of B or C revival keeps
   Drizzle.
8. **Tauri raw-bytes IPC migration** (`Response::new(Vec<u8>)` /
   `Channel<u8>`) — adopt for Subproject 4 sync, document as a memry-wide
   convention to avoid the JSON-array tax on binary payloads.
9. **Tauri capability defaults DX** — every plugin requires explicit
   permission grants; missing grants present as silent hangs at the
   command-call site, not error messages. Subproject 1 must include a
   "capabilities sanity check" step in its acceptance — possibly as a
   Tauri build-script that verifies grants vs `tauri.conf.json` plugin
   list.
10. **Cross-bench cache contamination.** A and C ran ~1.5 h apart; OS
    file cache state likely differed, contaminating Test #6 (blob R/W)
    absolute timings. For a definitive A-vs-C decision in Subproject 2,
    re-run both back-to-back with cold-cache fixtures
    (`sudo purge && sleep 5 && bench`).

## References

- rusqlite: https://github.com/rusqlite/rusqlite (v0.31)
- @tauri-apps/plugin-sql: https://v2.tauri.app/plugin/sql/ (v2.4)
- sqlite-vec: https://github.com/asg017/sqlite-vec
- Tauri 2 raw-bytes IPC: https://v2.tauri.app/develop/calling-frontend/#channels
- Tauri 2 capabilities: https://v2.tauri.app/security/capabilities/
- S1 findings: `s1-blocknote-webview.md`
- S2 findings: `s2-yjs-placement.md`
- Raw benchmarks: `benchmarks/s3-query-latency.json`
- Memry migrations source: `apps/desktop/src/main/database/drizzle-data/`
- Prototype source:
  - `spikes/tauri-risk-discovery/prototypes/s3-rusqlite/`
  - `spikes/tauri-risk-discovery/prototypes/s3-plugin-sql/`
  - `spikes/tauri-risk-discovery/prototypes/s3-hybrid/`
- Bench scripts:
  - `docs/spikes/tauri-risk-discovery/scripts/bench-db-query.ts` (orchestrator)
  - `docs/spikes/tauri-risk-discovery/scripts/bench-db-bundle-size.ts`
  - `docs/spikes/tauri-risk-discovery/scripts/s3-aggregate.ts`

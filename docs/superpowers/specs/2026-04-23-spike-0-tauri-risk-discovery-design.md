# Spike 0: Tauri Risk Discovery — Design Spec

## Metadata

| Field | Value |
|-------|-------|
| Date | 2026-04-23 |
| Status | Design approved, awaiting implementation plan |
| Author | Kaan (via brainstorming with Claude Code) |
| Spike branch | `spike/tauri-risk-discovery` (git worktree) |
| Worktree path | `~/sideproject/memry-worktrees/spike-tauri-risk` |
| Estimated duration | 3.5 days autonomous + ~2 hours Kaan review |
| Parent initiative | Memry: Electron → Tauri migration (pre-production, no users) |

## TL;DR

Memry will migrate from Electron to Tauri 2.x. The migration is decomposed into
8 independent subprojects, each with its own spec/plan/execute cycle. Before any
subproject starts, **Spike 0** runs three parallel risk-discovery tests to lock
in three architectural decisions that determine the shape of every subsequent
subproject:

1. **S1 — BlockNote + WKWebView compatibility** — does the core editor work in
   system webview, or does the migration die here?
2. **S2 — Yjs placement** — JS Yjs in renderer vs yrs (Rust port) in Rust main;
   Prototype C (ywasm) rejected based on y-crdt parity table (observer API
   marked incompatible with yjs).
3. **S3 — Database placement** — `rusqlite` + custom Tauri commands vs
   `@tauri-apps/plugin-sql` vs hybrid.

Spike output is **hybrid**: throwaway prototype code (deleted after spike),
keeper artifacts (findings + benchmarks + reproducible scripts) committed to
main. Execution is **autonomous** via `superpowers:writing-plans` →
`superpowers:executing-plans` with Kaan reviewing at 4 checkpoints.

## 1. Context & Motivations

### Why migrate from Electron to Tauri

Kaan's stated priorities (brainstorming conversation, 2026-04-23):

- **Bundle size** — Electron DMG 150MB+ → Tauri 10-30MB typical
- **Memory** — dedicated Chromium ~300MB/app → system webview ~50-100MB
- **Performance** — IPC overhead lower, Rust native for hot paths
- **Rust is not a learning blocker** — can commit to proper Rust adoption,
  not thin wrapper

Since the app is pre-production with no users, there are no backward-compat
constraints on data format, bundle format, or update channels. Migration
breakage is acceptable.

### Why a spike first

A naive "migrate UI first, then backend" plan is structurally wrong for memry
because:

- **BlockNote in system webview is unknown** — if it fails, the entire
  migration dies. Discovering this after 3 weeks of scaffolding is expensive.
- **Yjs placement is architecturally consequential** — whether Y.Docs live in
  Rust or renderer determines the shape of sync, CRDT, and IPC.
- **Database placement affects ~50-80 IPC commands** — Rust-owned vs
  plugin-sql is not trivially swappable mid-migration.

These three decisions cascade into every subproject. Without evidence, they are
guesses. Spike 0 replaces guesses with measured outcomes.

### Why decomposed into 8 subprojects

A single design doc covering all of Memry's Electron surface (~150 deps, ~30
IPC contract modules, dual DB, CRDT, crypto, sync engine, ML embeddings) is too
large to write coherently. Each subproject is independently specifiable,
planable, and executable. Decision decisions surface in Spike 0; concrete
implementation happens in subprojects.

Full subproject list (see Appendix):

1. Tauri skeleton + renderer port
2. DB layer + basic CRUD
3. Crypto + vault + keychain
4. Sync engine (HTTP + queue + encrypt/decrypt)
5. CRDT layer (Yjs push/pull, seed)
6. Search + embeddings + vector
7. Updater + packaging
8. E2E migration + Electron decommission

Sync-server (Cloudflare Workers + Hono) is **unaffected** — it persists
encrypted blobs via HTTP and has no dependency on Electron.

## 2. Scope

### In scope

- Three sub-spikes (S1, S2, S3), each producing a 🟢/🟡/🔴 decision
- Benchmark data sufficient to justify each decision
- Reproducible scripts so benchmarks can be re-run post-spike
- Documented findings per sub-spike plus overall spike summary
- Platform coverage: **macOS full + Windows S1 smoke subset**

### Out of scope

- Linux platform testing (deferred to Subproject 7: Updater + Packaging)
- Huggingface transformers.js in webview (deferred to Subproject 6: Search)
- Full production-ready code (throwaway after spike)
- Subproject 1-8 implementation (each gets own spec)
- Sync-server changes (not required)

### Platform rationale

Coverage matrix:

| Platform | Coverage | Rationale |
|----------|----------|-----------|
| macOS | Full (S1, S2, S3) | Primary dev platform; WKWebView is the hardest BlockNote target |
| Windows | S1 smoke only (~1h, 5 tests) | WebView2 is Chromium-like, low risk; smoke covers regressions |
| Linux | Deferred | WebKit2GTK + packaging complex; not blocking migration viability |

## 3. Approach: Balanced Spike

### Duration and shape

**~3.5 days** of autonomous execution + **~2 hours** of Kaan's checkpoint
review time.

```
Day 1       Day 2       Day 3       Day 3.5
┌───────┐   ┌───────┐   ┌───────┐   ┌──────────┐
│  S1   │   │  S2   │   │  S3   │   │ Win smoke│
│ 15    │   │ A vs  │   │ 3-way │   │ + final  │
│ tests │   │ B, 8  │   │ bench │   │ findings │
│       │   │ tests │   │ 10 t. │   │          │
└───┬───┘   └───┬───┘   └───┬───┘   └─────┬────┘
    ▼           ▼           ▼             ▼
  CHK1        CHK2        CHK3       FINAL SIGN-OFF
  (~30m)      (~30m)      (~30m)        (~45m)
```

### Output model: hybrid

- **Throwaway code** — `spikes/tauri-risk-discovery/` directory (app, prototypes)
  deleted at end of spike via explicit commit.
- **Keeper artifacts** — `docs/spikes/tauri-risk-discovery/` (findings,
  benchmarks, scripts) committed to main for permanent reference.

Rationale: spike code is laboratory output, not production. Keeping it pollutes
the foundation of Subproject 1. But the **decisions + benchmarks + methodology**
are the spike's permanent value and must survive.

### Execution model: autonomous

- `superpowers:writing-plans` produces the numbered implementation plan
- `superpowers:executing-plans` sub-agent runs plan steps in worktree
- Coordinator Claude (main session) handles `pnpm` / `git` / `gh` (sub-agent
  cannot due to worktree isolation permission limits, see MEMORY.md note)
- Kaan reviews at each checkpoint

## 4. Architecture

### Directory layout

```
memry/                                     (main repo)
├── spikes/tauri-risk-discovery/          ← throwaway, in worktree only
│   ├── app/                               ← Tauri 2.x app (src-tauri/ + vite)
│   ├── prototypes/
│   │   ├── s2-yjs-renderer/              ← Prototype A workspace
│   │   └── s2-yjs-rust/                   ← Prototype B workspace
│   └── README.md                          ← "this directory is temporary"
└── docs/spikes/tauri-risk-discovery/      ← permanent, on main branch
    ├── README.md                          ← entry point for future readers
    ├── findings.md                        ← overall Spike 0 summary
    ├── s1-blocknote-webview.md            ← S1 detailed report
    ├── s2-yjs-placement.md                ← S2 detailed report
    ├── s3-db-placement.md                 ← S3 detailed report
    ├── benchmarks/
    │   ├── README.md
    │   ├── s1-feature-matrix.csv
    │   ├── s2-roundtrip-latency.json
    │   ├── s3-query-latency.json
    │   ├── environment.json
    │   └── screenshots/
    └── scripts/
        ├── README.md
        ├── bench-webview-blocknote.ts
        ├── bench-yjs-roundtrip.ts
        ├── bench-db-query.ts
        └── collect-environment.ts
```

**pnpm-workspace.yaml** gets `!spikes/**` exclusion (reverted after spike).

### Branch strategy

- Branch: `spike/tauri-risk-discovery` created from `main`
- Worktree: `~/sideproject/memry-worktrees/spike-tauri-risk`
- Merge: **PR only, no auto-merge**; Kaan explicitly approves merge after
  review

### Technology choices

| Component | Choice | Version |
|-----------|--------|---------|
| Tauri | Latest stable | 2.2+ |
| Rust | Stable toolchain | 1.85+ |
| Vite | Same as memry | 7.x |
| React | Same as memry | 19.x |
| Tailwind | Same as memry | 4.x |
| BlockNote | Same as memry (apples-to-apples) | 0.47.x |
| Yjs | Same as memry | 13.6.x |
| yrs (Rust) | Latest | 0.21+ |
| Playwright | Webview testing | 1.57+ |
| criterion | Rust benchmarks | latest |

### Checkpoint model

- **🟢 Green** — sub-spike met expected outcome, proceed to next
- **🟡 Yellow** — unexpected result but migration still viable; findings
  document it, subprojects will adapt
- **🔴 Red** — result jeopardizes migration; halt, escalate to Kaan,
  re-brainstorm if needed

### Kill switches

| Trigger | Threshold | Action |
|---------|-----------|--------|
| Sub-spike wall time | > 4 days | Halt + escalate |
| Single test retry budget | > 3× | Mark test as failed, document, continue |
| Build failures (cargo/pnpm) | > 5 attempts | Halt + escalate |
| Tauri dev server crashes | > 10 crashes | Halt + escalate |
| Sub-agent activity loop | > 30 min same activity | Halt + escalate |
| Checkpoint pending (Kaan) | > 48 hours | Auto-pause, await resume |
| Disk space | < 5 GB free | Halt + escalate |
| Spike total wall time | > 7 days | Hard halt + full re-brainstorm |
| Unexpected data loss observed | 1 instance | Immediate halt + Kaan alarm |

## 5. Sub-spike Designs

### 5.1 S1 — BlockNote + WKWebView

#### Hypothesis

BlockNote 0.47.x in Tauri 2.x's macOS WKWebView provides UX parity with Electron
Chromium for core editing scenarios: typing, paste, IME, slash menu, images,
undo/redo.

**Null hypothesis (red):** At least one critical scenario exhibits silent data
loss or corruption — invalidates migration foundation.

#### Setup

- `spikes/tauri-risk-discovery/app/` scaffolded with `create-tauri-app`
- React + TypeScript + Vite preset
- BlockNote `@blocknote/core` + `@blocknote/react` + `@blocknote/shadcn`
- Minimal UI: full-viewport BlockNote editor, 3 buttons (save/load/dump JSON)
- No Yjs integration in S1 — this spike tests pure editor, not collaboration
- `tauri.conf.json` > `bundle > macOS > minimumSystemVersion` = 10.15

#### Test matrix

| # | Scenario | Method | Threshold |
|---|----------|--------|-----------|
| 1 | Text typing (ASCII) "Hello World" | Playwright DOM compare | 100% char match |
| 2 | Text typing (Turkish) "İğüşçö çalışıyor mu?" | Manual + Playwright | 100% chars + diacritics |
| 3 | IME — Japanese input (Google IME) | **Manual** (IME hard in Playwright) | composition events preserved |
| 4 | Paste plain text (cmd+v) — 500 char | Playwright clipboard | all chars inserted |
| 5 | Paste rich HTML (Notion/Docs source) | Manual | structure preserved: headings (h1-h3), lists (ul/ol nested), paragraphs, bold/italic marks — inline style attributes and CSS class names MAY be dropped |
| 6 | Paste image (screenshot) | Playwright mock clipboard | image block or no crash |
| 7 | Drag-and-drop image file | Playwright | image block + bytes correct |
| 8 | Slash menu (/) | Playwright keyboard | menu opens, filters, inserts |
| 9 | Undo/redo (10 op chain) | Playwright | ProseMirror history consistent |
| 10 | Table editing (insert/resize/delete) | Playwright | DOM structure correct |
| 11 | Code block + language select | Playwright | syntax highlighting renders |
| 12 | Link insertion (cmd+k) | Playwright | href attached, hover card shows |
| 13 | Large doc stress (10k char, 200 blocks) | Playwright fps | typing lag < 50ms p95 |
| 14 | Window resize mid-typing | Manual | selection/caret preserved, reflow |
| 15 | @react-sigma graph render | Manual smoke | no crash, WebGL context opens |

#### Windows smoke (subset)

Run #1, #4, #5, #8, #9 on Windows WebView2. IME and drag-drop deferred.

#### Success thresholds

- **🟢 Green** — all tests pass or acceptable degradation (e.g., HTML paste
  style loss). **Zero data loss.**
- **🟡 Yellow** — 1-2 tests partial fail (e.g., table column resize glitch) but
  no data loss and workaround known.
- **🔴 Red** — data loss in #1-#9 (characters/blocks disappearing) OR crash OR
  broken IME composition.

#### Artifacts

- `docs/spikes/tauri-risk-discovery/s1-blocknote-webview.md` (findings)
- `benchmarks/s1-feature-matrix.csv` (pass/fail grid per platform)
- `scripts/bench-webview-blocknote.ts` (Playwright test runner, reusable for
  future regression checks)

#### Known risks

- **WKWebView contenteditable scroll bug** — long doc with caret at bottom may
  not auto-scroll. Verify BlockNote's own scroll container behavior.
- **BlockNote useMemo init hydration** — first mount may show ProseMirror ↔
  React reconciliation mismatch in Vite HMR.
- **Turkish input locale detection** — WKWebView sometimes returns
  `navigator.language = "en"` regardless of system. BlockNote locale-dependent
  auto-capitalization may break; Test #2 catches this.
- **Metascraper paste handler** — memry's existing paste handler enriches URLs
  with OpenGraph; **simulated out for S1**, evaluated in Subproject 2/3.

### 5.2 S2 — Yjs Placement

#### Hypothesis

`yrs 0.21` is byte-compatible enough with Yjs 13.6 that Prototype B (JS Yjs in
renderer + yrs authoritative in Rust) preserves BlockNote's y-prosemirror
binding behavior.

**Null hypothesis (red):** yrs mishandles BlockNote's Y.XmlFragment nested
block structure or mark encoding — divergent state → data loss. Prototype A
wins by default.

#### Prototype A — renderer-owned Y.Doc (safe baseline)

- `new Y.Doc()` lives in renderer (React context singleton)
- `y-prosemirror` binds BlockNote editor directly
- Rust side is persistence-only:
  ```rust
  #[tauri::command]
  fn save_crdt_snapshot(note_id: String, bytes: Vec<u8>) -> Result<()>;
  fn load_crdt_snapshot(note_id: String) -> Result<Vec<u8>>;
  fn append_crdt_update(note_id: String, update_bytes: Vec<u8>) -> Result<()>;
  ```
- Storage: `crdt_updates` table, `note_id` + `update_bytes BLOB`
- Each `Y.Doc.on('update')` → Tauri `invoke('append_crdt_update', ...)`
- Rationale: closest to current Memry architecture; risk is low.

#### Prototype B — yrs in Rust (Rust-heavy ambition)

- `yrs::Doc` in Rust main (authoritative)
- API:
  ```rust
  apply_update(note_id: String, update_bytes: Vec<u8>) -> Result<Vec<u8>>
  get_state_vector(note_id: String) -> Result<Vec<u8>>
  get_snapshot(note_id: String) -> Result<Vec<u8>>
  subscribe_updates(note_id: String) -> EventChannel
  ```
- Renderer has **shadow Y.Doc** (only for y-prosemirror binding); authority is
  Rust
- Update flow: edit → y-prosemirror → renderer Y.Doc update → invoke
  `apply_update` → Rust yrs → Tauri event → renderer subscribe (echo filtered)
- Loop prevention: origin tagging (`applyUpdate(bytes, 'rust')` vs `'local'`)

#### Prototype C — REJECTED

`ywasm 0.18` (yrs compiled to WASM, consumed as JS in renderer) was evaluated
based on the y-crdt parity table shared by Kaan. Key finding:

> **Shared collections: observers — ✅ (incompatible with yjs)**
> **Document observers — ✅ (incompatible with yjs)**

y-prosemirror relies heavily on observers (every keystroke triggers
`ydoc.on('update')`, every block mutation triggers
`yFragment.observeDeep`). An "incompatible with yjs" observer API would cause
silent divergence with BlockNote. **Rejected without spike.**

Future reconsideration: if y-crdt team fixes ywasm observer compatibility in a
future version, Prototype C may be revisited. Noted as deferred.

#### Test matrix

| # | Test | Method | Threshold |
|---|------|--------|-----------|
| 1 | Single-device roundtrip — 50 chars, snapshot/restore | Playwright + DOM compare | byte-equal docs |
| 2 | Nested block — heading + 2-level bullets + code + image | Manual + JSON dump | block tree identical |
| 3 | Mark encoding — overlapping bold+italic+code | Playwright | mark ranges correct |
| 4 | Two-device merge — 2 Y.Docs, concurrent edits, merge | Node test | deterministic final state |
| 5 | State vector size — 1000 ops | Benchmark | within 1.2× Yjs reference |
| 6 | Update binary size — single char insert | Benchmark | within 10% of Yjs |
| 7 | Compaction — 1000 updates → snapshot | Benchmark | snapshot size ±20% Yjs |
| 8 | Origin filtering (B only) — echo loop absent | Playwright | Rust-originated update marked non-local in renderer |

#### Performance benchmarks (A vs B)

- Typing latency (keystroke → visible): Playwright wrapper
- Update persistence latency (change → Rust ACK): event markers
- Memory footprint (10k char doc loaded): devtools + jemalloc-ctl

#### Success thresholds

- **🟢 Green (B wins)** — all 8 tests pass + B typing latency ≤ 1.5× A + update
  size within ±10% → Subproject 5 uses yrs, Rust-heavy CRDT.
- **🟡 Yellow (hybrid)** — B passes tests 1-3 but fails 4-5 or is too slow →
  yrs used only for persistence/compaction; authoritative Y.Doc stays in
  renderer. Subproject 5 uses A+B hybrid.
- **🔴 Red (A wins)** — B fails test #1 (single-device roundtrip not byte-level)
  → yrs excluded from CRDT layer. Rust-heavy ambition for CRDT surrenders; DB
  + crypto + sync can still be Rust-heavy.

#### Artifacts

- `docs/spikes/tauri-risk-discovery/s2-yjs-placement.md`
- `benchmarks/s2-roundtrip-latency.json`
- `scripts/bench-yjs-roundtrip.ts`

#### Known risks

- **yrs version gap** — yrs 0.21 may lack some Yjs 13.6 features (Subdoc API).
  Memry doesn't use subdocs currently — verify during spike.
- **y-prosemirror update format versioning** — y-prosemirror 1.3+ mark
  encoding may have subtle differences with yrs. Test #3 catches.
- **Tauri IPC binary transfer overhead** — updates > 10 KB may be slower than
  Electron IPC. Tests #5 and typing latency measure.
- **Yjs snapshot format compatibility** — if yrs serialization differs from
  Yjs byte-level, existing y-leveldb stored Y.Docs can't be read. **Critical
  for Subproject 9 data migration** — note but do not solve in spike.

### 5.3 S3 — DB Placement

#### Hypothesis

`rusqlite` + custom Tauri commands (Option A) outperform
`@tauri-apps/plugin-sql` (Option B) measurably in memry's 1000-note list
rendering and vector similarity queries. Hybrid (Option C) balances dev
velocity (Drizzle schemas preserved) with performance (Rust-owned critical
paths).

**Null hypothesis:** Performance delta between A and B is negligible (SQLite
is fast; serialization overhead not dominant) → Option B's simpler setup wins
on pragmatic grounds.

#### Option A — Rust-owned SQLite + custom commands

- Crate: `rusqlite` (sync API, Electron better-sqlite3 equivalent)
- Connection pool: one per thread, shared via `State<Arc<Mutex<Connection>>>`
- Each query has a Tauri command (~50-80 commands, similar size to current IPC
  surface)
- Type safety: Rust structs → `ts-rs` or `specta` → TS types
- **Drizzle schemas abandoned**, Rust-side schema is hand-written SQL migrations
  (Memry's migrations are hand-written since 0020 — portability is good)
- sqlite-vec: `rusqlite` with `load_extension` feature flag, bundled `.dylib`

#### Option B — `@tauri-apps/plugin-sql`

- `@tauri-apps/plugin-sql` installed, backed by `sqlx`
- Direct SQL from renderer:
  ```ts
  const db = await Database.load('sqlite:memry.db')
  const notes = await db.select<Note[]>('SELECT * FROM notes WHERE deleted_at IS NULL LIMIT ?', [100])
  ```
- Drizzle query builder: custom driver possible (~200 LOC) or abandoned
- Migrations: plugin-sql migration runner (`builder.add_migrations(...)`
  Rust-side) consumes existing SQL migrations directly
- Type safety: hand-written TS types or codegen
- sqlite-vec: supported via sqlx connect options (v2.1+)

#### Option C — Hybrid

- Rust: `rusqlite` + connection pool + migrations runner (like A)
- Custom Tauri commands **only for non-trivial operations**: sync engine
  queries, vector search, FTS, transaction-heavy ops
- Simple CRUD: `@tauri-apps/plugin-sql`, shares connection path if feasible
- Drizzle schemas **preserved as source of truth** — Rust structs generated
  from them (custom codegen script, pattern similar to existing
  `scripts/generate-rpc-bindings.ts`)

#### Test matrix

| # | Test | Method | A | B | C |
|---|------|--------|---|---|---|
| 1 | 1000-note list | 10-run avg | p50 < 5ms | p50 < 20ms | p50 < 8ms |
| 2 | Single-note get by id | 100-run p95 | < 2ms | < 8ms | < 3ms |
| 3 | Bulk insert (1000 txn) | elapsed | < 200ms | < 600ms | < 250ms |
| 4 | sqlite-vec kNN (10k embeddings, k=10) | query time | < 30ms | < 80ms | < 35ms |
| 5 | Full-text search | query time | < 15ms | < 40ms | < 20ms |
| 6 | Blob R/W (50 KB CRDT update) | roundtrip | < 5ms | < 20ms | < 6ms |
| 7 | Migration run (0001-0020+) | elapsed cold | < 500ms | < 800ms | < 500ms |
| 8 | Bundle size delta (vs baseline — Tauri app with BlockNote but no DB code) | `du -sh .app` | +~3 MB | +~8 MB | +~4 MB |
| 9 | Cold startup (open → first query) | timestamps | < 200ms | < 400ms | < 250ms |
| 10 | Concurrent access (5 read + 1 write, WAL) | deadlock check | no deadlock | no deadlock | no deadlock |

#### Success thresholds

- **🟢 Green (A wins)** — tests 1-6: A at least 3× faster than B + bundle delta
  < 5 MB + migrations portable → Subproject 2 uses rusqlite + custom commands.
- **🟡 Yellow (hybrid wins)** — A vs C delta < 20% + C preserves Drizzle dev
  velocity → Subproject 2 uses hybrid.
- **🔴 Red (B wins or A brittle)** — B perf surprisingly good + A command
  authoring scale daunting (~50-80 commands proves too slow to write) →
  Subproject 2 uses plugin-sql; perf motivation carried by S2/sync layer.

#### Artifacts

- `docs/spikes/tauri-risk-discovery/s3-db-placement.md`
- `benchmarks/s3-query-latency.json`
- `scripts/bench-db-query.ts` (may use copy of real memry production DB for
  realistic data)

#### Known risks

- **sqlite-vec platform differences** — macOS `.dylib`, Windows `.dll`, Linux
  `.so`. Verify macOS in spike; Windows/Linux deferred to Subproject 7.
- **plugin-sql extension loading maturity** — v2.0 lacks extension API, v2.1+
  has it. Verify version; upgrade if needed.
- **Sync vs async paradigm** — Option A rusqlite sync matches Drizzle paradigm;
  Option B sqlx async matches renderer. Tauri commands are async either way.
- **Dual-database pattern** — Memry has data DB + index DB. All three options
  support this; B requires two `Database.load()` calls, A/C hold two connection
  states.
- **Drizzle migration generation known bug** — `pnpm db:generate` proposes
  unrelated renames (MEMORY.md). Bug persists in B/C (Drizzle kept); vanishes
  in A (Drizzle dropped). Minor decision factor.
- **Concurrent write contention** — WAL mode works in all three. A/C need
  Rust-side Mutex discipline; B handled by sqlx. Test #10 measures.

## 6. Artifacts & Documentation Discipline

### Per-sub-spike findings.md template

Each of `s1-blocknote-webview.md`, `s2-yjs-placement.md`,
`s3-db-placement.md` follows the same 10-section structure:

1. **Metadata** — date, runner, commit, duration
2. **Hypothesis** — what we tested
3. **TL;DR — decision** — 🟢/🟡/🔴 + 2-3 sentence summary
4. **Setup** — what was built, links to prototype code
5. **Test matrix results** — per-test pass/fail with notes
6. **Benchmark data** — key numbers + link to raw JSON
7. **Observations** — surprises, edge cases, interesting findings
8. **Decision + rationale** — what we choose, why
9. **Subsequent subproject impact** — what this means for Subprojects 1-8
10. **References** — GitHub issues, docs, research consulted

### Overall findings.md template

`findings.md` summarizes the full Spike 0:

- Metadata
- TL;DR — migration go/no-go
- Decision summary table (S1, S2, S3 outcomes)
- Post-spike architecture picture (ASCII diagram)
- Subproject sequencing + time estimates
- Key risks carried forward
- Next step (typically: Subproject 1 brainstorm)

### Benchmark JSON schema

All raw benchmark data uses this format:

```json
{
  "schema_version": 1,
  "spike": "s2-yjs-placement",
  "benchmark": "roundtrip-latency",
  "timestamp": "2026-04-25T14:30:00Z",
  "environment": {
    "os": "macOS 15.3 (Apple M2 Pro)",
    "node": "24.1.0",
    "rust": "1.85.0",
    "tauri": "2.2.0",
    "yrs": "0.21.3",
    "yjs": "13.6.29"
  },
  "runs": [
    { "prototype": "A", "test": "single-device-roundtrip", "samples": [...], "p50": 12, "p95": 28, "unit": "ms" },
    { "prototype": "B", "test": "single-device-roundtrip", "samples": [...], "p50": 15, "p95": 36, "unit": "ms" }
  ],
  "notes": "B p95 hit WKWebView GC tick (2 outliers)"
}
```

Versioned schema — future format changes retain backward readability.

### Benchmark script conventions

All `scripts/bench-*.ts` files follow a template:

- Collect environment via `collect-environment.ts`
- Output JSON to `../benchmarks/<name>.json`
- CLI flags: `--runs`, `--output`
- Rerunnable post-spike for regression checks (Tauri version upgrades, etc.)

### `scripts/README.md`

Brief guide for future readers on how to rerun benchmarks. Notes that spike
prototype code has been deleted — to regenerate, follow findings.md setup
sections.

## 7. Execution Strategy

### Roles

| Role | Responsibilities |
|------|------------------|
| **Kaan** | Checkpoint review (~30m each), 🟢/🟡/🔴 decisions, pause/resume |
| **Coordinator Claude** (main session) | Worktree creation, `pnpm install`, `git` operations, `gh` PR creation, sub-agent dispatch, findings presentation |
| **Sub-agent** (new invocation per sub-spike) | Write code, run tests, run benchmarks, draft findings.md; escalate to coordinator for restricted operations |

Permission model driven by `feedback_subagent_permissions.md` (MEMORY.md):
sub-agents in worktree isolation cannot run `pnpm` / git-mutating / `gh`. All
such commands route through coordinator.

### Worktree setup (coordinator, once)

```bash
# 1. Create worktree + branch
git -C /Users/h4yfans/sideproject/memry worktree add \
  /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk \
  -b spike/tauri-risk-discovery

# 2. Update pnpm-workspace.yaml — add "!spikes/**" to packages
# (reverted at cleanup time)

# 3. Scaffold directories
mkdir -p .../spike-tauri-risk/spikes/tauri-risk-discovery
mkdir -p .../spike-tauri-risk/docs/spikes/tauri-risk-discovery/{benchmarks,scripts}

# 4. README + findings.md skeletons

# 5. Initial commit
git -C .../spike-tauri-risk commit -m "spike(setup): initialize spike 0 tauri risk discovery"
```

### Sub-agent dispatch prompt template

Coordinator's prompt to `superpowers:executing-plans` sub-agent per sub-spike:

```
Task: Execute sub-spike <Sn> (<sub-spike name>) from Spike 0.

Context:
- Spec: docs/superpowers/specs/2026-04-23-spike-0-tauri-risk-discovery-design.md
- Plan: <numbered implementation plan from writing-plans output>
- You are in worktree: ~/sideproject/memry-worktrees/spike-tauri-risk
- BEFORE STARTING: Read docs/spikes/tauri-risk-discovery/ directory. If previous
  sub-spike findings.md files exist, read them first — they contain learnings
  that may adjust your approach. (S2 dispatch reads s1-blocknote-webview.md;
  S3 dispatch reads s1 and s2.)
- Do NOT run: pnpm install, git commit, gh. Return to coordinator.
- Do: write code, run tests (cargo test, vitest, playwright with existing deps),
  run benchmarks, write findings.md draft.

Acceptance:
- <sub-spike artifact paths per Section 5>
- All tests in matrix either pass OR have documented failure mode

On completion: return a summary with:
- TL;DR verdict (🟢/🟡/🔴 preliminary)
- Surprises or deviations
- Files created/modified
- Commands for coordinator to run (commits, etc.)

On blocker: return immediately with:
- Specific blocker
- What you tried, what's left
- Recommended next step

Operating budget:
- Max 4 days wall time (kill switch)
- Max 3 retries per single test
- If retry budget exhausted, escalate to coordinator
```

### Checkpoint protocol

After each sub-spike:

1. Sub-agent signals completion → returns findings draft
2. Coordinator spot-checks (~5m): findings.md complete? benchmark JSON schema
   valid? decision rationale present?
3. Coordinator presents to Kaan: TL;DR, key metrics, surprises, files
4. Kaan reviews (~30m): reads findings.md on disk, optionally reruns benchmark,
   gives 🟢/🟡/🔴
5. Coordinator acts on decision:
   - 🟢: `git commit -m "spike(sn): ..."` → dispatch next sub-spike
   - 🟡: append yellow note to findings → commit → dispatch next
   - 🔴: halt, escalate, potential re-brainstorm

### Pause/resume

Kaan can pause at any checkpoint by withholding the decision. Coordinator
awaits. Resume: "devam" message → coordinator continues. State is persisted in
worktree + findings.md + git commits.

### Error escalation triggers

Coordinator interrupts checkpoint flow and alerts Kaan immediately if:

- Unexpected data loss observed (rare, severe)
- Critical test fails on 3rd retry (hypothesis falsified, early decision needed)
- Unexpected dependency issue (e.g., `@blocknote/core@0.47` fails to build)
- Environment corruption (native build cache, disk cruft)
- Sub-agent proposes actions contradicting spec (e.g., "I installed a dep you
  didn't authorize")

Escalation format:

```
🚨 ESCALATION — Sub-spike Sn

Reason: <1-line summary>
Detail: <2-4 lines>
State: <worktree state, committed vs uncommitted>
Decision needed: <what choice>
Option A: <...>
Option B: <...>
Recommendation: <coordinator's take>
```

### Spike completion / cleanup

**If Kaan's final sign-off is 🔴 (migration abort):** skip cleanup. Preserve
the spike branch + worktree untouched for post-mortem analysis. Create a PR
with `draft: true` summarizing findings but mark the issue clearly. Branch is
retained until Kaan explicitly closes the investigation.

**If Kaan's final sign-off is 🟢 or 🟡 (migration proceed):**

```bash
# 1. Remove throwaway code (explicit commit)
git -C .../spike-tauri-risk rm -rf spikes/tauri-risk-discovery
git -C .../spike-tauri-risk commit -m "spike(cleanup): remove throwaway code, findings preserved in docs/"

# 2. Revert pnpm-workspace.yaml exclusion
# Edit + commit

# 3. Open PR (coordinator)
gh pr create --title "spike/tauri-risk-discovery: findings + decisions" \
  --body "<link to findings.md, summary of 3 decisions>"

# 4. WAIT for Kaan's explicit merge instruction — NO auto-merge
# Kaan reviews PR, approves, issues merge command

# 5. After Kaan merges:
git -C ~/sideproject/memry worktree remove ~/sideproject/memry-worktrees/spike-tauri-risk
git -C ~/sideproject/memry branch -d spike/tauri-risk-discovery
```

Outcome on main: `docs/spikes/tauri-risk-discovery/` + benchmark data +
scripts. Spike code gone. Worktree removed. Branch deleted.

## 8. Failure Modes & Kill Switches

### Three-layer failure hierarchy

**Layer 1 — Single test failure**
- Pass → record, continue
- Known failure → yellow, findings note, continue
- Unexpected failure → retry ≤ 3×, then escalate

**Layer 2 — Sub-spike failure**
- All critical tests pass → 🟢 green, next sub-spike
- 1-2 non-critical fails → 🟡 yellow, findings note, next sub-spike
- Critical test fails → 🔴 red, checkpoint halt, Kaan escalation
- > 30% test fail rate → 🔴 red, spike re-brainstorm may be needed

**Layer 3 — Spike 0 aggregate**
- 3 sub-spikes Green/Yellow → ✅ spike complete, proceed to Subproject 1
- 1 sub-spike Red → 🔴 reassess migration
- 2+ sub-spikes Red → 🔴 **migration abort**

### Failure response matrix

| Scenario | Outcome | Action | Next step |
|----------|---------|--------|-----------|
| S1 🔴: data loss in BlockNote WKWebView | Migration impossible | Immediate halt, Kaan alarm, findings note | Re-brainstorm: stay on Electron or alternative |
| S1 🟡: paste style loss etc. | Acceptable | Note + workaround | Continue to S2 |
| S2 🔴: B roundtrip fail | yrs unsuitable | Auto-fallback: A declared winner | Continue to S3; Subproject 5 designed on A |
| S2 🟡: B works but typing > 2× latency | yrs too slow as authoritative | Hybrid: yrs persistence-only | Continue to S3; Subproject 5 hybrid |
| S3 🔴: all DB options brittle | Rare | Halt, escalate | Manual debug; alternative crate (sqlx sync?) |
| S3 🟡: A struggles, B "good enough" | DB layer hybrid correct | Findings note | Subproject 2 designed on hybrid |
| Sub-agent stuck in test loop | Tooling issue | Retry 3×, then halt | Kaan manual intervention |
| Cargo build repeatedly fails | Environment/dep issue | Halt | Coordinator + Kaan build debug |
| pnpm-workspace.yaml change breaks other packages | Side effect | Immediate halt | Revert, restructure spike to bypass workspace |
| Kaan > 48h unresponsive | Kaan busy | Auto-pause | Await resume |
| Spike total > 7 days | Scope creep | Hard halt | Full re-brainstorm |

### Recovery from partial findings

If spike halts mid-stream:

- Completed sub-spike findings are **permanent commits** — not lost
- Example: S1 🟢, S2 🔴, S3 untouched:
  - S1 findings usable by Subproject 1 planning
  - S2 🔴 → CRDT architecture re-brainstormed
  - S3 → separate mini-spike (new spec + plan) later

### Accepted open risks

Carried forward to subprojects; mitigated post-spike:

1. macOS pass, Windows WebView2 fail (Win smoke subset is sampled, not
   exhaustive) — subproject 7 may surface regressions
2. Large-doc (100k+ char) performance — spike tests 10k; 100k tested in
   subproject 5 or 8 with real vault data
3. Linux WebKit2GTK full coverage — deferred; may require feature flag delay
   on Linux release
4. Long-running Yjs doc (1M+ updates over months) — compaction perf tested at
   1000 updates; production compaction schedule + monitoring mitigates
5. Tauri 2.x breaking changes mid-migration — `cargo update` smoke test per
   subproject
6. ywasm future viability — if observer incompatibility is fixed upstream,
   Prototype C may be reconsidered for CRDT single-engine win

### Migration abort scenarios

| Scenario | Outcome |
|----------|---------|
| A — individual solvable (e.g., S3 DB crate swap) | Continue spike, adjust subproject |
| B — serious but scoped (e.g., S2 🔴, yrs dropped) | Continue migration with reduced Rust-heavy ambition in CRDT |
| C — BlockNote WKWebView incompatible | **Abort migration**, stay on Electron |
| D — unexpected coalition (S1 🟡 + S2 🔴 + S3 🔴) | Reassess migration holistically |

In Scenario C, spike is still **successful** — saving 3.5 days vs discovering
the problem 6 weeks into migration.

## 9. Decision Registry

| Decision | Value | Locked via |
|----------|-------|-----------|
| Motivation | bundle + memory + perf (Rust OK) | Clarifying Q1 |
| Architecture | 8-subproject decomposition | Clarifying Q2 |
| Platform coverage | macOS full + Windows S1 smoke; Linux deferred | Clarifying Q3 (D) |
| Spike output model | Hybrid — code throwaway, artifacts keeper | Clarifying Q4 (C) |
| Execution model | Autonomous (writing-plans → executing-plans) | Clarifying Q5 (C) |
| Spike approach | Balanced (~3.5 days) | Approach selection |
| S2 prototype C (ywasm) | Rejected — observer API incompatible with yjs per y-crdt table | User-shared parity table analysis |
| Branch strategy | `spike/tauri-risk-discovery` via git worktree | Section 1 |
| Throwaway code dir | `spikes/tauri-risk-discovery/` | Section 1 |
| Keeper artifacts dir | `docs/spikes/tauri-risk-discovery/` | Section 1 |
| Sub-spike kill switch | 4 days wall time cap | Section 1 & 7 |
| Dispatch context passing | Later sub-agents read prior findings.md | Section 6 Q1 |
| Permission model | Sub-agent escalates pnpm/git/gh to coordinator | Section 6 Q2 |
| Worktree skill use | No `superpowers:using-git-worktrees` invocation; raw git commands | Section 6 Q3 |
| Final cleanup | PR-only, no auto-merge; await Kaan's explicit merge | Section 6 Q4 |
| Data loss response | Immediate halt + Kaan alarm | Section 7 defaults |
| Kaan response timeout | 48 hours → auto-pause | Section 7 defaults |
| BlockNote 🔴 response | Migration abort (no Chromium-fork investigation) | Section 7 defaults |

## 10. Open Questions & Deferred Items

Explicitly out of spike scope; tracked for subsequent phases:

- **Subproject 1 (Tauri skeleton):** What gets ported first — shell layout,
  routing, or feature modules? Brainstorm separately after spike.
- **Drizzle migration generation bug** — persists with B/C; revisit at
  Subproject 2 kickoff.
- **Huggingface transformers.js in webview** — embeddings pipeline may fail
  in WebKit; evaluated at Subproject 6.
- **keytar → Tauri Stronghold** — OS keychain Rust replacement; Subproject 3.
- **electron-updater → Tauri updater** — auto-update flow Subproject 7.
- **Existing Playwright E2E tests** — Tauri WebDriver setup differs from
  Electron; Subproject 8.
- **libsodium-wrappers-sumo vs sodium-native vs sodiumoxide (Rust)** — crypto
  API mapping Subproject 3.
- **Data migration Yjs → yrs (if Prototype B wins)** — can existing
  y-leveldb stored Y.Docs be read by yrs? S2 notes this; solved in Subproject 5
  or separate mini-spike.

## Appendix: Full Subproject Roadmap

Estimated post-spike sequence (times subject to adjustment based on spike
findings):

| # | Subproject | Estimate | Depends on |
|---|-----------|----------|------------|
| 1 | Tauri skeleton + renderer port | ~1 week | Spike 0 🟢 S1 |
| 2 | DB layer + basic CRUD | ~2 weeks | Spike 0 🟢 S3, Subproject 1 |
| 3 | Crypto + vault + keychain | ~1.5 weeks | Subproject 1 |
| 4 | Sync engine (HTTP + queue) | ~2 weeks | Subprojects 2 + 3 |
| 5 | CRDT layer (Yjs push/pull, seed) | ~1.5 weeks | Spike 0 🟢 S2, Subproject 4 |
| 6 | Search + embeddings + vector | ~1 week | Subproject 2 |
| 7 | Updater + packaging | ~1 week | Subprojects 1-6 |
| 8 | E2E migration + Electron decommission | ~1 week | Everything |

**Total estimated duration:** ~11 weeks post-spike.

---

*End of spec. Next step: `superpowers:writing-plans` produces the numbered
implementation plan for Spike 0.*

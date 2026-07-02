# Auto-update slow restart — investigation record

Status: **fixed at the structural level (2026-07-02): the app no longer ships
its full JS dependency tree loose. electron-vite now bundles every pure-JS
dependency into `out/`, and package.json `dependencies` is slimmed to the 10
native/unbundleable modules that must stay loose. Local `--dir` build:
5,208 sealed files (vs 33,410 in the installed 2026.702.2, vs 52,744
pre-icon-prune — −90% total), 526 MB on disk (vs 865 MB), zero dangling
symlinks, runtime-deps gate + packaged Electron native smoke green, desktop
main suite (3,291 tests) green, e2e smoke spec green against the bundled main.
See "The shipped fix" below. Earlier milestone: the `@tabler/icons` dead-dep
removal (52,744 → 33,410 files) was verified on the real signed 2026.702.2
release — Restart went 108 s → 75.5 s, confirming verify time is O(file
count). The dead-ends below remain dead — do not repeat them.**
Last updated: 2026-07-02.

Read this before touching the auto-update / packaging path again. It exists so
the same investigation isn't repeated and the same dead-end isn't re-shipped.

---

## TL;DR

- **Symptom:** on macOS, clicking **Restart** after a downloaded update takes
  **~2.5 min** before the app reopens. Goal was <10s.
- **Root cause:** macOS Squirrel/ShipIt code-signature-**verifies every sealed
  file in the bundle**, and the app ships `node_modules` loose. The bundle seals
  **~52,000 files**. Verify time is O(file count), and it runs **3× per update**:
  once **in-process** before the window closes (~30 s), once **pre-swap** in
  ShipIt (~60 s), once **post-swap** in ShipIt (~50 s).
- **The dominant file-count driver is NOT the ML deps** (an earlier version of
  this doc blamed them — wrong). Measured on the installed bundle, the ML deps
  are tiny by _file count_: `@huggingface` 272, `onnxruntime` 600, `sharp` 44.
  They are large in _bytes_ (download), but bytes ≠ verify cost. The real driver
  is **thousands of tiny-file packages**, led by **`@tabler/icons` (11,245 raw
  SVGs, ~21% of the whole bundle) — which is never imported at runtime** (only
  `@tabler/icons-react` is used, and it inlines its own SVGs). See "Prune" below.
- **The graceful-shutdown/cleanup path is NOT the bottleneck** (measured **12 ms**).
  Prior PRs (#570, #649) optimized that path on the assumption it was slow. It
  wasn't. **Do not re-optimize shutdown/cleanup for update speed.** The
  ">1 min to close the window" symptom is the **in-process verify** (~30 s), made
  worse by an `App Still Running` abort/retry race that re-verifies from scratch
  (see below) — neither is our cleanup code.
- **The obvious fix — pack `node_modules` into `app.asar` — DOES NOT WORK in
  this repo** and shipping it broke a release (PR #654 → reverted by #656).
  See "Dead-ends" below before trying it again.
- **<10s is not achievable** with Squirrel at this bundle size. Realistic wins
  come from shrinking the bundle, not from restructuring the installer.

---

## Root cause, with evidence

### Where the time goes (measured on a real 2026.701.x install)

| Phase                                                                         | Time       | Evidence                                                        |
| ----------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------- |
| Graceful cleanup (vault close, write-back flush)                              | **~12 ms** | `main.log`: `installing…` → `cleanup complete`                  |
| `autoUpdater.quitAndInstall` unzips 256 MB → 977 MB (old process still alive) | ~30 s      | `main.log` → ShipIt start                                       |
| ShipIt code-sign-**verifies the 977 MB bundle** before the swap               | ~63 s      | `ShipIt_stderr.log`: `Beginning installation` → `Moving bundle` |
| ShipIt swaps (a move, ~4 ms) + re-verifies the installed bundle               | ~50 s      | `ShipIt_stderr.log` → `launching`                               |
| Relaunch + cold boot                                                          | ~5 s       | `main.log` new process                                          |

The swap itself is instant (a directory move). The cost is **signature
verification**, which walks every file listed in `_CodeSignature/CodeResources`
(~21 MB of per-file hashes for this bundle). Fewer files ⇒ faster verify.

### Log locations (macOS)

- App log: `~/Library/Logs/@memry/desktop/main.log` — look for the `[Updater]`
  and `[Shutdown]` scopes.
- Squirrel installer log: `~/Library/Caches/com.memrynote.memry.ShipIt/ShipIt_stderr.log`
  — the authoritative source for install-phase timing.

### Bundle composition — by FILE COUNT (what verify actually costs)

Total sealed files in `Memrynote.app`: **52,744** (52,474 under `node_modules`).
Verify is O(file count), so the packages that ship the most _files_ dominate —
not the ones with the most _bytes_. Top offenders (`.pnpm` subtree file counts):

```
@tabler/icons          11,245 files  ← DEAD (removed 2026-07-02, see path 0)
@tabler/icons-react     6,157 files  ← ALSO DEAD: 0 source imports (icons use hugeicons via @/lib/icons)
es-toolkit              2,767 files
lucide-react            1,932 files
drizzle-orm             1,778 files
openai                  1,072 files
lodash                  1,051 files
chrono-node             1,003 files
shiki  (×3: 2.5.0/3.23.0/4.0.2 + langs)  ~700 each  ← triplicated; 2.5.0 leaks from vitepress (devDep)
--- for contrast, the doc's old ML suspects: ---
onnxruntime               600 files
@huggingface              272 files   (big in BYTES, negligible in FILE COUNT)
sharp                      44 files
```

### The `App Still Running` abort/retry race (secondary, doubles the worst case)

In a chained multi-version update, ShipIt can begin verifying, spend ~40 s, then
find a (relaunched) instance still running → `SQRLInstallerErrorDomain Code=-9`
→ abort and **re-verify the whole bundle from scratch** on retry. Real example
(`ShipIt_stderr.log`, 2026-07-01 08:29): verify 44 s → abort → retry at 08:30:44
→ verify again. No `app.relaunch()` in our code; looks like consecutive
auto-updates racing. Not hit on a single steady-state Restart, but it explains
the pathological ">2 min" cases. Fixing this doesn't speed the happy path — only
shrinking the file count does.

---

## The shipped fix (2026-07-02): dependencies-as-contract bundling

The 33,410-file bundle existed because electron-vite **externalizes everything
in package.json `dependencies` by default**, so `out/main` did runtime
`require('drizzle-orm')`, `require('openai')`, `require('metascraper')`, … and
the entire production dependency tree had to ship loose via `extraResources`.
Measured on the installed 2026.702.2 bundle: 33,144 of 33,148 Resources files
were `node_modules`, and the true natives accounted for only ~650 of them. The
other ~32,500 files were pure JS that Squirrel sealed and verified one by one.
(Claude/Codex/Slack-class Electron apps restart in 10–15 s because all their JS
lives inside `app.asar` — ONE sealed file.)

The fix inverts the contract instead of fighting electron-builder (dead-end #1):

- **package.json `dependencies` now contains ONLY the native/unbundleable
  modules** — `@huggingface/transformers` (pulls onnxruntime-node),
  `@mixmark-io/domino` (turndown's DOM parser, hard `require` in main),
  `better-sqlite3`, `jsdom`, `keytar`, `libsodium-wrappers-sumo` (UMD +
  inlined wasm, breaks under rollup CJS interop), `sharp`, `sqlite-vec`,
  `y-leveldb` (pulls classic-level), and `yjs` (must be a single instance —
  external y-leveldb resolves its yjs peer from the loose tree, so the main
  bundle must use the same copy or Y.Doc constructor checks break).
  electron-vite externalizes exactly these, and `pnpm deploy --prod` stages
  exactly these.
- **Everything else moved to `devDependencies`** and is bundled into `out/` by
  electron-vite (same treatment hugeicons/lucide-react already had). Renderer
  deps were always Vite-bundled; moving them out of `dependencies` stops pnpm
  deploy from shipping dead trees (shiki ×2 + 3 grammar packs ≈ 3,800 files,
  mermaid 670, es-toolkit 2,767, …).
- `src/main/runtime-dependencies.test.ts` asserts the exact `dependencies` set,
  and `scripts/check-packaged-runtime-deps.js` verifies each one resolves from
  the packaged loose tree. Adding a package to `dependencies` is now a
  conscious act that slows every user's Restart — the test makes it visible.
- `build-packaged-app.js` passes `-c.electronVersion=` explicitly: the slim
  staged tree no longer contains electron, so electron-builder can't infer the
  version from installed modules (the old fat deploy leaked electron into the
  staged tree — that's why the `'!electron'` extraResources filter existed).
- `ensure-native.sh` now invokes @electron/rebuild's CLI with node directly.
  `pnpm exec`'s pre-exec deps-status check can trigger
  `pnpm install --production`, which would prune devDependencies — and the
  entire build toolchain now lives there.

Verified locally (unsigned `--dir` build, recipe below): **5,208 sealed files**
(−84% vs 2026.702.2, −90% vs pre-prune), 526 MB (−340 MB, from de-duplicated
JS), 0 dangling symlinks, `check-packaged-runtime-deps.js` green including the
packaged-Electron native smoke, desktop main suite 3,291 tests green, full
typecheck green, and a real boot + Playwright e2e spec green against the
bundled `out/main`.

Expected restart impact, using the measured verify cost model from the two
same-day data points (≈0.64 ms/file + ≈7 s/865 MB of byte hashing):
~3.3 s file-term + ~4.3 s byte-term ≈ **8 s per verify pass** (was 28.5 s), so
click-Restart → new app should drop from **75.5 s to roughly 25–35 s**. Needs
confirmation on a real signed release. Sub-15 s additionally requires the byte
diet (lazy ML model/dylib download — path 1 below).

Gotchas found while shipping this (each found by BOOT-TESTING the bundle —
`MEMRY_FORCE_VAULT_PICKER=1 npx electron .` — not by the unit suite, which
stubs all of this; always boot-test after touching bundling):

- **CJS chunk-splitting breaks internally-circular packages.** First boot died
  with `zod._enum is not a function`: rollup had split zod v4's internally
  circular modules across shared chunks, and CJS chunk load order broke the
  cycle. Fixed with `output.manualChunks` = one chunk per npm package (intra-
  package cycles stay in one module scope; chunk count inside app.asar is free
  for codesign). If a future boot dies with a "X is not a function / undefined"
  inside a dep, suspect this class first.
- `@mixmark-io/domino` is a HARD runtime require: turndown calls it whenever
  `document` is undefined — always true in the main process. It must stay in
  `dependencies`. (Found by scanning `out/main` for residual bare requires.)
- `libsodium-wrappers-sumo` cannot be bundled (UMD + inlined wasm; rollup's
  CJS interop yields `undefined.ready` at boot) — stays in `dependencies`.
- `yjs` must stay external for instance identity: y-leveldb (external, native
  classic-level) resolves its own yjs peer from the loose tree; a second
  bundled copy triggers "Yjs was already imported" and breaks constructor
  checks across the CRDT stack.
- `re2` is required by @metascraper/helpers inside try/catch as an optional
  speedup; the repo intentionally never builds it (`allowBuilds: re2: false`
  in pnpm-workspace.yaml) and the shipped app never had a working re2 binary.
  It is listed in `rollupOptions.external` WITHOUT being shipped — the require
  throws and metascraper falls back to RegExp, exactly as before.
- `esprima` (js-yaml) and ajv's `require("ajv/dist/runtime/…")` strings in
  `out/` are not real runtime requires — the former is guarded, the latter are
  string literals emitted by ajv's standalone-code generator.

## Follow-ups worth doing (not yet implemented)

1. **ShipIt startup guard (kills the relaunch loop).** During the ShipIt
   window the app vanishes from the Dock; users relaunch the OLD app manually,
   which (a) makes ShipIt abort with `SQRLInstallerErrorDomain Code=-9` and
   re-verify from scratch, and (b) shows the update prompt again → download →
   Restart → loop. Fix: on startup, if a ShipIt install for our bundle is in
   flight (ShipIt process alive / fresh `ShipItState.plist` under
   `~/Library/Caches/com.memrynote.memry.ShipIt/`), show a small
   "Installing update…" window and exit instead of booting + re-prompting;
   ShipIt relaunches the new version itself when done. Independent of restart
   speed; cheap; do it next.
2. **Cleanup-timeout / mid-shutdown sync-runtime restart bug.** Measured on
   2026-07-02 16:35: clicking Restart during an in-flight fullSync re-pull made
   "stopping sync runtime" hang, and the sync runtime + capture server
   RESTARTED mid-shutdown (`main.log` 16:35:29.58 `Sync runtime started` after
   `stopping sync runtime`), until the 5 s watchdog fired
   `cleanup timed out; installing downloaded update anyway`. Costs a flat 5 s
   on the restart path and is a genuine lifecycle bug; find who re-arms the
   runtime during shutdown and gate it on the shutdown latch.

---

## Dead-ends — do NOT repeat these

### 1. Packing `node_modules` into `app.asar`

This is the intuitive fix (one sealed file instead of 40k → verify collapses).
**It cannot be done here with config alone.** Reason:

- electron-builder decides which `node_modules` to bundle via its **production-
  dependency collector**, not via the `files` glob. In this repo that collector
  **returns empty**, because:
  - it detects `resolvedPackageManager=npm` (falls back), and
  - the staged `package.json` (produced by `pnpm deploy`) carries `workspace:*`
    dependencies (e.g. `@memry/i18n`).
- So electron-builder packs **zero** `node_modules` into `app.asar`. That is
  _why_ the app ships `node_modules` loose via `extraResources` in
  `config/electron-builder.staged-local-mac.yml` — **the loose copy is
  load-bearing.** Remove it and you get a dependency-less app on all three
  platforms.

**PR #654** did exactly this (removed the loose copy, rewrote the runtime-deps
gate for asar). It merged, then **broke macOS release `2026.701.4`**
(`Missing unpacked native node_modules`). The mac gate caught it, so nothing
published. Reverted by **PR #656**.

### 2. `pnpm deploy --node-linker=hoisted` to make asar packing work

Tested locally. It **does** produce a clean flat tree (real top-level dirs,
`.pnpm` shrinks to ~240 KB). But electron-builder **still packs zero
node_modules** — the blocker is the collector, not the pnpm symlink layout.

### 3. `files: ['node_modules/**']` to force inclusion

Does not override the collector. electron-builder's node_modules handling is
separate from the `files` glob.

### 4. Re-optimizing shutdown/cleanup

Already 12 ms. There is nothing to win there. (This is what #570/#649 did.)

### 5. Excluding a package via the `extraResources` `filter` (dangling symlink)

Adding `- '!**/@tabler/icons/**'` to the `node_modules` filter (commit
`fc616a02`, both staged configs) **broke the signed macOS release** — both archs
failed at `codesign --deep --strict` (`No such file or directory`). Cause: pnpm
lays out `@tabler/icons-react/node_modules/@tabler/icons` as a **symlink** to the
`.pnpm` store copy. The filter glob `**/@tabler/icons/**` removes the store copy's
files but **not the symlink entry itself** (the entry has no path segment after
`icons/` to match), so the packaged bundle ships a dangling symlink. `codesign`
walks it and dies. Linux has no codesign → it passed, masking the problem on that
runner. **Reverted the config lines** (kept the corrected analysis). Lesson: never
drop a package that has an inbound symlink via a `filter` exclusion — prune the
staged tree instead and sweep broken symlinks (`find … -xtype l -delete`).

---

## Viable paths forward (ranked by effort vs. payoff)

0. **DONE (2026-07-02): remove dead icon deps from `package.json` — the clean
   version of the prune.** The earlier analysis assumed `@tabler/icons-react`
   was used; it is NOT — desktop icons go through hugeicons via
   `@/lib/icons/icon-map.ts`, and the only `tabler` match in source is Spanish
   `"tablero kanban"` in a locale file. So instead of pruning the staged tree:
   - deleted `@tabler/icons-react` from `dependencies` (removes it AND its
     11,245-file `@tabler/icons` dep from `pnpm deploy --prod`; no symlink left
     behind, Dead-end #5 cannot recur);
   - moved `lucide-react` to `devDependencies` (renderer-only, Vite bundles the
     ~12 icons used by shadcn/ui primitives — same treatment hugeicons already
     had; 1,932 loose files gone).
     Verified via the local `--dir` build recipe below: bundle file count
     **52,744 → 35,768 (−16,976, −32%)**, zero dangling symlinks, and
     `check-packaged-runtime-deps.js` resolves all natives. Expected restart
     impact: verify is O(file count), so ~99 s of verify should drop to ~67 s
     (total restart ~1m48s → roughly ~1m15s). Needs confirmation on a real signed
     release. Remaining candidates for the same treatment: dedupe `shiki`
     (3 versions; 2.5.0 leaks from the vitepress devDep), audit `es-toolkit`
     (2,767 files) — those DO need the staged-tree prune since they're real deps.
1. **Shrink the bytes (helps download, not verify).** ML/native deps
   (`@huggingface/transformers`, `onnxruntime-node`, `sharp`) are heavy in bytes
   but negligible in file count — lazy-downloading models cuts _download_ size,
   not verify time. Feature change; do it for bandwidth, not restart speed.
2. **Fix electron-builder's collector (uncertain).** Strip `workspace:*` from
   the staged `package.json` before packaging and/or force pnpm detection so the
   collector resolves deps and asar packing becomes possible. Deep, only
   verifiable via signed CI builds, no guarantee. If it works, ~30–45 s.

**Reality check:** sub-10s is not reachable with Squirrel.Mac at this size —
verification of a signed bundle is O(files × bytes) and lives inside Apple's
`Squirrel.framework`, not our code. Slack/VS Code/Notion all take 30–90 s for a
full auto-update swap.

---

## How to investigate again (tooling)

### Reproduce + measure

1. Note the wall-clock second you click **Restart**.
2. After it reopens, read `main.log` + `ShipIt_stderr.log` (paths above) and
   line up the timestamps against the phase table.

### Local packaged build to inspect the bundle (no CI needed)

```bash
# 1. Prod env is required by build-packaged-app.js (public URL, no secrets):
printf 'SYNC_SERVER_URL=https://sync.memrynote.com\n' > apps/desktop/.env.production

# 2. Unsigned --dir build (skip signing so you don't need certs), keep the stage dir:
cd apps/desktop
CSC_IDENTITY_AUTO_DISCOVERY=false MEMRY_KEEP_STAGED_PACKAGE_DIR=1 \
  node scripts/build-packaged-app.js --dir

# 3. Inspect whether node_modules landed in the asar:
APP=dist/mac-arm64/Memrynote.app/Contents/Resources
du -sh "$APP/app.asar"                                  # ~59M = code only (no deps)
npx @electron/asar list "$APP/app.asar" | grep -c '^/node_modules/'   # 0 = not packed

# 4. Clean up:
rm -f apps/desktop/.env.production
```

Gotchas:

- Local **signed** builds fail with `codesign: ambiguous` if the login keychain
  has a **duplicate** "Developer ID Application" cert — delete the dupe in
  Keychain Access, or use `CSC_IDENTITY_AUTO_DISCOVERY=false` for structural tests.
- The staged build dir is under `$TMPDIR/memry-desktop-package-*` and is removed
  on exit unless `MEMRY_KEEP_STAGED_PACKAGE_DIR=1`.

### Files that matter

- `apps/desktop/scripts/build-packaged-app.js` — stages the app, runs
  `pnpm deploy --legacy --prod`, rebuilds natives, invokes electron-builder.
- `apps/desktop/config/electron-builder.staged-local-mac.yml` — the release
  config (macOS); contains the load-bearing loose `node_modules` `extraResources`.
- `apps/desktop/scripts/check-packaged-runtime-deps.js` — the gate that catches a
  dep-less build. **macOS only** — Windows/Linux currently build unguarded, so a
  packaging regression there fails silently (worth fixing).
- `apps/desktop/src/main/updater.ts` + the `before-quit` handler in
  `apps/desktop/src/main/index.ts` — the restart→install flow (this part is fine;
  cleanup is 12 ms).

---

## Related PRs

- #570, #649 — restart/relaunch redesign. Fixed real bugs (install loop, install
  screen) but targeted the 12 ms cleanup path, not the actual bottleneck.
- #654 — pack node_modules into app.asar. **Reverted** (broke the release).
- #656 — the revert of #654.

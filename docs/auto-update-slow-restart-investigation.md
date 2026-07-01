# Auto-update slow restart — investigation record

Status: **root cause corrected (file COUNT, not ML bytes); first prune shipped
(`@tabler/icons`, ~21% of files); more file-count pruning available.**
Last updated: 2026-07-01.

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
@tabler/icons          11,245 files  ← DEAD: 0 runtime imports (only -react is used)
@tabler/icons-react     6,157 files  ← used
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

---

## Viable paths forward (ranked by effort vs. payoff)

0. **Prune tiny-file packages from the shipped tree (DONE for icons — best
   effort:payoff).** Verify is O(file count), so dropping a dead package that
   ships thousands of tiny files is a direct, risk-free win. Added
   `- '!**/@tabler/icons/**'` to the `node_modules` `extraResources` filter in
   `electron-builder.staged-local-mac.yml` + `electron-builder.staged.yml`
   (keeps `@tabler/icons-react`, which inlines its own SVGs). Drops **~11,245
   files (~21%)** off every one of the 3 verify passes. Next candidates: dedupe
   `shiki` (leaks 3 versions; 2.5.0 is a vitepress devDep that shouldn't be in
   the prod tree at all), and audit whether we need both `lucide-react` **and**
   `@tabler/icons-react`.
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

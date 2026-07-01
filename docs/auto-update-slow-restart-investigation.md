# Auto-update slow restart — investigation record

Status: **open problem, root cause understood, one big fix ruled out.**
Last updated: 2026-07-01.

Read this before touching the auto-update / packaging path again. It exists so
the same investigation isn't repeated and the same dead-end isn't re-shipped.

---

## TL;DR

- **Symptom:** on macOS, clicking **Restart** after a downloaded update takes
  **~2.5 min** before the app reopens. Goal was <10s.
- **Root cause:** macOS Squirrel/ShipIt code-signature-**verifies every sealed
  file in the bundle 2–3× at install time**, and the app ships **~641 MB of
  `node_modules` loose (~40,000 files)**. Verify time is O(file count). Total
  bundle is ~977 MB.
- **The graceful-shutdown/cleanup path is NOT the bottleneck** (measured **12 ms**).
  Prior PRs (#570, #649) optimized that path on the assumption it was slow. It
  wasn't. **Do not re-optimize shutdown/cleanup for update speed.**
- **The obvious fix — pack `node_modules` into `app.asar` — DOES NOT WORK in
  this repo** and shipping it broke a release (PR #654 → reverted by #656).
  See "Dead-ends" below before trying it again.
- **<10s is not achievable** with Squirrel at this bundle size. Realistic wins
  come from shrinking the bundle, not from restructuring the installer.

---

## Root cause, with evidence

### Where the time goes (measured on a real 2026.701.x install)

| Phase | Time | Evidence |
|---|---|---|
| Graceful cleanup (vault close, write-back flush) | **~12 ms** | `main.log`: `installing…` → `cleanup complete` |
| `autoUpdater.quitAndInstall` unzips 256 MB → 977 MB (old process still alive) | ~30 s | `main.log` → ShipIt start |
| ShipIt code-sign-**verifies the 977 MB bundle** before the swap | ~63 s | `ShipIt_stderr.log`: `Beginning installation` → `Moving bundle` |
| ShipIt swaps (a move, ~4 ms) + re-verifies the installed bundle | ~50 s | `ShipIt_stderr.log` → `launching` |
| Relaunch + cold boot | ~5 s | `main.log` new process |

The swap itself is instant (a directory move). The cost is **signature
verification**, which walks every file listed in `_CodeSignature/CodeResources`
(~21 MB of per-file hashes for this bundle). Fewer files ⇒ faster verify.

### Log locations (macOS)

- App log: `~/Library/Logs/@memry/desktop/main.log` — look for the `[Updater]`
  and `[Shutdown]` scopes.
- Squirrel installer log: `~/Library/Caches/com.memrynote.memry.ShipIt/ShipIt_stderr.log`
  — the authoritative source for install-phase timing.

### Bundle composition

```
Memrynote.app                       977 MB total
├─ Contents/Frameworks              255 MB  (Electron — normal, few large files)
└─ Contents/Resources
   ├─ app.asar                       59 MB  (our app code only — NO node_modules)
   └─ node_modules                  641 MB  (~40k LOOSE files) ← drives verify time
```

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
  *why* the app ships `node_modules` loose via `extraResources` in
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

1. **Shrink the 641 MB (best real win).** The bytes, not just the file count,
   matter for verify + download. Biggest contributors are ML/native deps
   (`@huggingface/transformers`, `onnxruntime-node`, `sharp`, `@emoji-mart/data`).
   Downloading some models on-demand instead of bundling could cut the app to
   ~400 MB and updates to roughly **60–90 s**. This is a feature change, not a
   build tweak.
2. **Prune the loose node_modules (safe, modest).** Drop non-runtime junk that
   leaks into the shipped tree (`@cloudflare/workers-types` ~9.5 MB is a
   types-only devDep; also non-macOS prebuilds, docs, source maps). Keeps the
   working architecture. Expected ~641 MB → ~450 MB, roughly **~110 s**.
3. **Fix electron-builder's collector (uncertain).** Strip `workspace:*` from
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

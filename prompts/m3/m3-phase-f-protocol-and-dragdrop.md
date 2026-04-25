# M3 Phase F — Protocol + Drag-Drop Spike (memry-file:// + drag-drop event)

Temiz session prompt. Verification + manuel smoke driven phase. Bu phase Electron'un `memry-file://` ve `File.path` sürümlerinin Tauri replacement'ı.

---

## PROMPT START

You are implementing **Phase F of Milestone M3** for Memry's Electron→Tauri migration. This phase lands two desktop-app integrations that the spec calls out as M3 cross-cutting deliverables: (1) the `memry-file://` custom URI scheme protocol handler — a vault-allowlisted, byte-range-aware, missing-image-fallback file server that replaces Electron's `protocol.registerFileProtocol`; (2) a documented drag-drop path-resolution spike that proves Tauri 2 + macOS WebKit deliver real `/Users/...` paths on file drop, replacing Electron's `webUtils.getPathForFile`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3`
**Branch:** `m3/vault-fs-and-watcher`
**Plan:** `docs/superpowers/plans/2026-04-26-m3-vault-fs-and-watcher.md`
**Spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`
**Prompts README:** `prompts/m3/README.md`

Phase A-E landed deps + paths + fs/frontmatter/notes_io + preferences/registry + watcher + state/AppState + 23 commands (78 tests, 18 commands). Phase F adds the URI scheme protocol handler in `lib.rs::run` and subscribes to the main window's drag-drop event. The drag-drop spike emits a renderer console log so manual verification can prove paths come through. Phase G removes the spike telemetry once the smoke is documented in `scripts/drag-drop-smoke.md`.

### Prerequisite verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
git rev-parse --abbrev-ref HEAD                        # expect: m3/vault-fs-and-watcher

# Phase E complete
test -f apps/desktop-tauri/src-tauri/src/commands/vault.rs
test -f apps/desktop-tauri/src-tauri/src/commands/shell.rs
test -f apps/desktop-tauri/src-tauri/src/commands/dialog.rs
[ "$(wc -l < apps/desktop-tauri/src-tauri/src/commands/vault.rs)" -gt 250 ]
grep -q 'tauri_plugin_dialog::init' apps/desktop-tauri/src-tauri/src/lib.rs
grep -q 'commands::vault::vault_open' apps/desktop-tauri/src-tauri/src/lib.rs

# Tests still green
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
pnpm --filter @memry/desktop-tauri capability:check
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -3
# expect: ~78 passed (no delta from Phase D; Phase E added no tests)

cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
git log --oneline | grep -cE 'm3\(commands\)'   # expect ≥ 2

# Scratch test vault has at least one image (we'll smoke it later)
ls ~/memry-test-vault-m3/attachments/images/ 2>/dev/null || mkdir -p ~/memry-test-vault-m3/attachments/images/
```

If any fails, STOP. Phase E must complete before Phase F starts.

### Your scope

Execute **Tasks 13, 14** from the plan in this order.

- **Task 13 — `memry-file://` URI scheme handler**:
  - Step 13.1: update `tauri.conf.json` `app.security.csp` to add `memry-file:` to `default-src`, `img-src`, and `media-src`. Plan provides the exact CSP string.
  - Step 13.2: add `urlencoding = "2.1"` to `Cargo.toml` `[dependencies]`.
  - Step 13.3: implement the protocol handler in `lib.rs`:
    - `.register_uri_scheme_protocol("memry-file", |ctx, request| { handle_memry_file(&ctx.app_handle().clone(), &request) })` — added to the Builder chain after `.plugin(tauri_plugin_dialog::init())`.
    - `handle_memry_file(app, request)` function: parse `memry-file://local/<absolute path>` URL → percent-decode → canonicalize → check vault-root + app-data-dir allowlist → 403 if outside → read bytes → MIME-guess → handle `Range:` header for partial content (206) → return 200 with full bytes otherwise.
    - `missing(path)` fallback: if the path looks like an image (.png/.jpg/.jpeg/.gif/.webp), return 200 + `image/png` + a 1×1 transparent PNG. Otherwise return 404.
    - `parse_range(header_value, total)` helper.
    - `base64_decode_static(input)` for the embedded 1×1 PNG.
  - Step 13.4: create `apps/desktop-tauri/src/lib/memry-file.ts` with `toMemryFileUrl(absolutePath)` and `fromMemryFileUrl(url)` helpers.
  - Step 13.5: manual smoke — drop a real image in the scratch vault, build dev mode, verify image loads, missing image returns 1×1 PNG, outside-vault path returns 403.
  - Step 13.7: commit `m3(protocol): memry-file:// URI scheme with byte-range + missing-image fallback`.

- **Task 14 — Drag-drop path-resolution spike**:
  - Step 14.1: confirm `core:default` includes file-drop event grants. Inspect `gen/schemas/desktop-schema.json` for `dragDropEvent` / `drop` references. Add `core:webview:allow-on-drag-drop-event` to `capabilities/default.json` if absent.
  - Step 14.2: subscribe to the main window's `WindowEvent::DragDrop` in `lib.rs::run`'s `.setup(...)` closure. On `DragDropEvent::Drop { paths, .. }`, emit `vault-drag-drop` event to the renderer with `Vec<String>` (paths converted via `to_string_lossy().into_owned()`).
  - Step 14.3: temporary spike telemetry in `apps/desktop-tauri/src/main.tsx` — `listen<string[]>('vault-drag-drop', (event) => console.info('[drag-drop spike] paths:', event.payload))`. This block is REMOVED in Phase G Task 16.5; here we just add it.
  - Step 14.4: manual smoke — `pnpm dev`, drag image/PDF/video into the window, verify dev console logs real `/Users/...` paths. If you see `webkit-fake-url://`, the smoke is 🔴 — document the fallback to `dialog_choose_files`.
  - Step 14.5: create `apps/desktop-tauri/scripts/drag-drop-smoke.md` documenting the smoke, outcomes table, and last-verified date/version.
  - Step 14.6: commit `m3(spike): drag-drop path resolution + documented fallback to dialog picker`.

### Methodology — verification + manual smoke

1. **Invoke `superpowers:using-superpowers`** first. No TDD this phase — protocol handlers and window events aren't unit-testable cleanly.
2. **Two commits — one per task.**
3. For Task 13:
   - Step 13.1: edit `tauri.conf.json` CSP.
   - Step 13.2: add `urlencoding` dep.
   - Step 13.3: paste the protocol handler verbatim from plan (lines ~3762–3927). The handler is ~165 lines. Note that `register_uri_scheme_protocol`'s callback signature requires moving `app` into the closure carefully — the plan's exact pattern uses `let app = ctx.app_handle().clone();` then passes `&app` to `handle_memry_file`.
   - Step 13.4: create `memry-file.ts` helper.
   - Step 13.5: manual smoke with a real image drop test.
   - Step 13.7: commit.
4. For Task 14:
   - Step 14.1: capability inspection (read-only `grep`).
   - Step 14.2: edit `lib.rs::run` to subscribe to drag-drop. Plan provides the exact closure pattern using `WindowEvent::DragDrop` + `DragDropEvent::Drop { paths, .. }`.
   - Step 14.3: edit `main.tsx` — add the temporary `listen` call.
   - Step 14.4: manual smoke. Capture the console output for the PR body.
   - Step 14.5: write `scripts/drag-drop-smoke.md` per plan template.
   - Step 14.6: commit.

### Critical gotchas

1. **CSP regression risk:** `tauri.conf.json::app.security.csp` already has the M2 baseline. Plan Step 13.1 modifies ONLY the `default-src`, `img-src`, and `media-src` directives — adding `memry-file:` to each. Other directives (`script-src`, `style-src`, `frame-src`, `font-src`, `worker-src`, `connect-src`) MUST be preserved verbatim. Re-read the plan's CSP string and diff against the current file before saving.
2. **`withGlobalTauri` doesn't matter for protocols:** Plan's draft mentions `"withGlobalTauri": false` but in Tauri 2 the URI scheme registration happens via `register_uri_scheme_protocol` in `lib.rs::run`, not in conf JSON. Plan corrects this in the same step ("wait, in Tauri 2 ..."). Don't add `withGlobalTauri` to conf.
3. **Path canonicalization is critical for the allowlist:** `dunce::canonicalize(&path)` BEFORE the `starts_with` allowlist check. Without canonicalization, `memry-file://local/Users/me/memry-test-vault-m3/../../../etc/passwd` would slip through the prefix check. The canonicalize resolves `..` and any symlinks first.
4. **Allowlist roots:** Vault root (from `state.vault.current_path()`) AND app-data dir (`directories::ProjectDirs::from(...).data_dir()`). The app-data inclusion is for future thumbnails / cached attachments. Don't drop it.
5. **`missing` fallback ONLY for images:** Plan's `missing` function checks the URL extension. `.png/.jpg/.jpeg/.gif/.webp` → 1×1 transparent PNG (so `<img>` tags don't break-icon). Other types → 404. Don't expand to PDFs or video — those have proper UI fallbacks.
6. **`parse_range` saturating bounds:** Plan's impl uses `total.saturating_sub(1)` for the empty-end case (`Range: bytes=100-`). Don't use `total - 1` — would underflow if `total == 0`.
7. **`base64_decode_static` is hand-rolled:** Plan implements base64 inline because adding `base64` crate just for the 100-byte 1×1 PNG is overkill. Don't replace with `base64::decode(...)` — that's an unnecessary dep.
8. **`urlencoding` dep is needed:** Plan Step 13.3 uses `urlencoding::decode(p)` for percent-decoded paths. Without `urlencoding = "2.1"` in `Cargo.toml`, `cargo check` fails. Step 13.2 adds it.
9. **`memry-file.ts` `replace(/^\/+/, '')`:** The Tauri URI scheme handler reconstructs the absolute path as `/${decoded}`. So `toMemryFileUrl` strips leading slashes from the input first — `/Users/.../foo.png` → `Users/.../foo.png` → URL = `memry-file://local/Users/.../foo.png`. Don't double-slash.
10. **`encodeURI` not `encodeURIComponent`:** `toMemryFileUrl` uses `encodeURI` to preserve `/` in path segments. `encodeURIComponent` would percent-encode the slashes and break the path on the Rust side.
11. **`fromMemryFileUrl` decoder:** Mirrors `toMemryFileUrl` — strip the `memry-file://local/` prefix, `decodeURIComponent` the rest, prepend `/`. Used for renderer-side display logic if a route shows the original path.
12. **Drag-drop event signature:** Tauri 2 `WindowEvent::DragDrop` wraps `DragDropEvent` which has variants `Enter`, `Over`, `Drop`, `Leave`. The plan only handles `Drop { paths, .. }`. The `paths` field is `Vec<PathBuf>`. The closure must `iter().map(|p| p.to_string_lossy().into_owned()).collect()` to produce `Vec<String>` for the event payload — Tauri's `Emitter` serializes via Serde.
13. **`anyhow` dep already in Cargo.toml or not:** Plan Step 14.2's closure body uses `anyhow::anyhow!("main window missing")`. If `anyhow` isn't already a dep, add `anyhow = "1"`. Spike-only usage; remove if you can refactor without it (e.g., use `eyre` or just `Box::<dyn Error>::from(...)` directly). Plan's note: "Add `anyhow = \"1\"` to `[dependencies]` if not already present."
14. **Drag-drop spike telemetry must be REMOVED in Phase G:** The `void listen<string[]>('vault-drag-drop', ...)` block in `main.tsx` is a one-shot verification import. Phase G Task 16.5 deletes it. Phase F adds it; Phase G removes it. Don't preemptively delete it here.
15. **`scripts/drag-drop-smoke.md` is a **plain markdown** file:** Plan Step 14.5 supplies the exact template. Fill in `<date>` and `<macOS ver>` after running the smoke. Don't include the dev console image / video — markdown text only.
16. **Capability schema changes are surfaced in `desktop-schema.json`:** Plan Step 14.1 says inspect the schema for `dragDropEvent`. The Tauri 2 default capability set usually grants this; verify before adding. Adding redundant grants is fine but `capability:check` may flag duplicates.
17. **Manual smoke is REQUIRED, not optional:** Phase F's correctness depends on macOS-specific behaviors (FSEvents-rooted protocol handling, WebKit drop event delivery). Run the smokes; record output. Phase G's PR body includes the smoke results — don't skip.

### Constraints

- **No scope creep:** Do not regenerate Specta bindings, swap mock IPC, run the e2e suite, or open a PR in Phase F. Phase G handles all of that.
- **No vault module changes:** `vault::*` is FROZEN. Phase F only touches `lib.rs`, `tauri.conf.json`, `Cargo.toml`, `capabilities/default.json`, and renderer `main.tsx` + new `lib/memry-file.ts`.
- **No new commands:** The protocol handler is NOT a Tauri command — it's a URI scheme handler registered on the Builder. Don't `#[tauri::command]` it.
- **No behavior changes to existing commands:** `vault_open` may need to coexist with the protocol handler reading the current vault path; verify the lock semantics still hold (`state.vault.current_path()` is a brief lock, fine to call from the protocol thread).
- **No expanded CSP beyond `memry-file:`:** Don't add `https://*.cdn.com` or any third-party origin. The CSP narrowing is part of the security review.
- **No new tests:** Phase F adds no Rust integration tests. Manual smoke is the verification method; Phase G's runtime e2e covers `vault_*` paths but not the protocol handler.

### Acceptance criteria (Phase F done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3

# Files modified
grep -q 'memry-file:' apps/desktop-tauri/src-tauri/tauri.conf.json
grep -q 'register_uri_scheme_protocol' apps/desktop-tauri/src-tauri/src/lib.rs
grep -q 'fn handle_memry_file' apps/desktop-tauri/src-tauri/src/lib.rs
grep -q 'fn missing' apps/desktop-tauri/src-tauri/src/lib.rs
grep -q 'fn parse_range' apps/desktop-tauri/src-tauri/src/lib.rs
grep -q 'fn base64_decode_static' apps/desktop-tauri/src-tauri/src/lib.rs

# urlencoding dep
grep -q '^urlencoding' apps/desktop-tauri/src-tauri/Cargo.toml

# memry-file.ts helper
test -f apps/desktop-tauri/src/lib/memry-file.ts
grep -q 'toMemryFileUrl' apps/desktop-tauri/src/lib/memry-file.ts
grep -q 'fromMemryFileUrl' apps/desktop-tauri/src/lib/memry-file.ts

# Drag-drop wiring
grep -q 'vault-drag-drop' apps/desktop-tauri/src-tauri/src/lib.rs
grep -q 'DragDrop' apps/desktop-tauri/src-tauri/src/lib.rs
grep -q "vault-drag-drop" apps/desktop-tauri/src/main.tsx
grep -q "drag-drop spike" apps/desktop-tauri/src/main.tsx

# Spike documentation
test -f apps/desktop-tauri/scripts/drag-drop-smoke.md
[ "$(wc -l < apps/desktop-tauri/scripts/drag-drop-smoke.md)" -gt 5 ]

# Rust hygiene
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri typecheck

# All prior tests still green
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -3
# expect: ~78 passed

# Manual smoke evidence — capture in user report
# 1. Real image at `~/memry-test-vault-m3/attachments/images/test.png` loads via memry-file://
# 2. Missing image at `notes/missing.png` returns 1×1 transparent PNG (no broken-image icon)
# 3. Outside-vault path `/etc/hosts` returns 403
# 4. Drag image+pdf+mp4 from Finder into window — dev console logs real `/Users/...` paths

# Commits
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
git log --oneline | grep -cE 'm3\((protocol|spike)\)'   # expect ≥ 2

# Electron / packages / specs / plans untouched
git diff --name-only main..HEAD -- apps/desktop/ apps/sync-server/ packages/ docs/superpowers/specs/ docs/superpowers/plans/ | wc -l
# expect 0
```

### When done

Report to user (include manual smoke results):

```
Phase F complete.
Tasks covered: 13, 14
Commits: 2 (<first_hash>..<last_hash>)
Rust tests: 0 new — total still ~78 passed
Verification:
  - cargo check: clean
  - cargo clippy -- -D warnings: clean
  - capability:check: clean
  - typecheck: clean
  - cargo test --features test-helpers: 78 passed, 0 failed

Manual smoke (memry-file://):
  - real image renders: 🟢
  - missing image → 1×1 PNG fallback: 🟢
  - outside-vault path → 403: 🟢

Manual smoke (drag-drop):
  - drop image+pdf+mp4 from Finder → real paths: 🟢 (or 🔴 fallback documented)

Documents:
  - apps/desktop-tauri/scripts/drag-drop-smoke.md: ✓ filled with date <YYYY-MM-DD> and macOS <version>

Spike telemetry:
  - main.tsx still has the temporary `listen('vault-drag-drop', ...)` block (Phase G Task 16.5 removes it)

Electron/packages/specs/plans untouched: 0 files

Next: Phase G — prompts/m3/m3-phase-g-bindings-renderer-bench-pr.md
Blockers: <none | list>
```

If blocker:
- Image fails to load via `memry-file://` → check the CSP `img-src` includes `memry-file:`. Open DevTools > Network and verify the response status. 403 means allowlist mismatch — `state.vault.current_path()` returned `None` (vault not open) or the path is outside the canonicalized vault root.
- 1×1 PNG fallback fails → `base64_decode_static` returned wrong bytes. The hardcoded base64 string in plan Step 13.3's `missing` function decodes to a valid 67-byte transparent PNG. Verify by decoding manually: `echo "iVBORw0KG..." | base64 -d | file -` should report `PNG image data, 1 x 1`.
- Drop event delivers `webkit-fake-url://` instead of real paths → expected on older macOS WebKit; **don't fail Phase F**. Document the 🔴 outcome in `drag-drop-smoke.md` and Phase G's M8 file-import work uses `dialog_choose_files` as the canonical fallback (already implemented in Phase E).
- `register_uri_scheme_protocol` signature mismatch → Tauri 2's protocol handler closure signature changes between minor versions. The plan targets Tauri 2.10. Check `apps/desktop-tauri/src-tauri/Cargo.toml` for the Tauri version. If you're on a newer minor, the signature might be `|ctx, request, responder|` — in that case, call `responder.respond(response)` instead of returning the response.
- `capability:check` fails after drag-drop change → ensure `capabilities/default.json` keeps the JSON structure valid; missing comma is the usual culprit.

If still blocked: invoke `superpowers:systematic-debugging`. Report + wait for approval.

### Ready

1. Invoke `superpowers:using-superpowers`.
2. Read plan Tasks 13, 14 fully (lines ~3735–4108 of the plan file).
3. Run prerequisite verification. Report results.
4. Task 13:
   - Update `tauri.conf.json` CSP.
   - Add `urlencoding` dep.
   - Paste protocol handler in `lib.rs` (handle_memry_file + missing + parse_range + base64_decode_static).
   - Add `register_uri_scheme_protocol("memry-file", ...)` to Builder chain.
   - Create `apps/desktop-tauri/src/lib/memry-file.ts`.
   - Manual smoke: real image renders, missing image returns 1×1 PNG, outside-vault returns 403.
   - Commit `m3(protocol): memry-file:// URI scheme with byte-range + missing-image fallback`.
5. Task 14:
   - Inspect/grant drag-drop capability.
   - Subscribe to `WindowEvent::DragDrop` in `lib.rs::run::setup` and emit `vault-drag-drop` event.
   - Add temporary `listen` block in `main.tsx`.
   - Add `anyhow = "1"` if not present.
   - Manual smoke: drop files into window, verify console output.
   - Create `scripts/drag-drop-smoke.md` documenting outcomes table + verification date.
   - Commit `m3(spike): drag-drop path resolution + documented fallback to dialog picker`.

## PROMPT END

# M3 Phase G — Bindings + Renderer Mock-Swap + Runtime e2e + Bench + PR

Temiz session prompt. Bu phase M3'ün son halkası: Specta bindings regen, mock'tan gerçek invoke'a swap, runtime e2e smoke, 100-note bench, acceptance gate, PR open. M3 closure phase.

---

## PROMPT START

You are implementing **Phase G of Milestone M3** for Memry's Electron→Tauri migration. This is the closing phase: regenerate Specta TypeScript bindings to expose every M3 type and command, swap the renderer's mock IPC routes to real Rust for the 22 M3 commands (keeping `vault_reindex` and `vault_create` as documented deferrals), add a runtime e2e Playwright smoke that exercises `vault_open` / `vault_list_notes` / `vault_read_note` / `vault_write_note` end-to-end, write the 100-note `<500ms` performance bench, run the full acceptance gate, push the branch, and open the M3 PR.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3`
**Branch:** `m3/vault-fs-and-watcher`
**Plan:** `docs/superpowers/plans/2026-04-26-m3-vault-fs-and-watcher.md`
**Spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`
**Prompts README:** `prompts/m3/README.md`

Phase A-F landed deps + paths + fs/frontmatter/notes_io + preferences/registry + watcher + state/AppState + 23 commands + memry-file:// + drag-drop spike (78 vault tests, 18 commands, 1 protocol handler). Phase G shows that work to the renderer, runs a runtime e2e smoke, proves the 100-note bench, removes the spike telemetry, and ships the PR.

### Prerequisite verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
git rev-parse --abbrev-ref HEAD                        # expect: m3/vault-fs-and-watcher

# Phase F complete
grep -q 'register_uri_scheme_protocol' apps/desktop-tauri/src-tauri/src/lib.rs
grep -q 'fn handle_memry_file' apps/desktop-tauri/src-tauri/src/lib.rs
grep -q 'vault-drag-drop' apps/desktop-tauri/src-tauri/src/lib.rs
test -f apps/desktop-tauri/src/lib/memry-file.ts
test -f apps/desktop-tauri/scripts/drag-drop-smoke.md
grep -q 'memry-file:' apps/desktop-tauri/src-tauri/tauri.conf.json
grep -q 'drag-drop spike' apps/desktop-tauri/src/main.tsx   # spike telemetry still present

# Tests still green
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri typecheck
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -3
# expect: ~78 passed

cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
git log --oneline | grep -cE 'm3\((deps|vault|commands|protocol|spike)\)'   # expect ≥ 13

# Scratch test vault exists for runtime e2e (used by M3_TEST_VAULT_PATH)
test -d ~/memry-test-vault-m3
```

If any fails, STOP. Phase F must complete before Phase G starts.

### Your scope

Execute **Tasks 15, 16** from the plan in this order.

- **Task 15 — Bindings regen + mock-swap + renderer integration**:
  - Step 15.1: extend `apps/desktop-tauri/src-tauri/src/bin/generate_bindings.rs` per plan. Add 23 commands to `collect_commands![...]` and 13+ vault `.typ::<...>()` calls. Plan's exact list lives at lines ~4126–4185.
  - Step 15.2: regen + verify with `pnpm --filter @memry/desktop-tauri bindings:generate && pnpm --filter @memry/desktop-tauri bindings:check`.
  - Step 15.3: extend `realCommands` Set in `apps/desktop-tauri/src/lib/ipc/invoke.ts` to include the 22 M3 commands (vault_open, vault_close, vault_get_status, vault_get_current, vault_get_all, vault_switch, vault_remove, vault_get_config, vault_update_config, vault_list_notes, vault_read_note, vault_write_note, vault_delete_note, vault_reveal, shell_open_url, shell_open_path, shell_reveal_in_finder, dialog_choose_folder, dialog_choose_files) **plus M2 carry-over** (settings_get/set/list). NOTE: `vault_reindex` stays mocked (M7 deferral).
  - Step 15.4: trim `apps/desktop-tauri/src/lib/ipc/mocks/vault.ts` to keep ONLY `vault_reindex` (M7 stub) and `vault_create` (M5 onboarding deferral). Delete every other vault route. Update `mocks/index.ts` if it imports deleted route names.
  - Step 15.5: verify `apps/desktop-tauri/src/services/vault-service.ts` shape — `createInvokeForwarder<VaultClientAPI>('vault')` maps `getStatus` → `vault_get_status`. Plan's note: Rust impls match the existing renderer expectations, so no service-layer change should be required. If `pnpm test` flags shape diff, adjust the forwarder mapping.
  - Step 15.6: create `apps/desktop-tauri/e2e/specs/m3-vault-smoke.spec.ts` per plan — two runtime tests: open vault + list notes + read+write Turkish-character roundtrip. Use `M3_TEST_VAULT_PATH` env (defaults to `~/memry-test-vault-m3`).
  - Step 15.7: run full check matrix (lint/typecheck/test/bindings:check/capability:check/port:audit/command:parity/cargo:check/cargo:clippy/cargo:test).
  - Step 15.8: update `apps/desktop-tauri/scripts/command-parity-audit.ts` ledger to classify `vault_reindex` as `deferred:M7` and `vault_create` as `mocked:M5`.
  - Step 15.9: commit `m3(renderer): swap vault_*/shell_*/dialog_* to real Rust + runtime e2e smoke`.

- **Task 16 — Bench, acceptance gate, PR**:
  - Step 16.1: write `apps/desktop-tauri/src-tauri/tests/vault_bench.rs` per plan — 100-note vault scan, `<500ms` assertion, release-build required. Register `[[test]] name = "vault_bench" required-features = ["test-helpers"]`.
  - Step 16.2: run bench in release mode: `cargo test --release --features test-helpers --test vault_bench -- --nocapture`. Local Apple-silicon target `<80ms`; acceptance gate `<500ms`.
  - Step 16.3: full final acceptance gate verification — every command from plan Step 16.3 exits 0. Runs lint, typecheck, test, bindings:check, capability:check, port:audit, command:parity, cargo:check, cargo:clippy, cargo:test, plus a manual cold-start smoke against the dev runtime.
  - Step 16.4: count Rust tests — expect ~79 (28 M2 + 9 paths + 9 fs + 9 frontmatter + 5 notes_io + 8 prefs + 6 registry + 4 watcher + 1 bench).
  - Step 16.5: REMOVE the drag-drop spike telemetry from `apps/desktop-tauri/src/main.tsx` (the `void listen<string[]>('vault-drag-drop', ...)` block added in Phase F Task 14.3). Commit `m3(spike): remove drag-drop spike telemetry; smoke documented in scripts/drag-drop-smoke.md`.
  - Step 16.6: push branch + open PR. Title: `m3: Vault FS + file watcher`. Body per plan template (lines ~4533–4585) — Summary, Acceptance gate (10 checkboxes), Carry-forward ledger, Test plan, Risk coverage.
  - Step 16.7: do NOT merge. User owns the merge decision (typically via `/land-and-deploy` gstack skill).

### Methodology — verification + atomic commits

1. **Invoke `superpowers:using-superpowers`** first. For Step 16.1 (bench), invoke `superpowers:test-driven-development` because the bench IS the test (RED-GREEN — write failing assertion, measure, prove green). For Task 16.6 (PR open), optionally invoke `superpowers:finishing-a-development-branch`.
2. **Three commits expected:** Task 15 = 1 commit, Task 16 bench = 1 commit, Task 16 spike-removal = 1 commit. PR open = no new commit.
3. For Task 15:
   - Step 15.1: edit `generate_bindings.rs` — add `use memry_desktop_tauri_lib::vault;` to imports, then extend `collect_commands![...]` macro with 23 entries and `.typ::<...>()` chain with 13+ vault types. Plan's exact listing is your source of truth.
   - Step 15.2: regen → `pnpm bindings:generate`. Inspect `apps/desktop-tauri/src/generated/bindings.ts` — every M3 type and command should appear.
   - Step 15.3-15.4: edit `invoke.ts` (real-commands Set) and `mocks/vault.ts` (trim).
   - Step 15.5: run `pnpm test` to verify service layer.
   - Step 15.6: write the e2e spec.
   - Step 15.7: run the full check matrix. Fix any failure before commit.
   - Step 15.8: update parity ledger.
   - Step 15.9: ONE atomic commit covering bindings + invoke.ts + mocks + service + e2e + parity-audit. The commit message hints at scope: "swap ... to real Rust + runtime e2e smoke".
4. For Task 16:
   - Step 16.1-16.2: bench RED-GREEN. Write the test → run → assertion either passes or you have a real perf problem. Plan provides the exact 100-note seed loop.
   - Step 16.3: final gate — every command must exit 0. ANY failure = stop, fix, re-run.
   - Step 16.4: spot-check test counts.
   - Step 16.5: remove spike telemetry from `main.tsx`. Commit.
   - Step 16.6: push + PR. Use `gh pr create` with HEREDOC body. Do NOT merge.

### Critical gotchas

1. **`generate_bindings.rs` Specta type ordering:** Order matters for diff stability. Plan lists types alphabetically by module path: `db::*` first (carry-over from M2), then `vault::*`. Don't reorder; bindings.ts diff would be unnecessarily noisy.
2. **`bindings:check` is the post-regen guard:** It re-runs the generator and diffs against the committed `bindings.ts`. If the generator output differs (e.g., a Specta proc-macro changed a field name), `bindings:check` fails. The fix is `pnpm bindings:generate` again, then commit the regenerated file.
3. **`realCommands` Set ordering:** TypeScript Sets preserve insertion order. Plan's order matches the bindings file ordering — keep it for diff stability. The `realCommands` Set is consulted at runtime to decide whether to invoke the real backend or the mock.
4. **`vault_reindex` is NOT in `realCommands`:** It stays mocked because the Rust impl is just a stub returning `{ deferredUntil: 'M7' }`. If you accidentally add it to `realCommands`, the renderer's settings UI will see the stubbed payload instead of the mock's no-op success — both are fine in M3 but the parity ledger expects mocked.
5. **`vault_create` legacy mock:** The Rust side has no `vault_create` command. The renderer's onboarding flow uses `dialog_choose_folder` + `vault_open` directly. The `vault_create` mock route stays alive ONLY because the legacy onboarding component still references it; M5 removes the component during the notes-CRUD refactor. Phase G must NOT add a Rust `vault_create` — the parity ledger flags it as `mocked:M5`.
6. **`mocks/index.ts` imports may break after trimming:** When you delete `vault_open` etc. from `mocks/vault.ts`, the named export from `mocks/index.ts` (if it re-exports) loses those names. Run `pnpm typecheck` after trim — TypeScript will surface every dangling import. Fix them by removing the re-exports or routing through the now-trimmed module.
7. **Service forwarder shape match:** `vault-service.ts` uses `createInvokeForwarder<VaultClientAPI>('vault')` which builds command names from the method names (`getStatus` → `vault_get_status`). The Rust commands match — but the forwarder might pass args under different keys. Plan Step 15.5: don't preemptively change anything; run `pnpm test` and only adjust if a failure surfaces.
8. **`m3-vault-smoke.spec.ts` is runtime-lane:** It requires the Tauri dev runtime, not the M1 mock-lane Vite WebKit harness. Plan Step 15.6 says "If `playwright.config.ts` does not yet have a runtime-lane target, follow the comment in `e2e/playwright.config.ts` that documents the harness — for M3 it is acceptable to gate the suite behind `M3_TEST_VAULT_PATH` so CI does not run it without a vault checkout." Read the existing config; if there's no runtime lane, the M3 spec runs as a gated dev-only check.
9. **`M3_TEST_VAULT_PATH` env:** Defaults to `~/memry-test-vault-m3`. The README created this directory in pre-flight. The e2e spec uses `process.env.M3_TEST_VAULT_PATH ?? \`${process.env.HOME}/memry-test-vault-m3\`` so dev runs without env work.
10. **Bench must run with `--release`:** Plan's bench fails with `<500ms` assertion in debug mode (5–10× slower). The exact command: `cargo test --release --features test-helpers --test vault_bench -- --nocapture`. Don't run without `--release` and report flakes — that's a false failure.
11. **Bench seeding bottleneck:** The 100-note seed loop is sequential because `notes_io::write_note_to_disk` holds the path lock. On dev hardware this takes ~2s; on CI maybe 5s. The MEASUREMENT (`list_supported_files`) is what's bench'd, not the seed. Don't `tokio::join_all!` the seed — sequential is intentional for bench reproducibility.
12. **`port:audit` must stay clean:** No new `electron-log` imports, no `from 'electron'`, no `@electron`. Phase G's renderer changes (invoke.ts edits, mock trim, service tweak) shouldn't introduce any. `pnpm port:audit` exits 0 means clean.
13. **`command:parity` must classify all 25+ commands:** 3 settings (M2 real) + 15 vault (M3 real except 2 deferred) + 3 shell (M3 real) + 2 dialog (M3 real) + ~10 mocked-only feature domains from M1. Plan Step 15.8 adds two ledger entries. `pnpm command:parity` exits 0 with no unclassified renderer calls.
14. **PR title convention:** `m3: Vault FS + file watcher` — matches conventional commit style (`<scope>: <summary>`). The PR body uses HEREDOC for proper markdown formatting.
15. **PR test plan checklist:** Per repo's CLAUDE.md ship workflow, every PR needs a Test plan section with bulleted markdown checklist. Plan's body template (lines ~4566–4577) provides the exact wording — use it verbatim via HEREDOC.
16. **No merge, no force-push, no branch delete:** User's global CLAUDE.md forbids unprompted destructive ops. Push + open PR = done. Wait for user. Use `/land-and-deploy` (gstack skill) is the user's preferred merge path.
17. **Spike telemetry removal commit is small:** Step 16.5's commit touches only `main.tsx`. Don't bundle it with bench or PR-prep edits — atomic per change.

### Constraints

- **No new vault commands:** The 18-command surface is locked from Phase E. Don't add `vault_init` or similar in Phase G.
- **No mock additions:** Mock surface SHRINKS in Phase G (trim `mocks/vault.ts`). Don't add new routes.
- **No new tests beyond `vault_bench.rs`:** The 78 vault tests + 1 bench = 79. Don't add unit tests for the bench code itself.
- **No service-layer refactor:** Keep `vault-service.ts` minimal — it's a thin forwarder. M5 will refactor the service layer when notes CRUD lands.
- **No PR merge:** Open the PR. Wait for user review.
- **No CI-config changes:** The runtime e2e lane is gated by env var; CI without the vault checkout is unaffected.
- **No CSP loosening:** The CSP from Phase F stays as-is. Don't add hosts to fix the e2e spec — the spec runs against the dev runtime, not a remote URL.

### Acceptance criteria (Phase G done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3

# Bindings regenerated
grep -q 'vault_open' apps/desktop-tauri/src/generated/bindings.ts
grep -q 'NoteFrontmatter' apps/desktop-tauri/src/generated/bindings.ts
grep -q 'VaultStatus' apps/desktop-tauri/src/generated/bindings.ts
grep -q 'VaultEvent' apps/desktop-tauri/src/generated/bindings.ts

# Real commands set updated
grep -q "'vault_open'" apps/desktop-tauri/src/lib/ipc/invoke.ts
grep -q "'vault_list_notes'" apps/desktop-tauri/src/lib/ipc/invoke.ts
grep -q "'shell_open_url'" apps/desktop-tauri/src/lib/ipc/invoke.ts
grep -q "'dialog_choose_folder'" apps/desktop-tauri/src/lib/ipc/invoke.ts

# vault_reindex stays mocked
! grep -q "'vault_reindex'" apps/desktop-tauri/src/lib/ipc/invoke.ts
grep -q 'vault_reindex' apps/desktop-tauri/src/lib/ipc/mocks/vault.ts

# vault_create stays mocked
! grep -q "'vault_create'" apps/desktop-tauri/src/lib/ipc/invoke.ts
grep -q 'vault_create' apps/desktop-tauri/src/lib/ipc/mocks/vault.ts

# Mock vault.ts trimmed (M3 routes deleted)
! grep -q "vault_open: async" apps/desktop-tauri/src/lib/ipc/mocks/vault.ts
! grep -q "vault_list_notes: async" apps/desktop-tauri/src/lib/ipc/mocks/vault.ts

# E2E spec exists
test -f apps/desktop-tauri/e2e/specs/m3-vault-smoke.spec.ts
grep -q 'M3_TEST_VAULT_PATH' apps/desktop-tauri/e2e/specs/m3-vault-smoke.spec.ts

# Bench exists + passes in release
test -f apps/desktop-tauri/src-tauri/tests/vault_bench.rs
grep -q 'name = "vault_bench"' apps/desktop-tauri/src-tauri/Cargo.toml
cd apps/desktop-tauri/src-tauri && cargo test --release --features test-helpers --test vault_bench 2>&1 | tail -3
# expect: passes (under 500ms)

# Spike telemetry REMOVED
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
! grep -q 'drag-drop spike' apps/desktop-tauri/src/main.tsx
! grep -q "listen<string\[\]>\\('vault-drag-drop'" apps/desktop-tauri/src/main.tsx

# Parity audit ledger updated
grep -q "vault_reindex" apps/desktop-tauri/scripts/command-parity-audit.ts
grep -q "vault_create" apps/desktop-tauri/scripts/command-parity-audit.ts
grep -q "deferred" apps/desktop-tauri/scripts/command-parity-audit.ts
grep -q "M7" apps/desktop-tauri/scripts/command-parity-audit.ts
grep -q "M5" apps/desktop-tauri/scripts/command-parity-audit.ts

# Full final gate
pnpm --filter @memry/desktop-tauri lint
pnpm --filter @memry/desktop-tauri typecheck
pnpm --filter @memry/desktop-tauri test
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri port:audit
pnpm --filter @memry/desktop-tauri command:parity
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -3
# expect: ~79 passed (78 prior + 1 bench)
cd apps/desktop-tauri/src-tauri && cargo test --release --features test-helpers --test vault_bench 2>&1 | tail -3
# expect: 1 passed (bench under 500ms)

# Commits in Phase G
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
git log --oneline | grep -cE 'm3\((renderer|bench|spike)\)'   # expect ≥ 3 (renderer + bench + spike-removal)

# Branch pushed
git ls-remote --heads origin m3/vault-fs-and-watcher | grep -q m3/vault-fs-and-watcher

# PR open
gh pr view m3/vault-fs-and-watcher --json number,title,state 2>/dev/null
# Expect: state OPEN, title "m3: Vault FS + file watcher"

# Electron / packages / specs / plans untouched
git diff --name-only main..HEAD -- apps/desktop/ apps/sync-server/ packages/ docs/superpowers/specs/ docs/superpowers/plans/ | wc -l
# expect 0
```

### When done

Report to user:

```
Phase G complete — M3 shipped.
Tasks covered: 15, 16
Commits (Phase G): 3 (<first_hash>..<last_hash>)
Commits (M3 total): <total_count>
Rust tests: ~79 passed (78 vault + 1 bench)
TS tests: <total_count> passed
Bench: 100-note vault scan <X>ms (acceptance gate <500ms; local Apple-silicon target <80ms)

Renderer integration:
  - 22 commands swapped from mock to real Rust
  - vault_reindex deferred (M7) — mocked path returns { deferredUntil: 'M7' }
  - vault_create deferred (M5) — legacy onboarding helper retained
  - Bindings regenerated with 13+ M3 types
  - Runtime e2e smoke (m3-vault-smoke.spec.ts) — open + list + Turkish-roundtrip

Manual smoke history:
  - memry-file:// real image: 🟢 (Phase F)
  - memry-file:// 1×1 PNG fallback: 🟢
  - memry-file:// 403 outside vault: 🟢
  - drag-drop real paths: 🟢 (or 🔴 fallback documented)

Cleanup:
  - Drag-drop spike telemetry removed from main.tsx
  - scripts/drag-drop-smoke.md documents the smoke history

Branch: m3/vault-fs-and-watcher pushed to origin
PR: <number> — <URL>

M3 milestone: ready for user review and merge.
Next: M4 plan authoring — invoke superpowers:writing-plans with spec §M4 (Crypto + Keychain + Auth).

Blockers: <none | list>
```

If acceptance fails at any check:

1. Do not push a broken branch.
2. Diagnose:
   - **`bindings:check` fails** → `pnpm bindings:generate` then commit the result.
   - **`port:audit` fails** → grep for the violating import; remove or replace.
   - **`command:parity` fails with "unclassified renderer call"** → either add the command to a parity ledger entry or remove the renderer call.
   - **`cargo test --release --test vault_bench` exceeds 500ms** → check `--release` flag was set. Profile with `cargo flamegraph`. The most likely cause is the `dunce::canonicalize` re-run inside `list_supported_files` — Plan's impl canonicalizes once at entry. Don't optimize away the canonicalize without re-checking the path-safety contract.
   - **e2e spec hangs** → Tauri dev runtime not up; check `playwright.config.ts` for the launch command. The runtime lane needs `tauri dev` running.
3. Report finding + fix plan, wait for approval before pushing PR.

If still blocked: invoke `superpowers:systematic-debugging` and `superpowers:finishing-a-development-branch`. Report + wait for approval.

### Ready

1. Invoke `superpowers:using-superpowers`. Optionally `superpowers:test-driven-development` for the bench, `superpowers:finishing-a-development-branch` when reaching Step 16.6.
2. Read plan Tasks 15, 16 fully (lines ~4112–4630 of the plan file).
3. Run prerequisite verification. Report results.
4. Task 15:
   - Extend `generate_bindings.rs` (commands + types).
   - `pnpm bindings:generate && pnpm bindings:check`.
   - Update `realCommands` in `invoke.ts`.
   - Trim `mocks/vault.ts` (keep `vault_reindex` + `vault_create` only).
   - Verify `vault-service.ts` shape (test if needed).
   - Write `e2e/specs/m3-vault-smoke.spec.ts`.
   - Update `scripts/command-parity-audit.ts` ledger.
   - Run full check matrix (lint/typecheck/test/bindings:check/capability:check/port:audit/command:parity/cargo:check/cargo:clippy/cargo:test).
   - Commit `m3(renderer): swap vault_*/shell_*/dialog_* to real Rust + runtime e2e smoke`.
5. Task 16:
   - Write `tests/vault_bench.rs` (100-note scan with `<500ms` assertion).
   - Run `cargo test --release --features test-helpers --test vault_bench` → green.
   - Commit `m3(bench): 100-note vault scan <500ms acceptance test`.
   - Run final acceptance gate matrix. Manual cold-start smoke.
   - Remove spike telemetry from `main.tsx`. Commit `m3(spike): remove drag-drop spike telemetry; smoke documented in scripts/drag-drop-smoke.md`.
   - `git push -u origin m3/vault-fs-and-watcher`.
   - `gh pr create --title 'm3: Vault FS + file watcher'` with body per plan template.
   - DO NOT MERGE. Report PR URL to user.

## PROMPT END

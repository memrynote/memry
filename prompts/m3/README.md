# M3 — Vault FS + File Watcher / Phase Prompts

Her phase için ayrı prompt. Temiz session'da tek tek çalıştır. Prior phase'ler tamamlanmadan sonrakine geçme.

## Worktree

M3 ayrı worktree'de yürütülür (user preference — feedback_worktree.md). M2 PR `main`'e merge edildikten sonra:

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2
git worktree add ../spike-tauri-m3 -b m3/vault-fs-and-watcher main
cd ../spike-tauri-m3
mkdir -p ~/memry-test-vault-m3/notes ~/memry-test-vault-m3/journal ~/memry-test-vault-m3/attachments
```

Tüm phase'ler `../spike-tauri-m3` altında çalışır. Prompt'lar bu yolu default olarak kullanır.

## Çalıştırma sırası

| Phase | Prompt | Görev | Plan Task | Durum |
|-------|--------|-------|-----------|-------|
| A | `m3-phase-a-foundation.md` | Cargo deps + AppError vault variants + `vault/` module skeleton + `paths.rs` (TDD) | 1-3 | ⏳ |
| B | `m3-phase-b-vault-core-io.md` | `fs.rs` atomic write + safe read + list, `frontmatter.rs` parse/serialize, `notes_io.rs` round-trip (full TDD) | 4-6 | ⏳ |
| C | `m3-phase-c-preferences-registry.md` | `preferences.rs` per-vault JSON + `registry.rs` multi-vault list (TDD) | 7-8 | ⏳ |
| D | `m3-phase-d-watcher-runtime-state.md` | `watcher.rs` notify+debounce, `state.rs` VaultRuntime, `AppState` extension (TDD) | 10, 9 | ⏳ |
| E | `m3-phase-e-tauri-commands.md` | `commands/vault.rs` (13 commands) + `commands/shell.rs` + `commands/dialog.rs` + capabilities | 11-12 | ⏳ |
| F | `m3-phase-f-protocol-and-dragdrop.md` | `memry-file://` URI scheme handler + drag-drop path-resolution spike | 13-14 | ⏳ |
| G | `m3-phase-g-bindings-renderer-bench-pr.md` | Specta bindings regen, mock-swap, runtime e2e smoke, 100-note bench, acceptance gate, PR | 15-16 | ⏳ |

## TDD metodoloji (zorunlu her phase için)

**Her implementasyon adımı RED-GREEN-REFACTOR disiplinine bağlı:**

1. **RED:** Önce failing test yaz (cargo test veya vitest — duruma göre).
2. Test koş → **FAIL** beklenir. Fail mesajı mantıklı mı doğrula.
3. **GREEN:** Minimum kod ile test'i geç.
4. Test koş → **PASS** doğrula.
5. **REFACTOR:** Duplication varsa temizle, test hâlâ PASS.
6. Commit.

**TDD-appropriate phase'ler (zorunlu):**
- **Phase A** (Task 3 paths.rs) — RED-GREEN, 8 path-safety testleri
- **Phase B** (Tasks 4-6 fs/frontmatter/notes_io) — TAM TDD; 9+9+5 = 23 test
- **Phase C** (Tasks 7-8 preferences/registry) — TAM TDD; 8+6 = 14 test
- **Phase D** (Tasks 10 watcher) — TDD; 4 watcher test (multi_thread)
- **Phase G** (Task 16 bench) — bench-as-test, RED ile başla

**TDD uygulanması mekanik olan phase'ler (komut/wiring scaffold):**
- Phase E (commands), Phase F (protocol + spike)
- Bu phase'lerde test yerine **verification-before-completion disiplini**:
  - Her komut sonrası `cargo check` + `cargo clippy -- -D warnings`
  - Her dosya değişikliğinde `cargo test --features test-helpers` (carry-over kırılmasın)
  - Manuel smoke (e.g. `pnpm dev` + Finder drop) bu phase'lerde zorunlu
  - Phase sonunda full check matrix (lint/typecheck/test/cargo:test/bindings:check)

## Genel kurallar (her prompt bunu inherit eder)

1. **Worktree kökü:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3`
2. **Branch:** `m3/vault-fs-and-watcher`
3. **Asla dokunma:** `apps/desktop/**`, `apps/sync-server/**`, `packages/**`, `docs/superpowers/specs/**`, `docs/superpowers/plans/**`, `docs/spikes/**` (okuma OK, yazma hayır). M2'de kalan mock'lar yerinde kalır — M3 sadece Phase G'de `vault_*`, `shell_*`, `dialog_*` komutlarını gerçek invoke'a çevirir; `vault_reindex` ve `vault_create` mock olarak kalır (M7/M5 deferred).
4. **Kod standardı (Rust):** `rustfmt` default, `clippy -- -D warnings` zorunlu. `unwrap()`/`expect()` command path'inde YASAK; `state.rs` mutex poison handling `unwrap_or_else(|p| p.into_inner())` pattern kullanır. Vault `fs::*` çağrıları HER ZAMAN `paths::resolve_*` ile başlar — bypass yok.
5. **Kod standardı (TS):** Prettier (single quotes, no semi, 100 char, no trailing comma), ESLint flat config, named exports, strict TS. `console.log` yasak — sadece e2e spec'lerinde `console.info` for spike telemetry tolere edilir (Phase F'de import edilir, Phase G'de kaldırılır).
6. **Rust error handling:** Her command `Result<T, AppError>` döner. `AppError` Phase A'da Vault/PathEscape/Io variant'ları ile genişletilir. `From<std::io::Error>` → `AppError::Io` (M2'deki `Internal` mapping'i değiştirilir). `From<serde_yaml_ng::Error>` ve `From<notify::Error>` Phase A'da eklenir.
7. **Specta hygiene:** Her vault struct'ta `#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]` + `#[serde(rename_all = "camelCase")]`. Phase G'deki bindings generator bu canonical isimleri bekler.
8. **Path discipline:** `tokio::fs` veya `std::fs` çağrıları SADECE `vault/fs.rs`, `vault/preferences.rs`, ve `vault/registry.rs` içinde. Diğer modüller bu modülleri çağırır — escape guard bypass'lanmaz.
9. **Commit message format:** `m3(<scope>): <description>` — scope plan'dan alınır (deps, vault, commands, protocol, spike, renderer, bench, devx).
10. **PR stratejisi:** Tüm phase'ler aynı branch'e commit. M3 bittiğinde Phase G sonunda tek PR açılır.
11. **Plan dosyası:** `docs/superpowers/plans/2026-04-26-m3-vault-fs-and-watcher.md` — phase prompt'ları bu dosyaya referans verir, içerik yinelenmez.
12. **Spec dosyası:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md` — mimari kararlar için otorite (M3 bölümü §4, cross-cutting §5).
13. **Predecessor:** M2 PR (`docs/superpowers/plans/2026-04-25-m2-db-schemas-migrations.md`) `main`'e merge edilmiş olmalı. Phase A pre-flight bunu doğrular.

## Phase handoff

Her phase sonunda şu komutları çalıştır:

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
git log --oneline -10
git status --short
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -10 && cd -
pnpm --filter @memry/desktop-tauri typecheck
```

Ve kullanıcıya şunu rapor et:

```
Phase <X> complete.
Tasks covered: <task numbers>
Commits: <count> (<first hash>..<last hash>)
Rust tests: <passed count> (delta vs prior phase: +N)
Next: Phase <Y> — <prompt filename>
Blockers: <none | list>
```

## Emergency stop

Phase içinde bir task patlak verirse:

1. Durdur, sorunu özetle.
2. Root cause'u `superpowers:systematic-debugging` skill ile analiz et.
3. Plan'da yazan trip-wire'lardan biri tetiklendi mi kontrol et:
   - `serde_yaml_ng` parse hatası → orijinal Electron `gray-matter` output'unu byte-byte karşılaştır.
   - notify v6 platform fark → `macos_fsevents` feature aktif mi?
   - Path canonical mismatch (`/private/var/...` vs `/var/...`) → her yerde `dunce::canonicalize` kullanıldı mı?
   - Watcher debounce flake → test `multi_thread` flavor + 100ms warm-up sleep var mı?
4. Symlink loop / DOS test'inde hang → `list_supported_files` symlink skip ediyor mu?
5. Kullanıcıya rapor et ve onay bekle.

Plan dışına çıkma. "Bu fikre düştüm, şunu da ekleyeyim" yapma. Scope creep = budget creep. Özellikle:

- Yeni vault command ekleme (spec onayı olmadan; M3 surface = 13 vault + 3 shell + 2 dialog)
- M3'te rename detection eklemek (Plan defers to M5)
- M3'te FTS / embedding rebuild eklemek (Plan defers to M7 — `vault_reindex` stub returns `{ deferredUntil: 'M7' }`)
- M3'te `vault_create` real impl (Plan defers to M5 onboarding refactor)
- Yeni dep ekleme (Phase A'nın allow-listesi dışında: notify, serde_yaml_ng, mime_guess, sha2, dunce, tauri-plugin-dialog, nanoid, anyhow only)
- Pool / cache / async-watcher refactoru — M3 minimal Tokio mpsc + `notify::Watcher` + `parking_lot`/`std::sync::Mutex`

## Kritik referanslar

- **Plan self-review tablosu**: `docs/superpowers/plans/2026-04-26-m3-vault-fs-and-watcher.md` sonunda "Intentional deferrals" tablosu var. `vault_reindex` (M7), `vault_create` (M5), note-rename detection (M5), FTS rebuild (M7), PDF/thumbnail UI (M8.13–14) M3'te **yazılmaz**.
- **MEMORY.md gotchas**: `~/.claude/projects/.../memory/MEMORY.md` — özellikle "Pre-existing type errors in test files" ve "Migrations are hand-written since 0020" notları M3 sırasında devreye girer.
- **Pre-production app**: No backward-compat needed. Phase F'de SHA-256 content_hash kullanır (Electron'un djb2 hash'i pre-production free swap).
- **Spec §5.7 Security**: `capabilities/default.json` düz grant — Phase E `tauri-plugin-dialog` ekler, `tauri-plugin-shell` zaten M2'den var. Phase F CSP'ye sadece `memry-file:` ekler — third-party host genişletilmez.

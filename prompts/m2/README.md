# M2 — DB + Schemas + Migrations / Phase Prompts

Her phase için ayrı prompt. Temiz session'da tek tek çalıştır. Prior phase'ler tamamlanmadan sonrakine geçme.

## 2026-04-25 spec update overrides

The M2 spec was revised after M1. If an older plan section conflicts with this
list, follow the spec + these prompts:

- **DB owner:** M2 uses canonical `data.db` with a single
  `Arc<Mutex<rusqlite::Connection>>`. Do not add `r2d2` / `r2d2_sqlite` or a
  connection pool.
- **Migrations:** Port exactly the 29 Electron data migrations one-to-one.
  Prefer preserving source numbering (`0000_*` through `0028_*`). Do not create
  a net-new `0029` unless schema diff proves a real missing final-schema change.
- **Schema diff:** Electron-vs-Tauri `data.db` schema diff is required in
  Phase G, not optional.
- **M1 residue cleanup:** M2 must replace `electron-log/renderer` in
  `apps/desktop-tauri/src/lib/logger.ts` and harden `port:audit` so it catches
  `electron-log`, `from 'electron'`, `electron/`, and `@electron` imports in
  non-test code.
- **Command parity audit:** M2 must add `scripts/command-parity-audit.ts` and a
  `command:parity` package script. It compares Electron invoke/preload/channel
  surfaces, Tauri renderer `invoke(...)` calls, mock routes, Rust command
  registration, and generated bindings. Phase G fails if any renderer command
  is unclassified or any mock route name disagrees with renderer usage.
- **Updater mock-name mismatch:** Current renderer code calls
  `updater_get_state`, `updater_check_for_updates`,
  `updater_download_update`, and `updater_quit_and_install`; M1 mocks still use
  older names. Phase G must align the mock/test names or explicitly gate the
  updater UI as unavailable until M9. Do not leave silent mock drift.
- **Minimal shell-neutral wrappers:** M2 may add only the thin native wrappers
  required by the updated spec: window minimize/maximize/close, flush event
  subscription bridge, and renderer log forwarding. Deeper quick-capture,
  context-menu, notification, deep-link, and shutdown parity stays in M8.0.
- **Package extraction:** M2 must rehome or explicitly account for the
  settings-domain `@memry/*` contracts/defaults it touches.
- **Carry-forward ledger:** Final PR body records `@memry/*` count,
  `port:audit` residue count, command-parity status, updater mock status, known
  warning count, and runtime-e2e lane status.

## Worktree

M2 ayrı worktree'de yürütülür (user preference — feedback_worktree.md):

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk
git worktree add ../spike-tauri-m2 -b m2/db-schemas-migrations main
cd ../spike-tauri-m2
```

Tüm phase'ler `../spike-tauri-m2` altında çalışır. Prompt'lar bu yolu default olarak kullanır.

## Çalıştırma sırası

| Phase | Prompt | Görev | Plan Task | Durum |
|-------|--------|-------|-----------|-------|
| A | `m2-phase-a-db-foundation.md` | Cargo deps + AppState/Db/AppError + migration runner (TDD) | 1-3 | ⏳ |
| B | `m2-phase-b-migration-port.md` | 29 SQL migration dosyası port + integration smoke | 4-7 | ⏳ |
| C | `m2-phase-c-core-domain-structs.md` | projects/statuses/tasks + notes metadata structs | 8-9 | ⏳ |
| D | `m2-phase-d-calendar-collections-structs.md` | Calendar (4) + inbox/bookmarks/reminders/tags/folders structs | 10-11 | ⏳ |
| E | `m2-phase-e-sync-foundation-structs.md` | sync_queue/devices/state/history + search_reasons structs | 12 | ⏳ |
| F | `m2-phase-f-settings-ipc-slice.md` | Settings DB + commands + specta bindings + renderer hook swap | 13-15 | ⏳ |
| G | `m2-phase-g-tooling-acceptance.md` | MEMRY_DEVICE + dev scripts + parity audit + updater/native-wrapper hardening + bench + PR | 16-19 + spec-review addenda | ⏳ |

## TDD metodoloji (zorunlu her phase için)

**Her implementasyon adımı RED-GREEN-REFACTOR disiplinine bağlı:**

1. **RED:** Önce failing test yaz (cargo test veya vitest — duruma göre).
2. Test koş → **FAIL** beklenir. Fail mesajı mantıklı mı doğrula.
3. **GREEN:** Minimum kod ile test'i geç.
4. Test koş → **PASS** doğrula.
5. **REFACTOR:** Duplication varsa temizle, test hâlâ PASS.
6. Commit.

**TDD-appropriate phase'ler:**
- **Phase A** (migration runner): Task 3 baştan sona TDD — `bootstrap`, `apply_pending`, idempotence
- **Phase F** (settings IPC): Task 13 baştan sona TDD — `settings::get/set/list` + 4 Rust test + Vitest renderer test
- **Phase G** (tooling): new-migration helper + bench binary test-first

**TDD uygulanması mekanik olan phase'ler (saf port/scaffold):**
- Phase B, C, D, E
- Bu phase'lerde test yerine **verification-before-completion disiplini**:
  - Her migration port'undan sonra `cargo test --test migrations_test --features test-helpers`
  - Her struct dosyasından sonra smoke roundtrip test (insert → select → from_row)
  - Her commit öncesi `cargo clippy -- -D warnings` + `cargo test` clean
  - Phase sonunda full test suite (`pnpm cargo:test --features test-helpers`)

## Genel kurallar (her prompt bunu inherit eder)

1. **Worktree kökü:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2`
2. **Branch:** `m2/db-schemas-migrations`
3. **Asla dokunma:** `apps/desktop/**`, `apps/sync-server/**`, `packages/**`, `docs/superpowers/specs/**`, `docs/superpowers/plans/**`, `docs/spikes/**` (okuma OK, yazma hayır). `apps/desktop-tauri/src/lib/ipc/mocks/**` da M2'de tekrar yazılmaz — iki istisna var: Phase F sadece `invoke.ts`'yi `settings_*` için gerçek invoke'a çevirir, Phase G sadece updater mock/test adlarını renderer contract ile hizalayabilir. Kalan mock'lar yerinde kalır.
4. **Kod standardı (Rust):** `rustfmt` default, `clippy -- -D warnings` zorunlu, `pub(crate)` geniş `pub` yerine tercih edilir. `unwrap()`/`expect()` command path'inde YASAK (sadece app_state init fatal-bug'da).
5. **Kod standardı (TS):** Prettier (single quotes, no semi, 100 char, no trailing comma), ESLint flat config, named exports, strict TS. `console.log` yasak.
6. **Rust error handling:** Her command `Result<T, AppError>` döner. `AppError` Phase A'da tanımlanır.
7. **Specta hygiene:** Her DB struct'ta `#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]` + `#[serde(rename_all = "camelCase")]`. Task 14 generator'ı bu canonical isimleri bekler — Phase C-E'de yazılan struct isimleri plan'daki listeye birebir uymalı.
8. **Commit message format:** `m2(<scope>): <description>` — scope plan'dan alınır (deps, db, migrations, bindings, settings, renderer, devx, bench).
9. **PR stratejisi:** Tüm phase'ler aynı branch'e commit. M2 bittiğinde Phase G sonunda tek PR açılır.
10. **Plan dosyası:** `docs/superpowers/plans/2026-04-25-m2-db-schemas-migrations.md` — phase prompt'ları bu dosyaya referans verir, içerik yinelenmez.
11. **Spec dosyası:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md` — mimari kararlar için otorite (M2 bölümü §4, cross-cutting §5).

## Phase handoff

Her phase sonunda şu komutları çalıştır:

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2
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
Rust tests: <passed count>
Next: Phase <Y> — <prompt filename>
Blockers: <none | list>
```

## Emergency stop

Phase içinde bir task patlak verirse:
1. Durdur, sorunu özetle.
2. Root cause'u `superpowers:systematic-debugging` skill ile analiz et.
3. Plan'da yazan trip-wire'lardan biri tetiklendi mi kontrol et (spec Section 6.4).
4. Drizzle migration port'unda anlamsız hata → Electron orijinal SQL dosyasını `cat` ile tekrar oku, karakter karakter karşılaştır.
5. Kullanıcıya rapor et ve onay bekle.

Plan dışına çıkma. "Bu fikre düştüm, şunu da ekleyeyim" yapma. Scope creep = budget creep. Özellikle:
- Yeni struct/column ekleme (spec onayı olmadan)
- Drizzle'dan farklı migration numbering unless needed to preserve the exact
  final Electron data schema. Default: source-numbered `0000_*` through
  `0028_*`, no `0029`.
- rusqlite yerine başka crate seçme
- DB pool ekleme (`r2d2`, `deadpool`, etc.) — M2 single connection
- Pre-mature CRUD helper yazma (M5-M6 işi)

## Kritik referanslar

- **Plan self-review tablosu**: `docs/superpowers/plans/2026-04-25-m2-db-schemas-migrations.md` sonunda "Intentional deferrals from spec §M2 deliverables list" tablosu var. `Note`, `JournalEntry`, `Folder`, `Template`, `Embedding`, `CrdtUpdate`, `CrdtSnapshot`, `Device` structs M2'de **yazılmaz**. Bu listeye itaat.
- **MEMORY.md gotchas**: `~/.claude/projects/.../memory/MEMORY.md` — özellikle "Pre-existing type errors in test files" ve "Migrations are hand-written since 0020" notları M2 sırasında devreye girer.
- **Spec §5.7 Security**: `capabilities/default.json` düz grant — yeni SQL plugin eklemiyoruz, custom rusqlite commands kullanıyoruz. CSP narrow kalsın.

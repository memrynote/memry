# M1 — Tauri Skeleton + Full Renderer Port / Phase Prompts

Her phase için ayrı prompt. Temiz session'da tek tek çalıştır. Prior phase'ler tamamlanmadan sonrakine geçme.

## Çalıştırma sırası

| Phase | Prompt | Görev | Plan Task | Durum |
|-------|--------|-------|-----------|-------|
| A | `m1-phase-a-scaffold.md` | Directory + Cargo + Vite + TS scaffolding | 1-4 | ⏳ |
| B | `m1-phase-b-electron-freeze.md` | Electron freeze + spikes cleanup | 5-6 | ⏳ |
| C | `m1-phase-c-deps-styles.md` | Renderer deps + Tailwind + fonts | 7-8 | ⏳ |
| D | `m1-phase-d-mock-ipc.md` | Typed invoke + 19 mock domain + listen | 9-11 | ⏳ |
| E | `m1-phase-e-renderer-utilities.md` | lib/hooks/contexts/types port | 12 | ⏳ |
| F | `m1-phase-f-renderer-components.md` | components/ port | 13 | ⏳ |
| G | `m1-phase-g-renderer-features.md` | features/pages/services/sync port | 14 | ⏳ |
| H | `m1-phase-h-window-api-rewrite.md` | window.api → invoke mechanical rewrite | 15 | ⏳ |
| I | `m1-phase-i-rust-commands-bindings.md` | commands/mod.rs + specta pipeline + sanity check | 16-17 | ⏳ |
| J | `m1-phase-j-smoke-visual-parity.md` | Dev boot + Playwright e2e + prod build + visual diff | 18-19 | ⏳ |

## TDD metodoloji (zorunlu her phase için)

**Her implementasyon adımı RED-GREEN-REFACTOR disiplinine bağlı:**

1. **RED:** Önce failing test yaz (unit, integration, veya e2e — duruma göre).
2. Test koş → **FAIL** beklenir. Fail mesajı mantıklı mı doğrula.
3. **GREEN:** Minimum kod ile test'i geç.
4. Test koş → **PASS** doğrula.
5. **REFACTOR:** Duplication varsa temizle, test hâlâ PASS.
6. Commit.

**TDD-appropriate phase'ler:**
- **Phase D** (mock IPC): her route handler unit test'e sahip olmalı
- **Phase H** (rewrite): port-audit script'i test-first yazılır
- **Phase I** (tooling): capability check + bindings check script'leri test-first yazılır
- **Phase J** (smoke): Playwright e2e test'leri her route için zorunlu (her navigate'e test)

**TDD uygulanması mekanik olan phase'ler (saf scaffold/copy):**
- Phase A, B, C, E, F, G
- Bu phase'lerde test yerine **verification-before-completion disiplini**:
  - Her step sonunda `pnpm typecheck` / `cargo check` / `cargo clippy -- -D warnings`
  - Her commit öncesi smoke test (ilgili komutu çalıştır, expected output'u doğrula)
  - Phase sonunda `pnpm dev` ile incremental smoke

## Genel kurallar (her prompt bunu inherit eder)

1. **Repo kökü:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk`
2. **Aktif branch:** `spike/tauri-risk-discovery` (veya Kaan yeni M1 branch açarsa oraya)
3. **Asla dokunma:** `apps/desktop/**`, `apps/sync-server/**`, `packages/**`, `docs/superpowers/specs/**`, `docs/superpowers/plans/**`, `docs/spikes/**` (okuma OK, yazma hayır)
4. **Kod standardı:** Prettier (single quotes, no semi, 100 char, no trailing comma), ESLint flat config, named exports, strict TS
5. **Logging:** `console.log` yasak, her modül `createLogger('Scope')` (renderer'da zaten olan pattern)
6. **Commit message format:** `m1(<scope>): <description>` — scope Plan'dan alınır (scaffold, freeze, deps, ipc, port, backend, tooling)
7. **PR stratejisi:** Tüm phase'ler aynı branch'e commit. M1 bittiğinde tek PR açılır.
8. **Plan dosyası:** `docs/superpowers/plans/2026-04-24-m1-tauri-skeleton-and-renderer-port.md` — phase prompt'ları bu dosyaya referans verir, içerik yinelenmez.
9. **Spec dosyası:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md` — mimari kararlar için otorite.

## Phase handoff

Her phase sonunda şu komutları çalıştır:

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk
git log --oneline -5
git status --short
pnpm --filter @memry/desktop-tauri typecheck 2>&1 | tail -5
```

Ve kullanıcıya şunu rapor et:

```
Phase <X> complete.
Tasks covered: <task numbers>
Commits: <count> (<first hash>..<last hash>)
Next: Phase <Y> — <prompt filename>
Blockers: <none | list>
```

## Emergency stop

Phase içinde bir task patlak verirse:
1. Durdur, sorunu özetle.
2. Root cause'u `investigate` skill ile analiz et.
3. Plan'da yazan trip-wire'lardan biri tetiklendi mi kontrol et (spec Section 6.4).
4. Kullanıcıya rapor et ve onay bekle.

Plan dışına çıkma. "Bu fikre düştüm, şunu da ekleyeyim" yapma. Scope creep = budget creep.

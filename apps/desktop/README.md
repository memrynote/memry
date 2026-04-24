# ⚠️ FROZEN — Electron desktop app (being migrated to Tauri)

**Status:** Frozen as of 2026-04-24. No new commits to `apps/desktop/**` until deletion.

**Migration target:** `apps/desktop-tauri/`

**Why frozen:** Memry is migrating from Electron to Tauri 2.x as a complete
greenfield rewrite. This directory is preserved only so the Tauri build can
reference the Electron renderer for source parity during M1 (see migration
spec: `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`).

**For emergency bug fixes to Electron:** contact Kaan. Do not push directly.

**Scheduled deletion:** At M10 of the Tauri migration.

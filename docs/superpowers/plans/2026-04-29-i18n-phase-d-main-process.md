# i18n Phase D - Main Process Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Memry's main-process/user-visible error strings into `errors.json` and fully localize the Electron native application menu through `menu.json`, beyond Phase A's File/Edit/View seed.

**Architecture:** Preserve Phase A's main-process architecture: `bootI18n()` initializes `@memry/i18n/main` before `Menu.setApplicationMenu(...)`, and `registerLocaleHandlers(i18n, rebuildMenu)` applies runtime language changes. Phase D only adds English source strings, tests fallback behavior, and wires existing main-process/menu/error consumers to the `errors` and `menu` namespaces. Shared i18n registry files are already present, so edit locale resources and consumers surgically without reordering unrelated namespaces.

**Tech Stack:** TypeScript, Electron 39 main process, React renderer error utilities, `@memry/i18n`, i18next with the local `IcuFormatter`, Vitest, Electron `Menu`, pnpm/turbo.

---

## Scope Contract

**Depends on:**
- Phase A infrastructure present:
  - `packages/i18n/src/main/index.ts`
  - `apps/desktop/src/main/index.ts`
  - `apps/desktop/src/main/ipc/locale-handler.ts`
  - `apps/desktop/src/main/menu.ts`
- Phase B common namespace present.
- Phase C feature namespace work may be adjacent in shared resource files. Preserve unrelated namespace edits.

**In scope:**
- Populate `packages/i18n/src/locales/en/errors.json`.
- Keep `packages/i18n/src/locales/tr/errors.json` and `packages/i18n/src/locales/ar/errors.json` as literal `{}` so they fall back to English.
- Expand `packages/i18n/src/locales/en/menu.json` to cover every current user-visible label in `apps/desktop/src/main/menu.ts`.
- Preserve existing Phase A Turkish/Arabic menu seed labels (`file.label`, `file.newNote`, `edit.label`, `view.label`) because current locale-switch smoke tests rely on them. Do not add new TR/AR menu translations in Phase D; new menu keys fall back to English.
- Migrate central error helpers and global cross-process error surfaces that are not owned by a Phase C feature namespace.
- Keep `appendNamespaceToMissingKey: true` behavior covered by tests: missing `errors:` or `menu:` keys must return the namespaced key.

**Out of scope:**
- Phase E `pnpm i18n:check`, untranslated-string ESLint rule, codemod, or Tailwind logical-property sweep.
- Renderer feature namespace migrations such as inbox, notes, journal, calendar, graph, tasks, settings panel copy.
- Translating Turkish or Arabic content for `errors.json` or new `menu.json` keys.
- Log-only strings, test fixture strings, developer diagnostics, protocol/internal invariant errors that never reach users.
- Changing IPC contracts. If implementation discovers an IPC surface must change, stop and update this plan before coding.

---

## Files

### Inspect Before Editing

- `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-a-infrastructure.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-b-common-namespace.md`
- Representative Phase C plans for scope boundaries:
  - `docs/superpowers/plans/2026-04-29-i18n-phase-c-settings.md`
  - `docs/superpowers/plans/2026-04-29-i18n-phase-c-inbox.md`
  - `docs/superpowers/plans/2026-04-29-i18n-phase-c-notes.md`
  - `docs/superpowers/plans/2026-04-29-i18n-phase-c-graph.md`
- `packages/i18n/src/shared/config.ts`
- `packages/i18n/src/shared/types.ts`
- `packages/i18n/src/locales/index.ts`
- `packages/i18n/src/main/index.ts`
- `packages/i18n/src/main/index.test.ts`
- `packages/i18n/src/main/load-resources.ts`
- `packages/i18n/src/main/load-resources.test.ts`
- `packages/i18n/src/locales/en/errors.json`
- `packages/i18n/src/locales/tr/errors.json`
- `packages/i18n/src/locales/ar/errors.json`
- `packages/i18n/src/locales/en/menu.json`
- `packages/i18n/src/locales/tr/menu.json`
- `packages/i18n/src/locales/ar/menu.json`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/menu.ts`
- `apps/desktop/src/main/ipc/locale-handler.ts`
- `apps/desktop/src/main/ipc/index.ts`
- `apps/desktop/src/main/ipc/validate.ts`
- `apps/desktop/src/main/ipc/sync-core-handlers.ts`
- `apps/desktop/src/main/sync/engine/error-recovery-handler.ts`
- `apps/desktop/src/main/sync/engine/push-coordinator.ts`
- `apps/desktop/src/main/sync/engine/pull-coordinator.ts`
- `apps/desktop/src/main/sync/sync-errors.ts`
- `apps/desktop/src/renderer/src/lib/ipc-error.ts`
- `apps/desktop/src/renderer/src/lib/error-messages.ts`
- `apps/desktop/src/renderer/src/contexts/sync-context.tsx`

### Modify

- `packages/i18n/src/locales/en/errors.json`
- `packages/i18n/src/locales/tr/errors.json`
- `packages/i18n/src/locales/ar/errors.json`
- `packages/i18n/src/locales/en/menu.json`
- `packages/i18n/src/locales/tr/menu.json`
- `packages/i18n/src/locales/ar/menu.json`
- `packages/i18n/src/main/index.test.ts`
- `apps/desktop/src/main/menu.ts`
- `apps/desktop/src/main/ipc/validate.ts`
- `apps/desktop/src/main/ipc/sync-core-handlers.ts`
- `apps/desktop/src/main/sync/engine/error-recovery-handler.ts`
- `apps/desktop/src/main/sync/engine/push-coordinator.ts`
- `apps/desktop/src/main/sync/engine/pull-coordinator.ts`
- `apps/desktop/src/renderer/src/lib/ipc-error.ts`
- `apps/desktop/src/renderer/src/lib/ipc-error.test.ts`
- `apps/desktop/src/renderer/src/lib/error-messages.ts`
- `apps/desktop/src/renderer/src/lib/error-messages.test.ts`
- `apps/desktop/src/renderer/src/contexts/sync-context.tsx`

### Create

- `packages/i18n/src/main/errors-namespace.test.ts`
- `packages/i18n/src/main/menu-namespace.test.ts`
- `apps/desktop/src/main/menu.test.ts`
- `apps/desktop/src/renderer/src/contexts/sync-context.i18n.test.tsx` only if no existing sync-context test can be extended cleanly.

### Do Not Edit

- `packages/i18n/src/shared/config.ts` unless the implementation discovers `errors` or `menu` is missing from `I18N_NAMESPACES`. It is currently present.
- `packages/i18n/src/shared/types.ts` unless JSON typing fails. It already imports `errors` and `menu`.
- `packages/i18n/src/locales/index.ts` unless `errors` or `menu` imports are missing. They are currently present.
- `apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts` unless `pnpm ipc:check` reports a generated diff from an intentional IPC contract change. No IPC change is expected.
- Feature namespace JSONs such as `notes.json`, `inbox.json`, `settings.json`, `tasks.json`, `graph.json`, `calendar.json`, `journal.json`.

---

## Translation Resource Shape

Use existing local style for `menu.json` to avoid churn in Phase A keys. Add only keys that a current menu label needs.

`packages/i18n/src/locales/en/menu.json` target shape:

```json
{
  "app": {
    "quit": "Quit"
  },
  "file": {
    "label": "File",
    "newNote": "New Note",
    "close": "Close Window"
  },
  "edit": {
    "label": "Edit",
    "undo": "Undo",
    "redo": "Redo",
    "cut": "Cut",
    "copy": "Copy",
    "paste": "Paste"
  },
  "view": {
    "label": "View",
    "reload": "Reload",
    "toggleDevTools": "Toggle Developer Tools",
    "toggleFullscreen": "Toggle Full Screen"
  }
}
```

`packages/i18n/src/locales/tr/menu.json` and `packages/i18n/src/locales/ar/menu.json`:
- Keep the existing Phase A seed keys and values.
- Do not add new translated strings.
- It is acceptable for new keys like `view.reload` to be absent so they fall back to English.

`packages/i18n/src/locales/en/errors.json` target shape:

```json
{
  "generic": {
    "somethingWentWrong": "Something went wrong. Please try again.",
    "operationFailed": "Operation failed",
    "unknown": "An unknown error occurred",
    "validationFailed": "Validation failed",
    "actionFailed": "Action failed"
  },
  "ipc": {
    "noVaultOpen": "No vault is open. Please open a vault first."
  },
  "vault": {
    "notFound": "Vault not found. It may have been moved or deleted.",
    "notInitialized": "No vault is open. Open or create a vault to continue.",
    "invalidPath": "The selected path is not a valid vault location.",
    "permissionDenied": "Permission denied. Check that you have access to this folder.",
    "alreadyExists": "A vault already exists at this location.",
    "corrupted": "This vault appears to be corrupted. Try restoring from a backup."
  },
  "note": {
    "notFound": "This note could not be found. It may have been deleted.",
    "invalidFrontmatter": "This note has invalid metadata and cannot be read.",
    "duplicateId": "A note with this ID already exists.",
    "writeFailed": "Failed to save this note. Check disk space and permissions.",
    "readFailed": "Failed to read this note. The file may be locked or corrupted.",
    "deleteFailed": "Failed to delete this note. Check file permissions.",
    "invalidPath": "The note path is invalid."
  },
  "database": {
    "connectionFailed": "Could not connect to the local database. Try restarting the app.",
    "migrationFailed": "Database upgrade failed. Try restarting the app.",
    "queryFailed": "A database operation failed. Try again.",
    "notInitialized": "Database not ready. Try restarting the app.",
    "constraintViolation": "A data conflict occurred. Try again.",
    "corrupted": "The local database is corrupted. You may need to reset it."
  },
  "watcher": {
    "startFailed": "Could not start watching for file changes.",
    "stopFailed": "Could not stop the file watcher.",
    "eventError": "An error occurred while watching for file changes."
  },
  "attachment": {
    "fileTooLarge": "This file is too large to attach.",
    "unsupportedType": "This file type is not supported.",
    "writeFailed": "Failed to save the attachment. Check disk space.",
    "deleteFailed": "Failed to delete the attachment."
  },
  "encryption": {
    "failed": "Failed to encrypt data. Your keys may need to be regenerated.",
    "decryptionFailed": "Failed to decrypt data. Your encryption keys may be out of date.",
    "invalidKeyLength": "Invalid encryption key. Try signing out and back in.",
    "invalidNonceLength": "Encryption error. Try the operation again."
  },
  "inboxAttachment": {
    "writeFailed": "Failed to save the inbox attachment.",
    "deleteFailed": "Failed to delete the inbox attachment."
  },
  "sync": {
    "networkOffline": "You are offline. Changes will sync when you reconnect.",
    "networkTimeout": "The sync server took too long to respond. Will retry shortly.",
    "serverError": "The sync server encountered an error. Will retry automatically.",
    "authExpired": "Your session has expired. Sign in again to continue syncing.",
    "deviceRevoked": "This device has been removed from your account.",
    "rateLimited": "Too many requests. Syncing will resume shortly.",
    "cryptoFailure": "Failed to encrypt or decrypt sync data. Try signing out and back in.",
    "versionIncompatible": "This version of Memry is no longer supported. Please update.",
    "storageQuotaExceeded": "Your sync storage is full. Free up space or upgrade your plan.",
    "certificatePinFailed": "Secure connection failed. Check your network connection.",
    "unknown": "An unexpected sync error occurred. Will retry automatically.",
    "statusFetchFailed": "Failed to fetch sync status",
    "triggerFailed": "Sync failed",
    "pauseFailed": "Failed to pause sync",
    "resumeFailed": "Failed to resume sync",
    "securityQuarantinePermanent": "A sync item could not be verified and has been quarantined for security.",
    "securityQuarantineRetry": "A sync item failed signature verification and will be retried.",
    "certificatePinPaused": "Secure connection to sync server could not be verified. Syncing has been paused for your protection."
  }
}
```

`packages/i18n/src/locales/tr/errors.json` and `packages/i18n/src/locales/ar/errors.json` must be exactly:

```json
{}
```

Do not use empty-string values. Empty strings bypass fallback and render blank UI.

---

## Chunk 1: Preflight And Inventory

### Task 1: Confirm Phase D Base State

**Files:**
- Inspect only.

- [ ] **Step 1: Confirm worktree and dependencies**

Run:

```bash
pwd
git status --short
pnpm install
```

Expected:
- `pwd` is `/Users/h4yfans/sideproject/memry-i18n-phase-b` or the worker's dedicated worktree for this plan.
- `git status --short` may show unrelated docs or other workers' changes. Do not revert them.
- `pnpm install` exits 0.

- [ ] **Step 2: Verify Phase A main-process architecture is present**

Run:

```bash
test -f packages/i18n/src/main/index.ts
test -f packages/i18n/src/locales/en/menu.json
test -f apps/desktop/src/main/menu.ts
test -f apps/desktop/src/main/ipc/locale-handler.ts
rg -n "bootI18n|registerLocaleHandlers|buildAppMenu|appendNamespaceToMissingKey" apps/desktop/src/main packages/i18n/src
```

Expected:
- All `test -f` commands exit 0.
- Matches show:
  - `bootI18n()` in `apps/desktop/src/main/index.ts`.
  - `registerLocaleHandlers(i18n, rebuildMenu)` wiring.
  - `buildAppMenu(mainI18n)` before handler registration.
  - `appendNamespaceToMissingKey: true` in `packages/i18n/src/main/index.ts`.

- [ ] **Step 3: Inventory current menu labels**

Run:

```bash
rg -n "label:|role:|accelerator|submenu|buildAppMenu|Menu.buildFromTemplate" apps/desktop/src/main/menu.ts
```

Expected:
- Current app menu items are File/Edit/View plus app quit on macOS.
- If additional app-menu items have landed, add keys for those existing items. Do not invent new menu items.

- [ ] **Step 4: Inventory user-visible error surfaces**

Run:

```bash
rg -n "getUserErrorMessage|getSyncErrorMessage|extractErrorMessage\\(|return \\{ success: false, error: '[^']+'|throw new Error\\('[^']+'|toast\\.error\\('[^']+'|setError\\('[^']+'" apps/desktop/src/main apps/desktop/src/renderer/src -g '*.{ts,tsx}'
```

Expected:
- Treat this as a triage list, not a mandate to migrate every hit.
- In scope: central error helpers, global sync errors, IPC generic fallbacks, and stable user-facing cross-process errors.
- Out of scope: tests, logs, developer-only invariant errors, feature-owned renderer copy, and dynamic messages with user content or file paths.

- [ ] **Step 5: Commit**

No commit. Preflight only.

---

## Chunk 2: Locale Resources

### Task 2: Add Failing Namespace Tests For Errors And Menu Fallback

**Files:**
- Create: `packages/i18n/src/main/errors-namespace.test.ts`
- Create: `packages/i18n/src/main/menu-namespace.test.ts`
- Modify if needed: `packages/i18n/src/main/index.test.ts`

- [ ] **Step 1: Write failing errors namespace test**

Create `packages/i18n/src/main/errors-namespace.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createMainI18n } from './index'

describe('errors namespace', () => {
  it('returns populated English error messages', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    expect(i18n.t('errors:vault.notFound')).toBe(
      'Vault not found. It may have been moved or deleted.'
    )
    expect(i18n.t('errors:sync.networkOffline')).toBe(
      'You are offline. Changes will sync when you reconnect.'
    )
  })

  it('falls back to English for Turkish and Arabic error stubs', async () => {
    const tr = await createMainI18n({ locale: 'tr' })
    const ar = await createMainI18n({ locale: 'ar' })

    expect(tr.t('errors:generic.operationFailed')).toBe('Operation failed')
    expect(ar.t('errors:sync.certificatePinFailed')).toBe(
      'Secure connection failed. Check your network connection.'
    )
  })

  it('keeps the namespace on missing keys', async () => {
    const i18n = await createMainI18n({ locale: 'tr' })

    expect(i18n.t('errors:missing.key')).toBe('errors:missing.key')
  })
})
```

- [ ] **Step 2: Write failing menu namespace test**

Create `packages/i18n/src/main/menu-namespace.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createMainI18n } from './index'

describe('menu namespace', () => {
  it('returns every current English app-menu label', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    expect(i18n.t('menu:file.label')).toBe('File')
    expect(i18n.t('menu:file.newNote')).toBe('New Note')
    expect(i18n.t('menu:file.close')).toBe('Close Window')
    expect(i18n.t('menu:edit.undo')).toBe('Undo')
    expect(i18n.t('menu:edit.redo')).toBe('Redo')
    expect(i18n.t('menu:edit.cut')).toBe('Cut')
    expect(i18n.t('menu:edit.copy')).toBe('Copy')
    expect(i18n.t('menu:edit.paste')).toBe('Paste')
    expect(i18n.t('menu:view.reload')).toBe('Reload')
    expect(i18n.t('menu:view.toggleDevTools')).toBe('Toggle Developer Tools')
    expect(i18n.t('menu:view.toggleFullscreen')).toBe('Toggle Full Screen')
  })

  it('preserves Phase A Turkish seed labels and falls back for new keys', async () => {
    const i18n = await createMainI18n({ locale: 'tr' })

    expect(i18n.t('menu:file.label')).toBe('Dosya')
    expect(i18n.t('menu:file.newNote')).toBe('Yeni Not')
    expect(i18n.t('menu:view.reload')).toBe('Reload')
  })

  it('preserves Phase A Arabic seed labels and falls back for new keys', async () => {
    const i18n = await createMainI18n({ locale: 'ar' })

    expect(i18n.t('menu:file.label')).toBe('ملف')
    expect(i18n.t('menu:view.reload')).toBe('Reload')
  })

  it('keeps the namespace on missing menu keys', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    expect(i18n.t('menu:missing.key')).toBe('menu:missing.key')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm --filter @memry/i18n test -- errors-namespace menu-namespace
```

Expected:
- FAIL because `en/errors.json` is currently `{}` and `en/menu.json` lacks keys such as `file.close` and `view.reload`.

- [ ] **Step 4: Commit**

Do not commit failing tests alone unless this repository's current workflow explicitly allows red commits. If committing red tests is required:

```bash
git add packages/i18n/src/main/errors-namespace.test.ts packages/i18n/src/main/menu-namespace.test.ts
git commit -m "test(i18n): cover Phase D main-process namespaces"
```

Otherwise keep the tests uncommitted until Task 3 makes them pass.

### Task 3: Populate English Resources And Preserve Fallback Policy

**Files:**
- Modify: `packages/i18n/src/locales/en/errors.json`
- Modify: `packages/i18n/src/locales/tr/errors.json`
- Modify: `packages/i18n/src/locales/ar/errors.json`
- Modify: `packages/i18n/src/locales/en/menu.json`
- Modify: `packages/i18n/src/locales/tr/menu.json`
- Modify: `packages/i18n/src/locales/ar/menu.json`

- [ ] **Step 1: Populate `en/errors.json`**

Replace `packages/i18n/src/locales/en/errors.json` with the target shape in "Translation Resource Shape".

- [ ] **Step 2: Reset TR/AR errors to literal stubs**

Set both files to exactly `{}`:

Expected:
- No Turkish or Arabic error translations in Phase D.
- Use `apply_patch` or the repo's normal editor flow; do not use shell redirects for the actual file edit.

- [ ] **Step 3: Expand `en/menu.json`**

Add every key from the `menu.json` target shape. Preserve the existing `file.newNote` key name.

- [ ] **Step 4: Preserve existing TR/AR menu seed keys**

Do not reset `tr/menu.json` or `ar/menu.json` to `{}`. Keep the existing Phase A seed:
- `file.label`
- `file.newNote`
- `edit.label`
- `view.label`

Do not add translations for new Phase D menu keys such as `view.reload`.

- [ ] **Step 5: Validate JSON and fallback stubs**

Run:

```bash
node -e "for (const p of ['packages/i18n/src/locales/en/errors.json','packages/i18n/src/locales/tr/errors.json','packages/i18n/src/locales/ar/errors.json','packages/i18n/src/locales/en/menu.json','packages/i18n/src/locales/tr/menu.json','packages/i18n/src/locales/ar/menu.json']) JSON.parse(require('fs').readFileSync(p, 'utf8')); console.log('phase d json ok')"
node -e "const fs=require('fs'); for (const p of ['packages/i18n/src/locales/tr/errors.json','packages/i18n/src/locales/ar/errors.json']) { if (fs.readFileSync(p,'utf8').trim() !== '{}') throw new Error(p+' must be {}'); } console.log('errors stubs ok')"
```

Expected:

```text
phase d json ok
errors stubs ok
```

- [ ] **Step 6: Run namespace tests to verify pass**

Run:

```bash
pnpm --filter @memry/i18n test -- errors-namespace menu-namespace main/index
pnpm --filter @memry/i18n typecheck
```

Expected:
- Errors and menu namespace tests pass.
- Existing `main/index.test.ts` still proves `menu:nonexistent.key` returns `menu:nonexistent.key`.
- Typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/i18n/src/locales/en/errors.json packages/i18n/src/locales/tr/errors.json packages/i18n/src/locales/ar/errors.json packages/i18n/src/locales/en/menu.json packages/i18n/src/locales/tr/menu.json packages/i18n/src/locales/ar/menu.json packages/i18n/src/main/errors-namespace.test.ts packages/i18n/src/main/menu-namespace.test.ts
git commit -m "feat(i18n): populate Phase D main-process resources"
```

---

## Chunk 3: Native Application Menu

### Task 4: Add Failing Native Menu Builder Test

**Files:**
- Create: `apps/desktop/src/main/menu.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/menu.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMainI18n } from '@memry/i18n/main'

const buildFromTemplate = vi.fn((template: unknown) => ({ template }))

vi.mock('electron', () => ({
  app: { name: 'Memry' },
  Menu: { buildFromTemplate }
}))

import { buildAppMenu } from './menu'

describe('buildAppMenu', () => {
  beforeEach(() => {
    buildFromTemplate.mockClear()
  })

  it('labels every current native menu item from menu.json', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    buildAppMenu(i18n)

    const template = buildFromTemplate.mock.calls[0][0] as Array<{
      label?: string
      submenu?: Array<{ label?: string; role?: string }>
    }>

    expect(template.map((item) => item.label)).toContain('File')
    expect(template.map((item) => item.label)).toContain('Edit')
    expect(template.map((item) => item.label)).toContain('View')
    expect(template.flatMap((item) => item.submenu ?? []).map((item) => item.label)).toEqual(
      expect.arrayContaining([
        'New Note',
        'Close Window',
        'Undo',
        'Redo',
        'Cut',
        'Copy',
        'Paste',
        'Reload',
        'Toggle Developer Tools',
        'Toggle Full Screen'
      ])
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @memry/desktop test:main -- menu.test.ts
```

Expected:
- FAIL because role menu items currently rely on Electron default labels and do not all have translated `label` values.

### Task 5: Localize All Current Native Menu Labels

**Files:**
- Modify: `apps/desktop/src/main/menu.ts`
- Test: `apps/desktop/src/main/menu.test.ts`

- [ ] **Step 1: Update `buildAppMenu` labels only**

In `apps/desktop/src/main/menu.ts`:
- Keep `buildAppMenu(i18n: I18nInstance): Menu`.
- Keep `const t = i18n.getFixedT(null, 'menu')`.
- Do not change accelerators, click behavior, role semantics, or top-level structure.
- Add explicit labels for current role items:
  - app quit: `label: t('app.quit')`
  - close: `label: t('file.close')`
  - undo: `label: t('edit.undo')`
  - redo: `label: t('edit.redo')`
  - cut: `label: t('edit.cut')`
  - copy: `label: t('edit.copy')`
  - paste: `label: t('edit.paste')`
  - reload: `label: t('view.reload')`
  - toggle dev tools: `label: t('view.toggleDevTools')`
  - toggle fullscreen: `label: t('view.toggleFullscreen')`

Example shape:

```ts
{
  label: t('edit.label'),
  submenu: [
    { label: t('edit.undo'), role: 'undo' },
    { label: t('edit.redo'), role: 'redo' },
    { type: 'separator' },
    { label: t('edit.cut'), role: 'cut' },
    { label: t('edit.copy'), role: 'copy' },
    { label: t('edit.paste'), role: 'paste' }
  ]
}
```

- [ ] **Step 2: Run focused menu tests**

Run:

```bash
pnpm --filter @memry/desktop test:main -- menu.test.ts
pnpm --filter @memry/i18n test -- menu-namespace
```

Expected:
- Both pass.

- [ ] **Step 3: Run main-process typecheck**

Run:

```bash
pnpm --filter @memry/desktop typecheck:node
```

Expected:
- Typecheck exits 0.

- [ ] **Step 4: Optional manual smoke**

Run:

```bash
pnpm dev
```

Expected:
- English menu labels are unchanged for current users.
- Switching Settings -> General -> Language to Turkish rebuilds menu and preserves the Phase A seed labels for File/New Note/Edit/View.
- New role labels such as Reload and Toggle Developer Tools remain readable in English fallback.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/menu.ts apps/desktop/src/main/menu.test.ts
git commit -m "feat(i18n): localize native menu item labels"
```

---

## Chunk 4: Error Helpers And Cross-Process Error Copy

### Task 6: Migrate Central Error Message Helpers

**Files:**
- Modify: `apps/desktop/src/renderer/src/lib/error-messages.ts`
- Modify: `apps/desktop/src/renderer/src/lib/error-messages.test.ts`
- Modify if needed: `apps/desktop/src/renderer/src/lib/ipc-error.ts`
- Modify: `apps/desktop/src/renderer/src/lib/ipc-error.test.ts`

- [ ] **Step 1: Write failing helper tests**

Update `apps/desktop/src/renderer/src/lib/error-messages.test.ts` to initialize i18next with `RESOURCES` from `@memry/i18n/locales` and assert:
- `getUserErrorMessage(ERROR_CODES.VAULT_NOT_FOUND)` returns the English `errors:vault.notFound` value.
- `getUserErrorMessage('network_offline')` returns the English `errors:sync.networkOffline` value.
- With locale `tr`, `getUserErrorMessage(ERROR_CODES.NOTE_WRITE_FAILED)` falls back to the English `errors:note.writeFailed` value.
- Unknown codes with no fallback return `errors:generic.somethingWentWrong`.

Update `apps/desktop/src/renderer/src/lib/ipc-error.test.ts` to assert the existing translation path uses the real namespace:

```ts
expect(extractErrorMessage(new Error('errors:sync.networkOffline'), 'fallback')).toBe(
  'You are offline. Changes will sync when you reconnect.'
)
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- error-messages ipc-error
```

Expected:
- FAIL because `error-messages.ts` still owns hardcoded English maps and/or tests do not initialize the real i18n resources.

- [ ] **Step 3: Replace English maps with error keys**

In `apps/desktop/src/renderer/src/lib/error-messages.ts`:
- Keep exported `ERROR_CODES`.
- Replace `ERROR_MESSAGES` values with key suffixes, for example:
  - `VAULT_NOT_FOUND -> vault.notFound`
  - `NOTE_WRITE_FAILED -> note.writeFailed`
  - `DB_CONNECTION_FAILED -> database.connectionFailed`
  - `INBOX_ATTACHMENT_DELETE_FAILED -> inboxAttachment.deleteFailed`
- Replace `SYNC_ERROR_MESSAGES` values with key suffixes, for example:
  - `network_offline -> sync.networkOffline`
  - `certificate_pin_failed -> sync.certificatePinFailed`
- Add a small local helper that returns `getI18n()?.t('errors:' + key)` when initialized, and falls back to the English value in `RESOURCES.en.errors` when i18n is not initialized.
- Preserve function signatures:
  - `getUserErrorMessage(code: string, fallback?: string): string`
  - `getSyncErrorMessage(category: SyncErrorCategory): string`

Do not return raw `errors:*` keys to callers from these helpers; callers already expect display strings.

- [ ] **Step 4: Keep `extractErrorMessage` contract intact**

Do not break existing behavior:
- Empty input returns fallback.
- Plain errors pass through unchanged.
- IPC prefixes are stripped.
- Only full messages starting with `errors:` are translated.
- Missing `errors:` keys return the key via `appendNamespaceToMissingKey`; if the translated value equals the key, keep existing fallback behavior where applicable.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- error-messages ipc-error
pnpm --filter @memry/i18n test -- errors-namespace
```

Expected:
- All pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/error-messages.ts apps/desktop/src/renderer/src/lib/error-messages.test.ts apps/desktop/src/renderer/src/lib/ipc-error.ts apps/desktop/src/renderer/src/lib/ipc-error.test.ts
git commit -m "feat(i18n): resolve centralized error copy from errors namespace"
```

### Task 7: Migrate Global IPC And Sync Error Surfaces

**Files:**
- Modify: `apps/desktop/src/main/ipc/validate.ts`
- Modify: `apps/desktop/src/main/ipc/sync-core-handlers.ts`
- Modify: `apps/desktop/src/main/sync/engine/error-recovery-handler.ts`
- Modify: `apps/desktop/src/main/sync/engine/push-coordinator.ts`
- Modify: `apps/desktop/src/main/sync/engine/pull-coordinator.ts`
- Modify: `apps/desktop/src/renderer/src/contexts/sync-context.tsx`
- Modify relevant tests:
  - `apps/desktop/src/main/ipc/validate.test.ts`
  - `apps/desktop/src/main/ipc/sync-core-handlers.test.ts`
  - `apps/desktop/src/main/sync/engine/error-recovery-handler.test.ts`
  - `apps/desktop/src/main/sync/engine-push.test.ts` only if assertions cover changed user-visible strings.
  - `apps/desktop/src/main/sync/engine-pull.test.ts` only if assertions cover changed user-visible strings.
  - Create `apps/desktop/src/renderer/src/contexts/sync-context.i18n.test.tsx` only if needed.

- [ ] **Step 1: Write or update failing tests**

Before editing implementation, add assertions for the new contract:
- `withDb` no-vault fallback returns `errors:ipc.noVaultOpen`.
- `withErrorHandler` default fallback returns `errors:generic.operationFailed` only when there is no concrete error message.
- Sync context translates incoming `errors:*` payloads before storing/displaying them.
- Direct global sync toasts use `errors.sync.*` values, not hardcoded English.

Run:

```bash
pnpm --filter @memry/desktop test:main -- validate sync-core-handlers error-recovery-handler
pnpm --filter @memry/desktop test:renderer -- sync-context
```

Expected:
- FAIL on the new assertions before implementation.
- If no sync-context test harness exists and creating one is too large, keep the sync-context portion as a focused manual smoke in Task 8 and document that no renderer unit harness existed.

- [ ] **Step 2: Migrate generic IPC helper fallbacks**

In `apps/desktop/src/main/ipc/validate.ts`:
- Change default `withErrorHandler` fallback from `'Operation failed'` to `'errors:generic.operationFailed'`.
- Change default `withDb` fallback from `'Operation failed'` to `'errors:generic.operationFailed'`.
- Change the no-vault response from `'No vault is open. Please open a vault first.'` to `'errors:ipc.noVaultOpen'`.
- Do not change validation-detail messages such as `Validation failed: field: issue`; those include useful dynamic details and are not full translation keys yet.

- [ ] **Step 3: Migrate stable global sync errors**

In sync main-process files, prefer error keys only for stable display strings that cross to the renderer:
- Device revoked -> `errors:sync.deviceRevoked`
- Auth expired/session expired -> `errors:sync.authExpired`
- Certificate pin failed -> `errors:sync.certificatePinFailed`
- Storage quota exceeded -> `errors:sync.storageQuotaExceeded`
- Unknown sync error -> `errors:sync.unknown`

Do not convert dynamic messages that embed seconds, file paths, item IDs, server strings, or user content unless the code path can translate through a category instead.

- [ ] **Step 4: Translate global sync context display copy**

In `apps/desktop/src/renderer/src/contexts/sync-context.tsx`:
- Use `extractErrorMessage(errorValue, fallback)` when storing or displaying incoming sync errors.
- Use the `errors` namespace for direct global sync toasts:
  - `sync.storageQuotaExceeded`
  - `sync.authExpired`
  - `sync.deviceRevoked`
  - `sync.statusFetchFailed`
  - `sync.securityQuarantinePermanent`
  - `sync.securityQuarantineRetry`
  - `sync.certificatePinPaused`
  - `sync.triggerFailed`
  - `sync.pauseFailed`
  - `sync.resumeFailed`
- Do not migrate feature-specific UI copy in this file beyond global sync error text.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm --filter @memry/desktop test:main -- validate sync-core-handlers error-recovery-handler
pnpm --filter @memry/desktop test:renderer -- sync-context error-messages ipc-error
pnpm --filter @memry/desktop typecheck:node
pnpm --filter @memry/desktop typecheck:web
```

Expected:
- Focused main tests pass.
- Focused renderer tests pass or the missing sync-context harness is documented.
- Node and web typechecks exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/ipc/validate.ts apps/desktop/src/main/ipc/validate.test.ts apps/desktop/src/main/ipc/sync-core-handlers.ts apps/desktop/src/main/ipc/sync-core-handlers.test.ts apps/desktop/src/main/sync/engine/error-recovery-handler.ts apps/desktop/src/main/sync/engine/error-recovery-handler.test.ts apps/desktop/src/main/sync/engine/push-coordinator.ts apps/desktop/src/main/sync/engine-push.test.ts apps/desktop/src/main/sync/engine/pull-coordinator.ts apps/desktop/src/main/sync/engine-pull.test.ts apps/desktop/src/renderer/src/contexts/sync-context.tsx apps/desktop/src/renderer/src/contexts/sync-context.i18n.test.tsx
git commit -m "feat(i18n): migrate global error surfaces to errors namespace"
```

If some listed tests were untouched because their assertions do not cover migrated strings, omit them from `git add`.

### Task 8: Bounded Error Sweep And Cleanup

**Files:**
- Same files as Tasks 6-7 unless the sweep finds another central global error surface.

- [ ] **Step 1: Search for remaining central error literals**

Run:

```bash
rg -n "getUserErrorMessage|getSyncErrorMessage|extractErrorMessage\\([^\\n]*'[^']+'|toast\\.error\\('[^']+'|setError\\('[^']+'|return \\{ success: false, error: '[^']+'" apps/desktop/src/main apps/desktop/src/renderer/src -g '*.{ts,tsx}'
```

Expected:
- Allowed remaining matches:
  - Feature-owned renderer fallbacks that belong to Phase C namespaces.
  - Existing translated fallbacks such as `extractErrorMessage(err, t('...'))`.
  - Dynamic/user-content errors.
  - Developer/test/invariant messages.
  - Log-only strings.
- If a global cross-process error remains, add an `errors.json` key and migrate it before continuing.

- [ ] **Step 2: Confirm TR/AR error stubs**

Run:

```bash
node -e "const fs=require('fs'); for (const p of ['packages/i18n/src/locales/tr/errors.json','packages/i18n/src/locales/ar/errors.json']) { if (fs.readFileSync(p,'utf8').trim() !== '{}') throw new Error(p+' must be {}'); } console.log('errors stubs ok')"
```

Expected:

```text
errors stubs ok
```

- [ ] **Step 3: Confirm shared registry churn is minimal**

Run:

```bash
git diff -- packages/i18n/src/shared/config.ts packages/i18n/src/shared/types.ts packages/i18n/src/locales/index.ts
```

Expected:
- No diff, unless implementation found a real missing `errors`/`menu` registration.
- Do not reorder namespace arrays or imports for cleanup.

- [ ] **Step 4: Commit cleanup only if changes were needed**

```bash
git add <only-files-fixed-during-sweep>
git commit -m "chore(i18n): clean up Phase D error migration"
```

Skip if no changes.

---

## Verification Gate

Run these after all implementation tasks and commits are complete.

- [ ] **Step 1: i18n package tests**

```bash
pnpm --filter @memry/i18n test -- errors-namespace menu-namespace main/index load-resources
pnpm --filter @memry/i18n test
pnpm --filter @memry/i18n typecheck
```

Expected:
- Focused tests pass.
- Full `@memry/i18n` test suite passes.
- `@memry/i18n` typecheck exits 0.

- [ ] **Step 2: Main-process/menu tests**

```bash
pnpm --filter @memry/desktop test:main -- menu.test.ts locale-handler validate sync-core-handlers error-recovery-handler
```

Expected:
- Menu builder test passes.
- Locale handler still proves `rebuildMenu(locale)` is called after `i18n.changeLanguage(locale)`.
- IPC/global error tests pass.

- [ ] **Step 3: Renderer error utility tests**

```bash
pnpm --filter @memry/desktop test:renderer -- error-messages ipc-error sync-context
```

Expected:
- Error utility tests pass.
- Sync-context test passes if created. If no sync-context harness exists, report that exact gap and cover it in manual smoke.

- [ ] **Step 4: Desktop typechecks**

```bash
pnpm --filter @memry/desktop typecheck:node
pnpm --filter @memry/desktop typecheck:web
pnpm --filter @memry/desktop typecheck
```

Expected:
- Node and web typechecks pass, except only documented pre-existing unrelated test-file errors if still present on the target branch.

- [ ] **Step 5: Full repo gate**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm ipc:check
```

Expected:
- All pass.
- `pnpm ipc:check` should be a no-op for Phase D because no IPC surface change is expected.

- [ ] **Step 6: Optional Electron smoke**

Run:

```bash
pnpm dev
```

Expected:
- App boots in English.
- Native menu shows the full English label set.
- Settings -> General -> Language -> Turkish rebuilds native menu. Existing Phase A seed labels still show Turkish, while new Phase D menu labels fall back to English.
- Settings -> General -> Language -> Arabic rebuilds native menu. Existing Phase A seed labels still show Arabic, while new Phase D menu labels fall back to English.
- Trigger or mock one `errors:` payload through `extractErrorMessage`; no raw `errors:*` key is visible unless the key is intentionally missing.

---

## Atomic Commit Summary

Suggested commits:

1. `feat(i18n): populate Phase D main-process resources`
2. `feat(i18n): localize native menu item labels`
3. `feat(i18n): resolve centralized error copy from errors namespace`
4. `feat(i18n): migrate global error surfaces to errors namespace`
5. `chore(i18n): clean up Phase D error migration` only if the final sweep changes files

Keep commits scoped. Do not stage unrelated Phase C files or adjacent registry/resource edits from other workers.

---

## Acceptance Criteria

- `packages/i18n/src/locales/en/errors.json` contains the Phase D English error taxonomy.
- `packages/i18n/src/locales/tr/errors.json` is exactly `{}`.
- `packages/i18n/src/locales/ar/errors.json` is exactly `{}`.
- `packages/i18n/src/locales/en/menu.json` covers every current native app-menu label in `apps/desktop/src/main/menu.ts`.
- Existing Phase A TR/AR menu seed keys remain intact; new Phase D menu keys use English fallback.
- `apps/desktop/src/main/menu.ts` labels current role items through `t(...)` without changing accelerators, roles, or menu structure.
- Central error helpers resolve display strings through the `errors` namespace and preserve fallback behavior.
- Global cross-process sync/IPC errors use `errors:` keys or translate through the central helper.
- Missing-key tests still prove `appendNamespaceToMissingKey: true`.
- No Phase E checker/codemod/lint gate is added.
- No renderer feature namespace migration is included.
- No Turkish or Arabic translation content is added for Phase D errors or new menu keys.

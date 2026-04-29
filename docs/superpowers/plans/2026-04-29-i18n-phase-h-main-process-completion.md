# i18n Phase H — Main-Process String Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the ~13 user-facing English strings remaining in the Electron main process — desktop notification labels for reminders, native dialog titles/buttons/file-filters for vault picker and PDF/HTML export, and IPC error responses — so that switching the active locale also flips system-surface text rendered outside the renderer's React tree.

**Architecture:** Add one new namespace, `system.json`, dedicated to main-process surface strings (native dialogs, notifications, system errors that bubble to the user). Keep `errors.json` for renderer-side error message rendering and `menu.json` for native-menu items. The new namespace lazy-bundles into the main-process JS bundle alongside the existing menu/errors namespaces, requires no IPC, and uses the already-initialized `mainI18n` instance from Phase A.

**Tech Stack:** TypeScript, Electron 39, `@memry/i18n/main` (`createMainI18n`), Vitest.

**Spec:** `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`

**Depends on:** Phase A merged (provides `mainI18n` + IPC `locale:changed` rebroadcast). Phase D merged (`errors.json`, `menu.json` namespaces + `rebuildAppMenu` on locale change). Verify by running:

```bash
pnpm i18n:check
node -e "console.log(require('./packages/i18n/src/locales/en/menu.json').file.label)"
```

The second command should print `"File"`.

**Out of scope:**
- Renderer-process strings (Phase G owns those).
- ESLint rule expansion (Phase I).
- BlockNote bidi rendering.
- Translating user-authored content.
- About panel / app dock label / OS-cached notifications (per spec these refresh after relaunch; not in v1 scope).

---

## Worktree Setup

- [ ] **Step 1: Create worktree off `main`**

```bash
git worktree add ../memry-i18n-phase-h -b feature/i18n-phase-h
cd ../memry-i18n-phase-h
```

- [ ] **Step 2: Verify Phase D + G baseline**

```bash
pnpm install
pnpm i18n:check
```

Expected: passes. The output should show `menu.json` has 14+ keys, `errors.json` has 79+ keys.

- [ ] **Step 3: Smoke-test current main-process locale flip**

```bash
pnpm dev
```

In the running app: switch to Türkçe, confirm the native menu rebuilds (File → Dosya). If it doesn't, Phase D has a regression — fix that first.

- [ ] **Step 4: Confirm clean tree**

```bash
git status
```

Expected: clean.

---

## Task 1: Create the New `system` Namespace

**Files:**
- Create: `packages/i18n/src/locales/en/system.json`
- Create: `packages/i18n/src/locales/tr/system.json`
- Create: `packages/i18n/src/locales/ar/system.json`
- Modify: `packages/i18n/src/shared/config.ts`
- Modify: `packages/i18n/src/locales/index.ts`
- Modify: `packages/i18n/src/shared/types.ts` (if it imports from individual JSONs)

- [ ] **Step 1: Write `en/system.json`**

Create `packages/i18n/src/locales/en/system.json`:

```json
{
  "dialog": {
    "vault": {
      "title": "Select Vault Folder",
      "button": "Select Vault"
    },
    "exportPdf": {
      "title": "Export as PDF",
      "filterName": "PDF Document"
    },
    "exportHtml": {
      "title": "Export as HTML",
      "filterName": "HTML Document"
    },
    "import": {
      "filterSupported": "Supported Files",
      "filterAll": "All Files"
    },
    "exportCancelled": "Export cancelled"
  },
  "notification": {
    "reminder": {
      "note": "Note reminder",
      "journal": "Journal reminder",
      "highlight": "Highlight reminder",
      "fallback": "Reminder due",
      "default": "Reminder"
    }
  },
  "error": {
    "reminderTimeMustBeFuture": "Reminder time must be in the future",
    "definitionNotFound": "Definition not found",
    "noteNotFound": "Note not found",
    "updateFailed": "Update failed"
  }
}
```

- [ ] **Step 2: Write empty stubs `tr/system.json` and `ar/system.json`**

Create both with literal `{}`:

```bash
echo '{}' > packages/i18n/src/locales/tr/system.json
echo '{}' > packages/i18n/src/locales/ar/system.json
```

(Empty object — relies on i18next fallback to `en` until translators fill it in. Per spec, this is the canonical "translation deferred" state.)

- [ ] **Step 3: Verify all three parse**

```bash
node -e "['en','tr','ar'].forEach(l => JSON.parse(require('fs').readFileSync(\`packages/i18n/src/locales/\${l}/system.json\`, 'utf8'))); console.log('OK')"
```

Expected: `OK`.

- [ ] **Step 4: Add `system` to `I18N_NAMESPACES` in `shared/config.ts`**

In `packages/i18n/src/shared/config.ts`, replace:

```ts
export const I18N_NAMESPACES = [
  'common',
  'inbox',
  'notes',
  'journal',
  'calendar',
  'tasks',
  'graph',
  'settings',
  'errors',
  'menu'
] as const
```

with:

```ts
export const I18N_NAMESPACES = [
  'common',
  'inbox',
  'notes',
  'journal',
  'calendar',
  'tasks',
  'graph',
  'settings',
  'errors',
  'menu',
  'system'
] as const
```

- [ ] **Step 5: Wire the JSON into `RESOURCES` in `locales/index.ts`**

In `packages/i18n/src/locales/index.ts`, add the imports:

```ts
import enSystem from './en/system.json'
import trSystem from './tr/system.json'
import arSystem from './ar/system.json'
```

Then extend each language block in the `RESOURCES` object:

```ts
en: {
  // …existing entries…
  menu: enMenu,
  system: enSystem
},
tr: {
  // …existing entries…
  menu: trMenu,
  system: trSystem
},
ar: {
  // …existing entries…
  menu: arMenu,
  system: arSystem
}
```

- [ ] **Step 6: Update `shared/types.ts` if it explicitly references namespaces**

Read the file:

```bash
cat packages/i18n/src/shared/types.ts
```

If it lists namespaces individually for `Resources`, add:

```ts
import type System from '../locales/en/system.json'
…
interface Resources {
  // …
  system: typeof System
}
```

If it derives from `RESOURCES.en` directly via `(typeof RESOURCES.en)`, no change needed — the type augmentation picks up the new namespace automatically.

- [ ] **Step 7: Typecheck the package**

```bash
pnpm --filter @memry/i18n typecheck
```

Expected: passes.

- [ ] **Step 8: Run the existing i18n tests**

```bash
pnpm --filter @memry/i18n test
```

Expected: all pass. Phase A's main and renderer init tests now load 11 namespaces instead of 10 — they should pass without modification.

- [ ] **Step 9: Commit**

```bash
git add packages/i18n/src/locales/en/system.json packages/i18n/src/locales/tr/system.json packages/i18n/src/locales/ar/system.json packages/i18n/src/shared/config.ts packages/i18n/src/locales/index.ts packages/i18n/src/shared/types.ts
git commit -m "feat(i18n): add system namespace for main-process surface strings"
```

---

## Task 1b: Create Main-Process i18n Accessor

**Files:**
- Create: `apps/desktop/src/main/lib/main-i18n.ts`
- Modify: `apps/desktop/src/main/index.ts`

The current main process holds `mainI18n` as a `let` binding inside `apps/desktop/src/main/index.ts` and passes it to consumers via parameters: `buildAppMenu(mainI18n)`, `registerAllHandlers({ i18n: mainI18n, rebuildMenu })`. Plumbing it down into `lib/reminders.ts`, `vault/index.ts`, `ipc/notes-handlers.ts`, and `updater.ts` would require thread-through-eight-call-sites changes. Instead, expose a small main-only accessor module that the boot sequence sets once. Locale changes mutate the same instance via `mainI18n.changeLanguage(...)`, so the accessor naturally returns the up-to-date instance without re-set.

- [ ] **Step 1: Write the accessor module**

Create `apps/desktop/src/main/lib/main-i18n.ts`:

```ts
import type { I18nInstance } from '@memry/i18n/main'

let active: I18nInstance | null = null

export function setMainI18n(instance: I18nInstance): void {
  active = instance
}

export function getMainI18n(): I18nInstance {
  if (!active) {
    throw new Error('main-process i18n not initialized — call setMainI18n during boot')
  }
  return active
}

/** Test-only reset. Production code never calls this. */
export function __resetMainI18nForTest(): void {
  active = null
}
```

- [ ] **Step 2: Wire it into boot**

Edit `apps/desktop/src/main/index.ts`. Around line 528 where `mainI18n = await bootI18n()` is called, add `setMainI18n(mainI18n)` immediately after:

```ts
import { setMainI18n } from './lib/main-i18n'
// …
mainI18n = await bootI18n()
setMainI18n(mainI18n)
Menu.setApplicationMenu(buildAppMenu(mainI18n))
registerAllHandlers({ i18n: mainI18n, rebuildMenu })
```

(Keep the existing `buildAppMenu(mainI18n)` and `registerAllHandlers({ i18n: mainI18n, rebuildMenu })` calls — they continue to use explicit DI for handlers that already accept it. The accessor is for the *new* call sites this phase introduces.)

- [ ] **Step 3: Add a unit test for the accessor**

Create `apps/desktop/src/main/lib/main-i18n.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createMainI18n } from '@memry/i18n/main'
import { setMainI18n, getMainI18n, __resetMainI18nForTest } from './main-i18n'

describe('main-i18n accessor', () => {
  beforeEach(() => {
    __resetMainI18nForTest()
  })

  it('throws when accessed before set', () => {
    expect(() => getMainI18n()).toThrow(/not initialized/)
  })

  it('returns the set instance', async () => {
    const instance = await createMainI18n({ locale: 'en' })
    setMainI18n(instance)
    expect(getMainI18n()).toBe(instance)
  })

  it('reflects changeLanguage mutation on the same instance', async () => {
    const instance = await createMainI18n({ locale: 'en' })
    setMainI18n(instance)
    expect(getMainI18n().t('system:dialog.vault.title')).toBe('Select Vault Folder')
    await getMainI18n().changeLanguage('tr')
    // tr/system.json is empty — falls back to English. The point is the
    // accessor returns the same mutated instance, not a stale one.
    expect(getMainI18n().t('system:dialog.vault.title')).toBe('Select Vault Folder')
  })
})
```

- [ ] **Step 4: Run the test**

```bash
pnpm --filter @memry/desktop test main-i18n
```

Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/lib/main-i18n.ts apps/desktop/src/main/lib/main-i18n.test.ts apps/desktop/src/main/index.ts
git commit -m "feat(i18n): add main-process i18n singleton accessor"
```

---

## Task 2: Migrate Reminder Notification Labels (`apps/desktop/src/main/lib/reminders.ts`)

**Files:**
- Modify: `apps/desktop/src/main/lib/reminders.ts`
- Modify: existing test if present (`apps/desktop/src/main/lib/reminders.test.ts` or similar — search first)

The desktop notification body uses 5 hardcoded English labels (Note reminder / Journal reminder / Highlight reminder / Reminder due / Reminder fallback for missing title).

- [ ] **Step 1: Read the existing function around lines 220–260**

```bash
sed -n '220,260p' apps/desktop/src/main/lib/reminders.ts
```

The accessor was added in Task 1b. `reminders.ts` lives in the same `lib/` directory, so the import is a sibling-relative path.

- [ ] **Step 2: Add the import at the top of `reminders.ts`**

```ts
import { getMainI18n } from './main-i18n'
```

- [ ] **Step 3: Replace the hardcoded labels around line 232**

Locate the `typeLabels` block:

```ts
const typeLabels: Record<string, string> = {
  note: 'Note reminder',
  journal: 'Journal reminder',
  highlight: 'Highlight reminder'
}
body = typeLabels[reminder.targetType] || 'Reminder due'
```

Replace with:

```ts
const t = getMainI18n().t
const typeLabels: Record<string, string> = {
  note: t('system:notification.reminder.note'),
  journal: t('system:notification.reminder.journal'),
  highlight: t('system:notification.reminder.highlight')
}
body = typeLabels[reminder.targetType] || t('system:notification.reminder.fallback')
```

- [ ] **Step 4: Replace the title fallback at line ~228**

```ts
// Before:
const title = reminder.title || reminder.targetTitle || 'Reminder'
// After:
const title = reminder.title || reminder.targetTitle || t('system:notification.reminder.default')
```

(Reuse the `t` reference declared in Step 3.)

- [ ] **Step 5: Replace validation throws at lines 286 and 334**

Both instances of `throw new Error('Reminder time must be in the future')`:

```ts
// Before:
throw new Error('Reminder time must be in the future')
// After:
throw new Error(getMainI18n().t('system:error.reminderTimeMustBeFuture'))
```

(Use `getMainI18n().t` directly here — these throws are not inside the same scope as the notification block.)

- [ ] **Step 6: Run main-process typecheck**

```bash
pnpm --filter @memry/desktop typecheck
```

If `getMainI18n` import resolves but the `.t()` call has a generic `(key: string) => string` return that loses the typed namespace check, add `t.bind(getMainI18n())` or `getMainI18n().t.bind(getMainI18n())`. Match Phase D's pattern.

- [ ] **Step 7: Add a unit test**

Search for existing test:

```bash
ls apps/desktop/src/main/lib/reminders.test.ts apps/desktop/src/main/lib/reminders.test.mjs 2>/dev/null
```

If absent, create `apps/desktop/src/main/lib/reminders.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { createMainI18n } from '@memry/i18n/main'

describe('reminder notification labels (i18n)', () => {
  it('English: note reminder body label', async () => {
    const i18n = await createMainI18n({ locale: 'en' })
    expect(i18n.t('system:notification.reminder.note')).toBe('Note reminder')
    expect(i18n.t('system:notification.reminder.journal')).toBe('Journal reminder')
    expect(i18n.t('system:notification.reminder.highlight')).toBe('Highlight reminder')
    expect(i18n.t('system:notification.reminder.fallback')).toBe('Reminder due')
    expect(i18n.t('system:notification.reminder.default')).toBe('Reminder')
  })

  it('English: reminder validation error', async () => {
    const i18n = await createMainI18n({ locale: 'en' })
    expect(i18n.t('system:error.reminderTimeMustBeFuture'))
      .toBe('Reminder time must be in the future')
  })

  it('Turkish: falls back to English (tr/system.json is empty)', async () => {
    const i18n = await createMainI18n({ locale: 'tr' })
    expect(i18n.t('system:notification.reminder.note')).toBe('Note reminder')
  })
})
```

- [ ] **Step 8: Run the test**

```bash
pnpm --filter @memry/desktop test reminders
```

Expected: all assertions pass. The Turkish-fallback assertion verifies the i18next fallback chain works for the new namespace.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/main/lib/reminders.ts apps/desktop/src/main/lib/reminders.test.ts
git commit -m "feat(i18n): localize reminder notification labels and validation"
```

---

## Task 3: Migrate Vault Folder Picker Dialog (`apps/desktop/src/main/vault/index.ts`)

**Files:**
- Modify: `apps/desktop/src/main/vault/index.ts`

- [ ] **Step 1: Locate the picker call**

```bash
grep -n "showFolderPicker\|Select Vault" apps/desktop/src/main/vault/index.ts
```

Expected: function `showFolderPicker` near line 76, with `title: 'Select Vault Folder'` and `buttonLabel: 'Select Vault'`.

- [ ] **Step 2: Add the import**

`vault/index.ts` is at `apps/desktop/src/main/vault/index.ts`; the accessor is at `apps/desktop/src/main/lib/main-i18n.ts`:

```ts
import { getMainI18n } from '../lib/main-i18n'
```

- [ ] **Step 3: Replace the literals**

```ts
async function showFolderPicker(): Promise<string | null> {
  const t = getMainI18n().t
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: t('system:dialog.vault.title'),
    buttonLabel: t('system:dialog.vault.button')
  })
  // …existing return logic…
}
```

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm --filter @memry/desktop typecheck
git add apps/desktop/src/main/vault/index.ts
git commit -m "feat(i18n): localize vault folder picker dialog"
```

---

## Task 4: Migrate Notes Export and Import Dialogs (`apps/desktop/src/main/ipc/notes-handlers.ts`)

**Files:**
- Modify: `apps/desktop/src/main/ipc/notes-handlers.ts`

This file holds three export-related dialog uses (PDF save dialog, HTML save dialog, file-import filter labels) plus three IPC error returns ("Note not found" ×2, "Definition not found" ×1).

- [ ] **Step 1: Add the import once at the top**

`notes-handlers.ts` is at `apps/desktop/src/main/ipc/notes-handlers.ts`; accessor at `apps/desktop/src/main/lib/main-i18n.ts`:

```ts
import { getMainI18n } from '../lib/main-i18n'
```

- [ ] **Step 2: Replace PDF save dialog (lines 691–697)**

Locate the `dialog.showSaveDialog` call inside the EXPORT_PDF handler:

```bash
grep -n "Export as PDF\|PDF Document" apps/desktop/src/main/ipc/notes-handlers.ts
```

Replace:

```ts
const t = getMainI18n().t
const result = await dialog.showSaveDialog({
  title: t('system:dialog.exportPdf.title'),
  defaultPath: defaultFilename,
  filters: [{ name: t('system:dialog.exportPdf.filterName'), extensions: ['pdf'] }]
})

if (result.canceled || !result.filePath) {
  return { success: false as const, error: t('system:dialog.exportCancelled') }
}
```

- [ ] **Step 3: Replace HTML save dialog (lines 765–771)**

Same pattern in the EXPORT_HTML handler:

```ts
const t = getMainI18n().t
const result = await dialog.showSaveDialog({
  title: t('system:dialog.exportHtml.title'),
  defaultPath: defaultFilename,
  filters: [{ name: t('system:dialog.exportHtml.filterName'), extensions: ['html', 'htm'] }]
})

if (result.canceled || !result.filePath) {
  return { success: false as const, error: t('system:dialog.exportCancelled') }
}
```

- [ ] **Step 4: Replace import file-filter labels (line ~901)**

Locate the SHOW_IMPORT_DIALOG handler:

```bash
grep -n "Supported Files\|All Files" apps/desktop/src/main/ipc/notes-handlers.ts
```

Replace:

```ts
const t = getMainI18n().t
const result = await dialog.showOpenDialog({
  properties: ['openFile', 'multiSelections'],
  filters: [
    { name: t('system:dialog.import.filterSupported'), extensions },
    { name: t('system:dialog.import.filterAll'), extensions: ['*'] }
  ]
})
```

- [ ] **Step 5: Replace IPC error returns**

Three locations:

```bash
grep -n "Note not found\|Definition not found" apps/desktop/src/main/ipc/notes-handlers.ts
```

For each `return { success: false as const, error: 'Note not found' }`:

```ts
return { success: false as const, error: getMainI18n().t('system:error.noteNotFound') }
```

For `error: 'Definition not found'`:

```ts
return { success: false as const, error: getMainI18n().t('system:error.definitionNotFound') }
```

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @memry/desktop typecheck
```

Expected: passes.

- [ ] **Step 7: Add an integration test**

If `apps/desktop/src/main/ipc/notes-handlers.test.ts` exists, append. Otherwise create:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { createMainI18n } from '@memry/i18n/main'

describe('notes-handlers system strings (i18n)', () => {
  it('export dialog titles resolve in English', async () => {
    const i18n = await createMainI18n({ locale: 'en' })
    expect(i18n.t('system:dialog.exportPdf.title')).toBe('Export as PDF')
    expect(i18n.t('system:dialog.exportHtml.title')).toBe('Export as HTML')
    expect(i18n.t('system:dialog.exportCancelled')).toBe('Export cancelled')
  })

  it('import file filter labels resolve in English', async () => {
    const i18n = await createMainI18n({ locale: 'en' })
    expect(i18n.t('system:dialog.import.filterSupported')).toBe('Supported Files')
    expect(i18n.t('system:dialog.import.filterAll')).toBe('All Files')
  })

  it('IPC error strings resolve in English', async () => {
    const i18n = await createMainI18n({ locale: 'en' })
    expect(i18n.t('system:error.noteNotFound')).toBe('Note not found')
    expect(i18n.t('system:error.definitionNotFound')).toBe('Definition not found')
  })
})
```

- [ ] **Step 8: Run the test**

```bash
pnpm --filter @memry/desktop test notes-handlers
```

Expected: passes.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/main/ipc/notes-handlers.ts apps/desktop/src/main/ipc/notes-handlers.test.ts
git commit -m "feat(i18n): localize note export/import dialogs and IPC errors"
```

---

## Task 5: Migrate Updater Fallback (`apps/desktop/src/main/updater.ts`)

**Files:**
- Modify: `apps/desktop/src/main/updater.ts`

- [ ] **Step 1: Locate the fallback at line ~96**

```bash
grep -n "Update failed" apps/desktop/src/main/updater.ts
```

- [ ] **Step 2: Migrate**

`updater.ts` is at `apps/desktop/src/main/updater.ts`; accessor at `apps/desktop/src/main/lib/main-i18n.ts`:

```ts
import { getMainI18n } from './lib/main-i18n'
```

Replace the literal `'Update failed'` with `getMainI18n().t('system:error.updateFailed')`.

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @memry/desktop typecheck
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/updater.ts
git commit -m "feat(i18n): localize updater error fallback"
```

---

## Task 6: Verify Locale Change Propagates to Main-Process Strings

**Files:**
- Modify: `apps/desktop/src/main/ipc/locale-handler.ts` (verify, possibly no-op)

Phase A's locale-change choreography calls `mainI18n.changeLanguage(locale)` and then `rebuildAppMenu()`. The new system-namespace strings (notification labels, dialog titles, error strings) are rendered on-demand at the moment the surface opens, so they will pick up the new locale automatically *as long as* the `getMainI18n()` accessor returns the singleton whose language is mutated by `changeLanguage`.

- [ ] **Step 1: Read the locale-handler**

```bash
cat apps/desktop/src/main/ipc/locale-handler.ts
```

Verify it calls `mainI18n.changeLanguage(newLocale)` (or the singleton-mutating equivalent). If it does, no change needed for Phase H — system strings inherit automatically.

If the handler creates a *fresh* main i18n instance per change (rather than mutating the singleton), system-namespace consumers will hold a stale reference. In that case, either:

1. Add `getMainI18n()` as a getter that always returns the latest instance, OR
2. Call sites must look up the instance per call (`getMainI18n().t(...)`) — which is what Tasks 2–5 already do.

The pattern in Tasks 2–5 (`getMainI18n().t(...)` per call) is the safe one. Confirm it.

- [ ] **Step 2: Add an integration test**

Create `apps/desktop/src/main/ipc/locale-system.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { createMainI18n, type I18nInstance } from '@memry/i18n/main'

describe('main-process locale change propagates to system namespace', () => {
  let i18n: I18nInstance

  beforeAll(async () => {
    i18n = await createMainI18n({ locale: 'en' })
  })

  it('English: dialog title resolves', () => {
    expect(i18n.t('system:dialog.vault.title')).toBe('Select Vault Folder')
  })

  it('After changeLanguage(tr), key falls back to English (tr/system.json empty)', async () => {
    await i18n.changeLanguage('tr')
    // tr/system.json is `{}` — fallback chain returns English value.
    expect(i18n.t('system:dialog.vault.title')).toBe('Select Vault Folder')
  })

  it('After changeLanguage back to en, key resolves to English', async () => {
    await i18n.changeLanguage('en')
    expect(i18n.t('system:dialog.vault.title')).toBe('Select Vault Folder')
  })
})
```

- [ ] **Step 3: Run the test**

```bash
pnpm --filter @memry/desktop test locale-system
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/ipc/locale-system.test.ts
git commit -m "test(i18n): assert locale change reaches system namespace"
```

---

## Task 7: Extend E2E Spec with System-Namespace Scenarios

**Files:**
- Modify: `apps/desktop/tests/e2e/i18n.spec.ts`

Two new scenarios:

1. Vault picker: trigger via "Open Vault" or first-run vault flow; assert the dialog title in English then in Türkçe (will fall back to English while `tr/system.json` is empty — assert visible *anything* until translations land).
2. Reminder notification: trigger a reminder, assert the notification body uses the English label.

Native dialogs are usually un-introspectable from Playwright. The realistic e2e assertion is to confirm the *call* was made with the right key — handled by the unit/integration tests in Tasks 2–6. So this E2E task is small.

- [ ] **Step 1: Append a system-namespace integration test**

Append to `apps/desktop/tests/e2e/i18n.spec.ts`:

```ts
test('main-process system namespace renders in English by default', async () => {
  const { app } = await launchApp()

  // Query the main process's i18n instance directly via the accessor
  // built in Task 1b. The path resolves inside the packaged main bundle.
  const reminderLabel = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getMainI18n } = require('./lib/main-i18n')
    return getMainI18n().t('system:notification.reminder.note')
  })

  expect(reminderLabel).toBe('Note reminder')

  await app.close()
})
```

The require path inside `app.evaluate` runs from the bundled main entry's CWD (`out/main/index.js`); confirm the packaged bundle exposes `lib/main-i18n.js` next to it. If the build collapses the lib into a single bundle, use this fallback approach: drop the require entirely and instead trigger a notification flow (e.g., create a 5-second-future reminder, wait, screenshot/inspect via Electron `notification` test hooks). The unit test in Task 2 is the canonical binding assertion; this e2e is sanity confirmation only.

- [ ] **Step 2: Build + run e2e**

```bash
pnpm --filter @memry/desktop build
pnpm --filter @memry/desktop test:e2e i18n
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/tests/e2e/i18n.spec.ts
git commit -m "test(i18n): assert system namespace resolves in main process"
```

---

## Task 8: Final Verification

**Files:** none modified

- [ ] **Step 1: Lint**

```bash
pnpm lint
```

Expected: passes.

- [ ] **Step 2: Typecheck full workspace**

```bash
pnpm typecheck
```

Expected: passes (modulo pre-existing test-file errors per memry's MEMORY.md).

- [ ] **Step 3: IPC contract check**

```bash
pnpm ipc:check
```

Expected: passes.

- [ ] **Step 4: i18n gates**

```bash
pnpm i18n:check
pnpm i18n:codemod:todo:check
```

Expected:
- `i18n:check`: passes; the new `system.json` keys are all referenced by the migrated code (no orphan warnings increase).
- `codemod:todo:check`: still 0.

- [ ] **Step 5: Unit + integration tests**

```bash
pnpm test
```

Expected: green. New tests:
- `apps/desktop/src/main/lib/reminders.test.ts`
- `apps/desktop/src/main/ipc/notes-handlers.test.ts` (if created in Task 4)
- `apps/desktop/src/main/ipc/locale-system.test.ts`

- [ ] **Step 6: E2E**

```bash
pnpm --filter @memry/desktop build
pnpm --filter @memry/desktop test:e2e
```

Expected: passes.

- [ ] **Step 7: Manual smoke test — flip every main-process surface in Türkçe**

```bash
pnpm dev
```

Switch to Türkçe via Settings, then:

- [ ] Open the vault picker (e.g., from the vault switcher, "Open vault…" action). Confirm the native folder-picker dialog opens — its title and confirm button are OS-rendered, so they fall back to English while `tr/system.json` is `{}`. Verify no crash.
- [ ] Open a note → File → Export as PDF (or via command palette). Confirm the save dialog opens. Title falls back to English.
- [ ] Same for Export as HTML.
- [ ] Trigger an Import action; confirm the file-filter labels appear (will be English fallback).
- [ ] Set a reminder for a note that fires in 5 seconds. When the desktop notification appears, confirm:
  - title prefix is `🔔 ` followed by the user's note title or fallback "Reminder" (English fallback).
  - body is "Note reminder" / "Journal reminder" / "Highlight reminder" depending on type.
- [ ] Attempt to set a reminder for a past time; confirm the surfaced error contains "Reminder time must be in the future" (English fallback).

Switch back to English, repeat — confirm everything is identical.

- [ ] **Step 8: Open the PR**

```bash
git push -u origin feature/i18n-phase-h
gh pr create --title "feat(i18n): Phase H — main-process string completion" --body "$(cat <<'EOF'
## Summary

Adds a new `system` namespace and migrates the remaining ~13 hardcoded English strings in the Electron main process:

- Reminder desktop notifications (`Note reminder` / `Journal reminder` / `Highlight reminder` / `Reminder due` / `Reminder` fallback).
- Reminder validation error (`Reminder time must be in the future`).
- Native dialog titles + buttons (`Select Vault Folder`, `Select Vault`, `Export as PDF`, `Export as HTML`, `PDF Document`, `HTML Document`, `Supported Files`, `All Files`, `Export cancelled`).
- IPC error responses (`Note not found` ×2, `Definition not found`).
- Updater fallback (`Update failed`).

`packages/i18n/src/locales/en/system.json` is populated; `tr/system.json` and `ar/system.json` ship as empty `{}` and rely on the i18next fallback chain (consistent with how other namespaces handle Phase B+ deferred translation content).

Native folder/save/open dialogs are OS-rendered and their text falls back to English until `tr` and `ar` are populated. That's expected per spec — system text refreshes after relaunch in some cases.

**Out of scope:** ESLint rule expansion (Phase I).

## Test plan

- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm ipc:check` passes
- [ ] `pnpm i18n:check` passes; no new orphans
- [ ] `pnpm test` passes (3 new test files)
- [ ] `pnpm test:e2e` passes
- [ ] Manual: walk through Task 8 step 7 checklist
EOF
)"
```

---

## Phase I Handoff

After Phase H merges, Phase I closes the door:

- `docs/superpowers/plans/2026-04-29-i18n-phase-i-eslint-hardening.md` — extends `i18n/no-jsx-text-literals` to also catch literal strings in JSX attributes (`placeholder`, `aria-label`, `title`, `tooltip`, `subtitle`, `label`), `toast.*` call arguments, `extractErrorMessage(err, '…')` second arguments, and conditional/template expressions inside JSX. Each gap that Phase G/H burned down becomes statically un-reintroducible.
